/**
 * Traffic shapes the real SDKs produce (seen end-to-end against the real server) that the hub must keep
 * exactly: Flutter's broken body stream (net.response with a partial body, then net.error), size-only
 * placeholder bodies (capture off / too large), and iOS crashes of the previous launch (old ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SdkNetRequest } from '@durbun/protocol';
import type { Hub } from '../../src/types';
import { appInput, device, makeHub } from './helpers';

let hub: Hub;
afterEach(() => hub?.dispose());

function setup() {
  hub = makeHub();
  hub.upsertDevice(device('android:R5CT'));
  return hub.registerApp(appInput('android:R5CT'));
}

const request = (id: string, patch: Partial<SdkNetRequest> = {}): SdkNetRequest => ({
  type: 'net.request',
  id,
  ts: 1_000,
  method: 'GET',
  url: 'http://127.0.0.1:61000/api/broken',
  headers: [['accept-encoding', 'gzip']],
  source: 'dart:io',
  ...patch,
});

describe('real SDK traffic shapes', () => {
  it('Flutter: partial body then net.error → failed, status/headers/partial body kept', () => {
    const app = setup();
    hub.netRequest(app.id, request('7'));
    hub.netResponse(app.id, {
      type: 'net.response',
      id: '7',
      ts: 1_061.5,
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json'], ['content-length', '5000']],
      body: { encoding: 'utf8', data: '{"items":[1,2,3', size: 15, truncated: true },
      timings: { connect: 0.3, send: 0.1, wait: 1.2, receive: 59.9 },
    });
    hub.netError(app.id, { type: 'net.error', id: '7', ts: 1_062, error: 'HttpException: Connection closed while receiving data' });
    const entry = hub.getNetwork()[0]!;
    expect(entry).toMatchObject({
      state: 'failed',
      status: 200,
      statusText: 'OK',
      error: 'HttpException: Connection closed while receiving data',
      responseBodySize: 15,
      hasResponseBody: true,
      responseContentType: 'application/json',
      duration: 62,
    });
    expect(entry.timings).toMatchObject({ receive: 59.9 });
    expect(hub.getNetworkDetail(entry.id)!.responseBody).toEqual({ encoding: 'utf8', data: '{"items":[1,2,3', size: 15, truncated: true });
    // One network row in the log stream, not one per message.
    expect(hub.getLogs().filter((l) => l.kind === 'network')).toHaveLength(1);
  });

  it('size-only placeholder bodies record sizes and stay retrievable', () => {
    const app = setup();
    hub.netRequest(app.id, request('8', { method: 'POST', url: 'http://127.0.0.1:61000/api/users', body: { encoding: 'utf8', data: '', size: 17, truncated: true } }));
    hub.netResponse(app.id, {
      type: 'net.response',
      id: '8',
      ts: 1_010,
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8'], ['transfer-encoding', 'chunked']],
      body: { encoding: 'utf8', data: '', size: 101, truncated: true },
    });
    const entry = hub.getNetwork()[0]!;
    expect(entry).toMatchObject({ requestBodySize: 17, responseBodySize: 101, hasRequestBody: true, hasResponseBody: true, state: 'complete' });
    expect(entry.bodyEvicted).toBeUndefined();
    expect(hub.getNetworkDetail(entry.id)).toMatchObject({
      requestBody: { data: '', size: 17, truncated: true },
      responseBody: { data: '', size: 101, truncated: true },
    });
    // Searching must not trip over empty placeholder data.
    expect(hub.searchNetwork('users')).toEqual([entry.id]);
    expect(hub.searchNetwork('nothing-in-there')).toEqual([]);
  });

  it('iOS: a crash of the previous launch keeps its old ts and fatal/crash, ordered by arrival', () => {
    const app = setup();
    const now = Date.now();
    hub.pushAppLog(app.id, { ts: now, level: 'info', tag: 'app', message: 'launch' });
    hub.netRequest(app.id, request('9', { ts: now + 5 }));
    const crash = hub.pushAppLog(app.id, {
      ts: now - 3_600_000,
      level: 'fatal',
      tag: 'crash',
      kind: 'crash',
      message: 'Crash in previous launch: SIGSEGV (EXC_BAD_ACCESS)',
      data: { previousLaunch: true, signal: 'SIGSEGV' },
      error: { type: 'SIGSEGV', message: 'EXC_BAD_ACCESS', stack: '0 Pati 0x0000000100a1b2c3 main + 44' },
    })!;
    expect(crash).toMatchObject({ ts: now - 3_600_000, level: 'fatal', kind: 'crash', data: { previousLaunch: true } });
    const ids = hub.getLogs().map((l) => l.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(hub.getLogs().at(-1)!.id).toBe(crash.id);
    expect(hub.getApp(app.id)!.stats).toMatchObject({ logs: 2, errors: 1 });
    // The old ts must not pull the "failed on disconnect" end time before the request started.
    hub.markAppDisconnected(app.id);
    const failed = hub.getNetwork()[0]!;
    expect(failed.state).toBe('failed');
    expect(failed.endTs === undefined || failed.endTs >= failed.startTs).toBe(true);
  });
});
