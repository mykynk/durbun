import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerToSdk } from '@durbun/protocol';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import type { Hub, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { hello, makeHub, makeSettings, waitFor } from './helpers';

let hub: Hub;
let sdk: SdkLayer;
let wss: WebSocketServer;
const sockets: WebSocket[] = [];

async function setup(timings = {}) {
  hub = makeHub();
  sdk = createSdkLayerWithTimings({ hub, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.1.0' }, timings);
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/sdk' });
  wss.on('connection', (ws, req) => sdk.attachWebSocket(ws, { transport: 'websocket', remote: req.socket.remoteAddress }));
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  return (wss.address() as AddressInfo).port;
}

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sdk`);
  sockets.push(ws);
  const received: ServerToSdk[] = [];
  ws.on('message', (data) => received.push(JSON.parse(String(data)) as ServerToSdk));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, received };
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await sdk?.close();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  hub?.dispose();
});

describe('SDK layer over WebSocket', () => {
  it('speaks the same protocol with JSON text frames', async () => {
    const port = await setup();
    const { ws, received } = await client(port);
    ws.send(JSON.stringify(hello({ sdk: { name: '@durbun/react-native', version: '0.1.0', platform: 'react-native' }, session: 'rn-1' })));
    const welcome = await waitFor(() => received.find((m) => m.type === 'welcome'));
    if (welcome.type !== 'welcome') throw new Error('unreachable');
    expect(hub.getApp(welcome.appId)).toMatchObject({ transport: 'websocket', sdk: { platform: 'react-native' } });

    ws.send(JSON.stringify({ type: 'log', ts: 1, level: 'error', tag: 'console', message: 'TypeError: undefined is not an object' }));
    ws.send('not json at all');
    ws.send(Buffer.from(JSON.stringify({ type: 'event', ts: 2, name: 'screen_view', props: { screen: 'Home' } })), { binary: true });
    ws.send(JSON.stringify({ type: 'net.request', id: 'x1', ts: 3, method: 'GET', url: 'https://api.pati.app/v1/pets', headers: [], source: 'fetch' }));
    await waitFor(() => hub.getNetwork().length === 1 && hub.getLogs().some((l) => l.kind === 'event'));
    expect(hub.getLogs().find((l) => l.tag === 'console')).toMatchObject({ level: 'error', appId: welcome.appId });

    const pending = sdk.sendCommand(welcome.appId, 'reload');
    const cmd = await waitFor(() => received.find((m) => m.type === 'command'));
    if (cmd.type !== 'command') throw new Error('unreachable');
    ws.send(JSON.stringify({ type: 'command.result', id: cmd.id, ok: true }));
    await expect(pending).resolves.toEqual({ ok: true });

    ws.close();
    await waitFor(() => hub.getApp(welcome.appId)?.connected === false);
    expect(sdk.connectionCount()).toBe(0);
  });

  it('closes sockets that never say hello', async () => {
    const port = await setup({ helloTimeoutMs: 100 });
    const { ws } = await client(port);
    const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
    expect(code).toBe(1008);
  });
});
