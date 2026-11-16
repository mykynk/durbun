/**
 * WebSocket messages and SSE events of stream entries: the wire messages, the per-entry store and its limits,
 * the SDK config that turns them on, and what HTTP, export / import and HAR do with them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, STREAM_HEAD_KEPT, type NetworkEntry, type SdkToServer, type ServerToSdk, type SessionExport, type StreamMessagesPage } from '@durbun/protocol';
import type { Hub, HubChange, SdkLayer } from '../../src/types';
import { createHub } from '../../src/hub';
import { MAX_STREAM_MESSAGES, STREAM_MESSAGE_CAP, StreamStore } from '../../src/hub/streams';
import { NetworkStore, STREAM_APP_GONE } from '../../src/hub/network';
import { parseSdkMessage } from '../../src/sdk/validate';
import { KNOWN_SDK_TYPES } from '../../src/sdk/diagnostics';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import { silentLogger } from '../../src/util/logger';
import { startTestApp, type TestApp } from '../http/fakes';
import { appInput, device, hello, makeHub, makeSettings, sleep, waitFor } from './helpers';

const PIXEL = 'android:R5CT1234';
let hub: Hub | undefined;
let sdk: SdkLayer | undefined;
let t: TestApp | undefined;
afterEach(async () => {
  await sdk?.close();
  await t?.close();
  hub?.dispose();
  hub = sdk = t = undefined;
});

function setup(h: Hub) {
  h.upsertDevice(device(PIXEL));
  const app = h.registerApp(appInput(PIXEL, { app: { id: 'com.example.chat', name: 'Chat', pid: 4001 }, capabilities: ['logs', 'network', 'streams'] }));
  return app.id;
}

function openSocket(h: Hub, appId: string, id = 'ws1', ts = 1_000): string {
  h.netRequest(appId, { type: 'net.request', id, ts, method: 'GET', url: 'wss://chat.example.com/socket', headers: [['Upgrade', 'websocket']], source: 'okhttp' });
  h.netResponse(appId, { type: 'net.response', id, ts: ts + 50, status: 101, statusText: 'Switching Protocols', headers: [['Upgrade', 'websocket']] });
  return `${appId}:${id}`;
}

const text = (data: string) => ({ encoding: 'utf8' as const, data, size: Buffer.byteLength(data) });
const entry = (h: Hub, id: string): NetworkEntry => h.getNetwork().find((e) => e.id === id)!;

describe('stream messages on the wire', () => {
  it('parses net.ws / net.sse, keeps the streams capability, rejects an unknown opcode', () => {
    expect(parseSdkMessage({ type: 'net.ws', id: 'a', ts: 5, dir: 'out', opcode: 'text', size: 12, body: text('{"type":"hi"}') })).toMatchObject({
      type: 'net.ws',
      dir: 'out',
      opcode: 'text',
      size: 12,
      body: { encoding: 'utf8' },
    });
    expect(parseSdkMessage({ type: 'net.ws', id: 'a', ts: 5, dir: 'in', opcode: 'continuation' })).toBeUndefined();
    expect(parseSdkMessage({ type: 'net.ws', id: 'a', ts: 5, opcode: 'close', closeCode: 1000.0, closeReason: 'bye' })).toMatchObject({ dir: 'in', size: 0, closeCode: 1000, closeReason: 'bye' });
    expect(parseSdkMessage({ type: 'net.sse', id: 'b', ts: 5, event: 'queue', eventId: '7', retry: 3000, body: text('{"p":1}') })).toMatchObject({ event: 'queue', eventId: '7', retry: 3000, size: 7 });
    expect(parseSdkMessage({ type: 'net.sse', id: 'b', ts: 5, end: true, event: 'ignored' })).toEqual({ type: 'net.sse', id: 'b', ts: 5, end: true });
    expect(KNOWN_SDK_TYPES.has('net.ws') && KNOWN_SDK_TYPES.has('net.sse')).toBe(true);
    const h = parseSdkMessage(hello({ capabilities: ['logs', 'network', 'streams'] }) as unknown) as Extract<SdkToServer, { type: 'hello' }>;
    expect(h.capabilities).toContain('streams');
  });

  it('the welcome asks for stream messages, with a payload cap that follows body capture', async () => {
    hub = makeHub();
    let settings = makeSettings();
    sdk = createSdkLayerWithTimings({ hub, logger: silentLogger, settings: () => settings, mocks: () => [], serverVersion: '0.1.0' }, { helloTimeoutMs: 50, idleTimeoutMs: 1_000, pingIntervalMs: 1_000 });
    hub.upsertDevice(device('demo:1', { kind: 'virtual' }));
    const session = sdk.openVirtual({ transport: 'demo', deviceId: 'demo:1' });
    const received: ServerToSdk[] = [];
    session.onMessage((m) => received.push(m));
    session.send(hello());
    await session.appId;
    const welcome = await waitFor(() => received.find((m) => m.type === 'welcome'));
    expect(welcome.type === 'welcome' && welcome.config).toMatchObject({ captureStreams: true, maxStreamMessageBytes: Math.min(DEFAULT_SETTINGS.maxBodyBytes, STREAM_MESSAGE_CAP) });
    settings = makeSettings({ captureBodies: false, captureStreams: false });
    sdk.setConfig({ captureBodies: false, captureStreams: false });
    const config = await waitFor(() => received.find((m) => m.type === 'config'));
    expect(config.type === 'config' && config.config).toMatchObject({ captureStreams: false, maxStreamMessageBytes: 0 });
  });

  it('an SDK that was not asked for stream messages: its 101 stays a plain response; asked again, the next one opens a stream', async () => {
    hub = makeHub();
    const settings = makeSettings({ captureStreams: false });
    sdk = createSdkLayerWithTimings({ hub, logger: silentLogger, settings: () => settings, mocks: () => [], serverVersion: '0.1.0' }, { helloTimeoutMs: 50, idleTimeoutMs: 1_000, pingIntervalMs: 1_000 });
    hub.upsertDevice(device('demo:1', { kind: 'virtual' }));
    const session = sdk.openVirtual({ transport: 'demo', deviceId: 'demo:1' });
    const received: ServerToSdk[] = [];
    session.onMessage((m) => received.push(m));
    session.send(hello({ capabilities: ['logs', 'network', 'streams'] }));
    const appId = await session.appId;
    const upgrade = (id: string, ts: number) => {
      session.send({ type: 'net.request', id, ts, method: 'GET', url: 'wss://chat.example.com/socket', headers: [['Upgrade', 'websocket']], source: 'dart:io' });
      session.send({ type: 'net.response', id, ts: ts + 5, status: 101, statusText: 'Switching Protocols', headers: [['Upgrade', 'websocket']] });
    };
    upgrade('w1', 10);
    session.send({ type: 'net.request', id: 's1', ts: 20, method: 'GET', url: 'https://api.example.com/events', headers: [], source: 'dart:io' });
    session.send({ type: 'net.response', id: 's1', ts: 25, status: 200, headers: [['Content-Type', 'text/event-stream']] });
    const plain = await waitFor(() => (entry(hub!, `${appId}:s1`)?.state === 'complete' ? entry(hub!, `${appId}:s1`) : undefined));
    expect(plain.stream).toBeUndefined();
    expect(entry(hub, `${appId}:w1`)).toMatchObject({ state: 'complete', status: 101 });
    expect(entry(hub, `${appId}:w1`).stream).toBeUndefined();

    sdk.setConfig({ captureStreams: true });
    await waitFor(() => received.find((m) => m.type === 'config'));
    upgrade('w2', 30);
    const open = await waitFor(() => (entry(hub!, `${appId}:w2`)?.stream ? entry(hub!, `${appId}:w2`) : undefined));
    expect(open.stream).toMatchObject({ kind: 'websocket', state: 'open', openTs: 35 });
    // The socket that opened before the setting: its first message still makes it a stream.
    session.send({ type: 'net.ws', id: 'w1', ts: 40, dir: 'in', opcode: 'text', size: 2, body: text('hi') });
    const late = await waitFor(() => (entry(hub!, `${appId}:w1`)?.stream ? entry(hub!, `${appId}:w1`) : undefined));
    expect(late.stream).toMatchObject({ kind: 'websocket', state: 'open', count: 1, in: 1 });
  });
});

describe('stream entries in the hub', () => {
  it('numbers WebSocket messages, counts directions, control frames and bytes; the first close frame closes it', () => {
    hub = makeHub();
    const appId = setup(hub);
    const id = openSocket(hub, appId);
    expect(entry(hub, id)).toMatchObject({ state: 'complete', status: 101, stream: { kind: 'websocket', state: 'open', openTs: 1_050, count: 0, lastSeq: 0 } });
    const ws = (m: Partial<Extract<SdkToServer, { type: 'net.ws' }>>) => hub!.netStream!(appId, { type: 'net.ws', id: 'ws1', ts: 2_000, dir: 'in', opcode: 'text', size: 0, ...m });
    ws({ dir: 'out', size: 15, body: text('{"type":"auth"}') });
    ws({ size: 18, body: text('{"type":"auth.ok"}') });
    ws({ dir: 'out', opcode: 'ping', size: 0 });
    ws({ opcode: 'pong', size: 0 });
    ws({ opcode: 'binary', size: 4, body: { encoding: 'base64', data: 'AQIDBA==', size: 4 } });
    ws({ opcode: 'close', closeCode: 1001, closeReason: 'Server restarting', ts: 3_000 });
    ws({ dir: 'out', opcode: 'close', closeCode: 1001, ts: 3_010 });
    const stream = entry(hub, id).stream!;
    expect(stream).toMatchObject({ state: 'closed', closedBy: 'in', closeCode: 1001, closeReason: 'Server restarting', closedTs: 3_000, count: 7, in: 4, out: 3, control: 2, bytesIn: 22, bytesOut: 15, lastSeq: 7, dropped: 0 });
    const page = hub.getStreamMessages!(id)!;
    expect(page.messages.map((m) => [m.seq, m.dir, m.type])).toEqual([
      [1, 'out', 'text'],
      [2, 'in', 'text'],
      [3, 'out', 'ping'],
      [4, 'in', 'pong'],
      [5, 'in', 'binary'],
      [6, 'in', 'close'],
      [7, 'out', 'close'],
    ]);
    expect(hub.getStreamMessages!(id, { after: 5, limit: 1 })).toMatchObject({ messages: [{ seq: 6 }], more: true });
    // A message for an unknown connection is ignored.
    hub.netStream!(appId, { type: 'net.ws', id: 'nope', ts: 1, dir: 'in', opcode: 'text', size: 1 });
    expect(hub.getStreamMessages!(`${appId}:nope`)).toBeUndefined();
  });

  it('SSE: headers without a body open the stream; events, end; an SDK that sends the whole body is a plain response', () => {
    hub = makeHub();
    const appId = setup(hub);
    hub.netRequest(appId, { type: 'net.request', id: 's1', ts: 1, method: 'GET', url: 'https://api.example.com/events', headers: [], source: 'okhttp' });
    hub.netResponse(appId, { type: 'net.response', id: 's1', ts: 2, status: 200, headers: [['Content-Type', 'text/event-stream; charset=utf-8']] });
    const id = `${appId}:s1`;
    expect(entry(hub, id).stream).toMatchObject({ kind: 'sse', state: 'open', openTs: 2 });
    hub.netStream!(appId, { type: 'net.sse', id: 's1', ts: 3, event: 'queue', eventId: '1', retry: 5000, size: 13, body: text('{"position":5}') });
    hub.netStream!(appId, { type: 'net.sse', id: 's1', ts: 4, body: text('hello') });
    hub.netStream!(appId, { type: 'net.sse', id: 's1', ts: 5, end: true });
    expect(entry(hub, id).stream).toMatchObject({ state: 'closed', closedTs: 5, count: 2, in: 2, out: 0, bytesIn: 18 });
    expect(hub.getStreamMessages!(id)!.messages).toMatchObject([
      { seq: 1, type: 'event', dir: 'in', event: 'queue', eventId: '1', retry: 5000 },
      { seq: 2, type: 'event', size: 5 },
    ]);

    hub.netRequest(appId, { type: 'net.request', id: 'old', ts: 1, method: 'GET', url: 'https://api.example.com/events', headers: [], source: 'okhttp' });
    hub.netResponse(appId, { type: 'net.response', id: 'old', ts: 9, status: 200, headers: [['Content-Type', 'text/event-stream']], body: text('data: x\n\n') });
    expect(entry(hub, `${appId}:old`).stream).toBeUndefined();
  });

  it('an app whose SDK has no streams capability: a 101 and SSE headers stay plain responses and do not hang open', () => {
    hub = makeHub();
    hub.upsertDevice(device(PIXEL));
    const appId = hub.registerApp(appInput(PIXEL, { capabilities: ['logs', 'network'] })).id;
    const id = openSocket(hub, appId);
    hub.netRequest(appId, { type: 'net.request', id: 's1', ts: 1, method: 'GET', url: 'https://api.example.com/events', headers: [], source: 'okhttp' });
    hub.netResponse(appId, { type: 'net.response', id: 's1', ts: 2, status: 200, headers: [['Content-Type', 'text/event-stream']] });
    expect(entry(hub, id)).toMatchObject({ state: 'complete', status: 101 });
    expect(entry(hub, id).stream).toBeUndefined();
    expect(entry(hub, `${appId}:s1`).stream).toBeUndefined();
    hub.markAppDisconnected(appId);
    expect(entry(hub, id)).toMatchObject({ state: 'complete', status: 101 });
    expect(entry(hub, id).stream).toBeUndefined();
  });

  it('noStream: a handshake whose messages the SDK cannot see stays a plain response', () => {
    hub = makeHub();
    const appId = setup(hub);
    expect(parseSdkMessage({ type: 'net.response', id: 'w', ts: 2, status: 101, headers: [], noStream: true })).toMatchObject({ noStream: true });
    expect(parseSdkMessage({ type: 'net.response', id: 'w', ts: 2, status: 101, headers: [], noStream: 'yes' })).not.toHaveProperty('noStream');
    hub.netRequest(appId, { type: 'net.request', id: 'w', ts: 1, method: 'GET', url: 'wss://chat.example.com/socket', headers: [], source: 'okhttp' });
    hub.netResponse(appId, { type: 'net.response', id: 'w', ts: 2, status: 101, headers: [], noStream: true });
    expect(entry(hub, `${appId}:w`)).toMatchObject({ state: 'complete', status: 101 });
    expect(entry(hub, `${appId}:w`).stream).toBeUndefined();
  });

  it('a broken connection fails the stream and keeps the handshake complete; a gone app fails its open streams', () => {
    hub = makeHub();
    const appId = setup(hub);
    const a = openSocket(hub, appId, 'a');
    const b = openSocket(hub, appId, 'b');
    hub.netError(appId, { type: 'net.error', id: 'a', ts: 5_000, error: 'Software caused connection abort' });
    expect(entry(hub, a)).toMatchObject({ state: 'complete', status: 101, stream: { state: 'failed', error: 'Software caused connection abort', closedTs: 5_000 } });
    expect(entry(hub, a).error).toBeUndefined();
    hub.markAppDisconnected(appId);
    expect(entry(hub, b).stream).toMatchObject({ state: 'failed', error: STREAM_APP_GONE });
  });

  it('a scoped clear takes the messages with the entries; the entry limit passes over open streams', () => {
    hub = makeHub({ maxNetworkEntries: 100 });
    const appId = setup(hub);
    const id = openSocket(hub, appId);
    hub.netStream!(appId, { type: 'net.ws', id: 'ws1', ts: 2, dir: 'in', opcode: 'text', size: 2, body: text('hi') });
    for (let i = 0; i < 150; i++) hub.netRequest(appId, { type: 'net.request', id: `r${i}`, ts: 10 + i, method: 'GET', url: `https://api.example.com/${i}`, headers: [], source: 'okhttp' });
    expect(hub.getNetwork().some((e) => e.id === id)).toBe(true);
    expect(hub.getNetwork()).toHaveLength(100);
    hub.clear('network', { appId });
    expect(hub.getStreamMessages!(id)).toBeUndefined();
  });

  it('batches carry the entry (counts), not the messages', async () => {
    hub = makeHub();
    const appId = setup(hub);
    const id = openSocket(hub, appId);
    const changes: HubChange[] = [];
    const stop = hub.subscribe((c) => changes.push(c));
    for (let i = 0; i < 50; i++) hub.netStream!(appId, { type: 'net.ws', id: 'ws1', ts: 2 + i, dir: 'in', opcode: 'text', size: 2, body: text('hi') });
    await sleep(150);
    stop();
    const sent = changes.flatMap((c) => c.network ?? []).filter((e) => e.id === id);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(sent.at(-1)!.stream).toMatchObject({ count: 50, lastSeq: 50 });
    expect(JSON.stringify(changes)).not.toContain('"seq"');
  });
});

describe('stream limits', () => {
  it('per connection: keeps the first STREAM_HEAD_KEPT and the newest; the rest count as dropped', () => {
    const net = new NetworkStore({ maxEntries: 100, maxBodyBytes: 1e9 }, () => {});
    net.request('e', 'app', 'd', { type: 'net.request', id: 'e', ts: 1, method: 'GET', url: 'wss://x/ws', headers: [], source: 't' });
    net.response('e', 'app', 'd', { type: 'net.response', id: 'e', ts: 2, status: 101, headers: [] });
    const total = MAX_STREAM_MESSAGES + 500;
    for (let i = 0; i < total; i++) net.streamMessage('e', { type: 'net.ws', id: 'e', ts: 3 + i, dir: 'in', opcode: 'text', size: 1, body: text('x') });
    expect(net.get('e')!.stream).toMatchObject({ count: total, dropped: 500, lastSeq: total });
    const page = net.streamPage('e', 0, 5_000)!;
    expect(page.messages).toHaveLength(MAX_STREAM_MESSAGES);
    expect(page.messages[STREAM_HEAD_KEPT - 1]!.seq).toBe(STREAM_HEAD_KEPT);
    // The gap after the head: seq jumps over the dropped ones.
    expect(page.messages[STREAM_HEAD_KEPT]!.seq).toBe(STREAM_HEAD_KEPT + 501);
    expect(page.messages.at(-1)!.seq).toBe(total);
  });

  it('cuts a payload at STREAM_MESSAGE_CAP; the total budget takes from the least recently active connection first', () => {
    const net = new NetworkStore({ maxEntries: 100, maxBodyBytes: 1e9, maxStreamBytes: 400_000 }, () => {});
    for (const id of ['quiet', 'busy']) {
      net.request(id, 'app', 'd', { type: 'net.request', id, ts: 1, method: 'GET', url: 'wss://x/ws', headers: [], source: 't' });
      net.response(id, 'app', 'd', { type: 'net.response', id, ts: 2, status: 101, headers: [] });
    }
    const big = 'y'.repeat(STREAM_MESSAGE_CAP * 2);
    net.streamMessage('quiet', { type: 'net.ws', id: 'quiet', ts: 3, dir: 'in', opcode: 'text', size: big.length, body: text(big) });
    const kept = net.streamPage('quiet')!.messages[0]!;
    expect(kept.body).toMatchObject({ truncated: true, size: big.length });
    expect(kept.body!.data.length).toBe(STREAM_MESSAGE_CAP);
    // Past its first STREAM_HEAD_KEPT messages (kept longest), the quiet connection's later ones go first.
    for (let i = 0; i < 150; i++) net.streamMessage('quiet', { type: 'net.ws', id: 'quiet', ts: 4 + i, dir: 'in', opcode: 'text', size: 1_000, body: text('q'.repeat(1_000)) });
    for (let i = 0; i < 200; i++) net.streamMessage('busy', { type: 'net.ws', id: 'busy', ts: 10 + i, dir: 'in', opcode: 'text', size: 1_000, body: text('b'.repeat(1_000)) });
    expect(net.streamBytes).toBeLessThanOrEqual(400_000);
    expect(net.get('quiet')!.stream!.dropped).toBeGreaterThan(0);
    expect(net.get('busy')!.stream!.dropped).toBe(0);
  });

  it('StreamStore.forget is not a drop; page() of an unknown id is empty', () => {
    const drops: [string, number][] = [];
    const store = new StreamStore({ maxBytes: 1e6 }, (id, n) => drops.push([id, n]));
    store.add('a', { seq: 1, ts: 1, dir: 'in', type: 'text', size: 1 });
    store.forget('a');
    expect(store.bytes).toBe(0);
    expect(drops).toEqual([]);
    expect(store.page('a')).toEqual({ messages: [], more: false });
  });
});

describe('stream messages over HTTP, export, import and HAR', () => {
  it('pages through GET /api/network/:id/messages; HAR has _webSocketMessages (masked); export / import keeps them; search finds them', async () => {
    const real = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
    hub = real;
    t = await startTestApp({ hub: real });
    const appId = setup(real);
    const id = openSocket(real, appId);
    real.netStream!(appId, { type: 'net.ws', id: 'ws1', ts: 2_000, dir: 'out', opcode: 'text', size: 40, body: text('{"type":"auth","token":"s3cr3t-token-123"}') });
    for (let i = 0; i < 4; i++) real.netStream!(appId, { type: 'net.ws', id: 'ws1', ts: 2_100 + i, dir: 'in', opcode: 'text', size: 20, body: text(`{"msg":"merhaba ${i}"}`) });

    const page = (await (await fetch(`${t.base}/api/network/${encodeURIComponent(id)}/messages?after=1&limit=2`)).json()) as StreamMessagesPage;
    expect(page.messages.map((m) => m.seq)).toEqual([2, 3]);
    expect(page.more).toBe(true);
    expect(page.stream).toMatchObject({ kind: 'websocket', count: 5 });
    expect((await fetch(`${t.base}/api/network/nope/messages`)).status).toBe(404);
    expect((await fetch(`${t.base}/api/network/${encodeURIComponent(id)}/messages?after=-1`)).status).toBe(400);
    // The REST detail leaves the messages out.
    expect(((await (await fetch(`${t.base}/api/network/${encodeURIComponent(id)}`)).json()) as { streamMessages?: unknown }).streamMessages).toBeUndefined();

    const search = (await (await fetch(`${t.base}/api/network/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'merhaba 3' }) })).json()) as { ids: string[] };
    expect(search.ids).toEqual([id]);

    const har = (await (await fetch(`${t.base}/api/har`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) })).json()) as {
      log: { entries: { response: { status: number }; _webSocketMessages: { type: string; opcode: number; data: string; time: number }[] }[] };
    };
    const harEntry = har.log.entries[0]!;
    expect(harEntry.response.status).toBe(101);
    expect(harEntry._webSocketMessages).toHaveLength(5);
    expect(harEntry._webSocketMessages[0]).toMatchObject({ type: 'send', opcode: 1, time: 2 });
    expect(harEntry._webSocketMessages[0]!.data).not.toContain('s3cr3t');
    expect(harEntry._webSocketMessages[1]).toMatchObject({ type: 'receive', data: '{"msg":"merhaba 0"}' });

    const exported = (await (await fetch(`${t.base}/api/export`)).json()) as SessionExport;
    const detail = exported.network.find((n) => n.url.startsWith('wss://'))!;
    expect(detail.stream).toMatchObject({ state: 'open', count: 5 });
    expect(detail.streamMessages).toHaveLength(5);
    expect(JSON.stringify(detail.streamMessages)).not.toContain('s3cr3t');

    const res = await fetch(`${t.base}/api/import?name=chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported) });
    expect(res.status).toBe(200);
    const imported = real.getNetwork().find((e) => e.url.startsWith('wss://') && e.id !== id)!;
    // A recording is history: the open stream comes in closed, with its messages.
    expect(imported.stream).toMatchObject({ state: 'closed', count: 5, lastSeq: 5 });
    expect(real.getStreamMessages!(imported.id)!.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});
