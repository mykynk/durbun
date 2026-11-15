/**
 * What the server says about an SDK session beyond its data: dropped messages (too large, unreadable,
 * unknown type), the SDK's protocol version, and the device clock measured from ping/pong.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from '@durbun/protocol';
import {
  CLOCK_SKEW_LINE_MS,
  ClockSkewEstimator,
  DROP_LINE_INTERVAL_MS,
  DropReporter,
  netTooLargeInput,
  protocolMismatch,
  readFrameHead,
} from '../../src/sdk/diagnostics';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import type { Hub, SdkLayer, SystemLogInput } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { freePort, hello, makeHub, makeSettings, NdjsonClient, sleep, waitFor } from '../hub/helpers';

let hub: Hub | undefined;
let sdk: SdkLayer | undefined;
let clients: NdjsonClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await sdk?.close();
  hub?.dispose();
  sdk = undefined;
  hub = undefined;
});

async function setup(timings = {}) {
  hub = makeHub();
  sdk = createSdkLayerWithTimings({ hub, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.3.0' }, timings);
  const port = await freePort();
  await sdk.listen(port, '127.0.0.1');
  const c = await NdjsonClient.connect(port);
  clients.push(c);
  return c;
}

const lines = (code: string) => hub!.getLogs().filter((l) => l.code === code);

describe('reading the start of an oversized frame', () => {
  it('finds type, id, ts, method, url and status; tolerates garbage and a cut-off head', () => {
    const head = JSON.stringify({ type: 'net.request', id: 'r7', ts: 1700000000123.5, method: 'post', url: 'https://api.pati.app/v1/upload?x="1"', headers: [] }) + '"body":{"data":"AAAA';
    expect(readFrameHead(head)).toEqual({ type: 'net.request', id: 'r7', ts: 1700000000123.5, method: 'post', url: 'https://api.pati.app/v1/upload?x="1"' });
    expect(readFrameHead('{"type":"net.response","id":42,"ts":5,"status":200,"headers":[["a","b')).toMatchObject({ type: 'net.response', id: '42', status: 200 });
    expect(readFrameHead(Buffer.from('\u0000ÿ not json at all'))).toEqual({});
    expect(readFrameHead(undefined)).toEqual({});
  });

  it('maps only network messages with an id to a request update', () => {
    expect(netTooLargeInput({ type: 'net.response', id: 'r1', status: 200 }, 20_000_000)).toEqual({ id: 'r1', part: 'response', bytes: 20_000_000, limit: MAX_FRAME_BYTES, status: 200 });
    expect(netTooLargeInput({ type: 'net.error', id: 'r1' }, 1)).toMatchObject({ part: 'response' });
    expect(netTooLargeInput({ type: 'net.request', id: 'r2', method: 'GET', url: 'https://x' }, 1)).toMatchObject({ part: 'request', method: 'GET', url: 'https://x' });
    expect(netTooLargeInput({ type: 'log', id: 'r3' }, 1)).toBeUndefined();
    expect(netTooLargeInput({ type: 'net.response' }, 1)).toBeUndefined();
  });
});

describe('drop lines are rate-limited per session and reason', () => {
  it('writes the first drop at once, counts the rest into the next line after the window', () => {
    let now = 1_000;
    const out: SystemLogInput[] = [];
    const r = new DropReporter((l) => out.push(l), () => now);
    const app = { id: 'app:1', app: { id: 'com.mykynk.pati', name: 'Pati' } };
    r.drop('invalid', app, { type: 'log' });
    r.drop('invalid', app, { type: 'log' });
    r.drop('unknownType', app, { type: 'trace.span' });
    r.drop('invalid', app, { type: 'log' });
    expect(out.map((l) => [l.code, l.params?.count])).toEqual([
      ['app.messageInvalid', 1],
      ['app.messageUnknown', 1],
    ]);
    now += DROP_LINE_INTERVAL_MS;
    r.drop('invalid', app, { type: 'net.request' });
    expect(out[2]).toMatchObject({ code: 'app.messageInvalid', appId: 'app:1', params: { app: 'Pati', type: 'net.request', count: 3 } });
    expect(out[2]!.message).toContain('3 messages since the last note');
  });
});

describe('protocol version', () => {
  it('classifies newer, older, compatible and unknown', () => {
    expect(protocolMismatch(PROTOCOL_VERSION + 1)).toBe('sdk-newer');
    expect(protocolMismatch(0)).toBe('sdk-older');
    expect(protocolMismatch(PROTOCOL_VERSION)).toBeUndefined();
    expect(protocolMismatch(undefined)).toBeUndefined();
  });

  it('records the announced protocol; a newer SDK gets one line that says to update Dürbün', async () => {
    const c = await setup();
    c.send(hello({ protocol: PROTOCOL_VERSION + 1, sdk: { name: 'durbun_flutter', version: '0.9.0', platform: 'flutter' } }));
    const { appId } = await c.next('welcome');
    await waitFor(() => lines('app.sdkNewer').length);
    expect(hub!.getApp(appId)).toMatchObject({ sdkProtocol: PROTOCOL_VERSION + 1, protocolMismatch: 'sdk-newer', sdk: { name: 'durbun_flutter', version: '0.9.0' } });
    expect(lines('app.sdkNewer')[0]).toMatchObject({ appId, level: 'warn' });
    expect(lines('app.sdkNewer')[0]!.message).toContain('Update Dürbün');

    // The same launch reconnects (Wi-Fi drop): no second line.
    const port = c.socket.remotePort!;
    c.close();
    await waitFor(() => hub!.getApp(appId)?.connected === false);
    const again = await NdjsonClient.connect(port);
    clients.push(again);
    again.send(hello({ protocol: PROTOCOL_VERSION + 1 }));
    await again.next('welcome');
    await sleep(30);
    expect(lines('app.sdkNewer')).toHaveLength(1);
  });

  it('an older SDK is told to update the SDK; a hello without protocol stays unknown and quiet', async () => {
    const c = await setup();
    c.send(hello({ protocol: 0 }));
    const { appId } = await c.next('welcome');
    await waitFor(() => lines('app.sdkOlder').length);
    expect(hub!.getApp(appId)).toMatchObject({ sdkProtocol: 0, protocolMismatch: 'sdk-older' });
    expect(lines('app.sdkOlder')[0]!.message).toContain('Update the Dürbün SDK');

    const port = c.socket.remotePort!;
    const d = await NdjsonClient.connect(port);
    clients.push(d);
    const { protocol: _p, ...noProtocol } = hello({ session: 'launch-2', app: { name: 'Mahalle', id: 'com.mykynk.mahalle' } });
    d.send(noProtocol);
    const w = await d.next('welcome');
    await sleep(30);
    const app = hub!.getApp(w.appId)!;
    expect(app.sdkProtocol).toBeUndefined();
    expect(app.protocolMismatch).toBeUndefined();
    expect(lines('app.sdkNewer')).toHaveLength(0);
  });
});

describe('dropped messages become visible', () => {
  it('an oversized response ends its request as failed with tooLarge and writes one line', async () => {
    const c = await setup();
    c.send(hello());
    const { appId } = await c.next('welcome');
    c.send({ type: 'net.request', id: 'big', ts: Date.now(), method: 'GET', url: 'https://cdn.pati.app/video.mp4', headers: [], source: 'dart:io' });
    const data = 'A'.repeat(MAX_FRAME_BYTES + 10);
    c.send({ type: 'net.response', id: 'big', ts: Date.now(), status: 200, headers: [], body: { encoding: 'utf8', data, size: data.length } });
    const entry = await waitFor(() => {
      const e = hub!.getNetwork().find((n) => n.id === `${appId}:big`);
      return e?.state === 'failed' ? e : undefined;
    }, 10_000);
    expect(entry).toMatchObject({ state: 'failed', status: 200, tooLarge: { part: 'response', limit: MAX_FRAME_BYTES } });
    expect(entry.tooLarge!.bytes).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(entry.error).toContain('could not receive this response');
    const line = await waitFor(() => lines('app.messageTooLarge')[0]);
    expect(line).toMatchObject({ appId, level: 'warn', params: { type: 'net.response', limit: MAX_FRAME_BYTES, count: 1 } });

    // The connection keeps working after the drop.
    c.send({ type: 'log', ts: Date.now(), level: 'info', message: 'still here' });
    await waitFor(() => hub!.getLogs().find((l) => l.message === 'still here'));
  }, 20_000);

  it('an oversized request keeps its method and URL; the later response still completes it', async () => {
    const c = await setup();
    c.send(hello());
    const { appId } = await c.next('welcome');
    const data = 'B'.repeat(MAX_FRAME_BYTES + 10);
    c.send({ type: 'net.request', id: 'up', ts: Date.now(), method: 'POST', url: 'https://api.pati.app/v1/upload', headers: [], source: 'dio', body: { encoding: 'utf8', data, size: data.length } });
    const entry = await waitFor(() => hub!.getNetwork().find((n) => n.id === `${appId}:up`), 10_000);
    expect(entry).toMatchObject({ method: 'POST', url: 'https://api.pati.app/v1/upload', state: 'pending', tooLarge: { part: 'request' } });
    c.send({ type: 'net.response', id: 'up', ts: Date.now(), status: 201, headers: [] });
    await waitFor(() => hub!.getNetwork().find((n) => n.id === `${appId}:up` && n.state === 'complete'));
    expect(hub!.getNetwork().find((n) => n.id === `${appId}:up`)).toMatchObject({ status: 201, tooLarge: { part: 'request' } });
  }, 20_000);

  it('invalid and unknown messages write a line each; bad input never throws or closes', async () => {
    const c = await setup();
    c.send(hello());
    const { appId } = await c.next('welcome');
    c.send({ type: 'net.request', url: 'https://no-id' }); // invalid: no id
    c.send({ type: 'net.request', url: 'https://no-id-2' }); // counted, not repeated
    c.send({ type: 'trace.span', name: 'checkout' }); // unknown type (newer SDK)
    c.send([1, 2, 3]);
    c.send({ type: 42 });
    c.send({ type: 'log', ts: Date.now(), level: 'info', message: 'after the noise' });
    await waitFor(() => hub!.getLogs().find((l) => l.message === 'after the noise'));
    expect(lines('app.messageInvalid')).toHaveLength(1);
    expect(lines('app.messageInvalid')[0]).toMatchObject({ appId, params: { type: 'net.request', count: 1 } });
    expect(lines('app.messageUnknown')).toHaveLength(1);
    expect(lines('app.messageUnknown')[0]).toMatchObject({ params: { type: 'trace.span' } });
    expect(c.closed).toBe(false);
  });
});

describe('device clock', () => {
  it('estimates from ping/pong with the shortest round trip; reports once, after two agreeing samples', () => {
    const e = new ClockSkewEstimator();
    e.pingSent(10_000);
    expect(e.pong(10_050 - 60_000, 10_100)).toEqual({ offsetMs: 60_000, accuracyMs: 50 });
    expect(e.shouldReport()).toBe(false); // one sample is not enough
    e.pingSent(20_000);
    expect(e.pong(20_010 - 60_000, 20_020)).toBeUndefined(); // within the publish step of the last estimate
    expect(e.estimate).toEqual({ offsetMs: 60_000, accuracyMs: 10 });
    expect(e.shouldReport()).toBe(true);
    expect(e.shouldReport()).toBe(false);
    // A pong without a ping, or with a long round trip, says nothing.
    expect(e.pong(1, 30_000)).toBeUndefined();
    e.pingSent(40_000);
    expect(e.pong(40_000, 45_000)).toBeUndefined();
  });

  it('stays quiet below the threshold and for a single late pong', () => {
    const e = new ClockSkewEstimator();
    e.pingSent(0);
    e.pong(-(CLOCK_SKEW_LINE_MS - 1_000), 20);
    e.pingSent(100);
    e.pong(100 - (CLOCK_SKEW_LINE_MS - 1_000), 120);
    expect(e.shouldReport()).toBe(false);
    const f = new ClockSkewEstimator();
    f.pingSent(0);
    f.pong(-30_000, 20); // one far-off sample
    f.pingSent(100);
    f.pong(105, 110); // then a normal one
    expect(f.shouldReport()).toBe(false);
  });

  it('a session whose device clock is a minute behind gets clockOffsetMs and one line', async () => {
    const c = await setup({ pingIntervalMs: 100 });
    c.socket.on('data', () => {
      for (const m of c.received.splice(0)) {
        if (m.type === 'ping') c.send({ type: 'pong', ts: Date.now() - 60_000 });
        else if (m.type === 'welcome') c.received.push(m);
      }
    });
    c.send(hello());
    const { appId } = await c.next('welcome');
    const line = await waitFor(() => lines('app.clockBehind')[0], 3_000);
    const app = hub!.getApp(appId)!;
    expect(app.clockOffsetMs).toBeGreaterThan(59_000);
    expect(app.clockOffsetMs).toBeLessThan(61_000);
    expect(app.clockOffsetAccuracyMs).toBeGreaterThanOrEqual(1);
    expect(line).toMatchObject({ appId, level: 'warn', params: { seconds: 60, device: 'Pixel 8' } });
    await sleep(350);
    expect(lines('app.clockBehind')).toHaveLength(1);
    expect(lines('app.clockAhead')).toHaveLength(0);
    // Log times are never rewritten.
    const ts = Date.now() - 60_000;
    c.send({ type: 'log', ts, level: 'info', message: 'device time' });
    expect((await waitFor(() => hub!.getLogs().find((l) => l.message === 'device time'))).ts).toBe(ts);
  });
});
