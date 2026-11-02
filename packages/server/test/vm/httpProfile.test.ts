import { readFileSync } from 'node:fs';
import type { SdkNetError, SdkNetRequest, SdkNetResponse } from '@durbun/protocol';
import { describe, expect, it } from 'vitest';
import {
  bytesToWireBody,
  classifyRequest,
  computeTimings,
  HttpProfileTracker,
  looksLikeText,
  requestBodyPlan,
  responseBodyPlan,
  terminalMessages,
  toNetRequest,
  wireIdFor,
  type HttpProfileJson,
  type HttpProfileRequestJson,
  type NetMessage,
} from '../../src/platform/flutterVm/httpProfile';
import { testLogger } from './helpers';

/** Recorded from fixtures/app.dart with Dart 3.10 (`getHttpProfile` refs and `getHttpProfileRequest`). */
const profile = JSON.parse(readFileSync(new URL('./fixtures/http-profile.json', import.meta.url), 'utf8')) as HttpProfileJson;
const fulls = JSON.parse(
  readFileSync(new URL('./fixtures/http-profile-requests.json', import.meta.url), 'utf8'),
) as HttpProfileRequestJson[];
const [getRef, postRef, missingRef, refusedRef] = profile.requests!;
const fullById = new Map(fulls.map((f) => [f.id, f]));
const policy = { captureBodies: true, maxBodyBytes: 1_048_576 };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('profile → wire conversion (recorded fixtures)', () => {
  it('classifies request phases', () => {
    expect(classifyRequest(getRef!)).toMatchObject({ requestDone: true, responseStarted: true, responseDone: true, terminal: true });
    expect(classifyRequest(refusedRef!)).toMatchObject({ requestDone: true, responseStarted: false, terminal: true });
    expect(classifyRequest(refusedRef!).requestError).toMatch(/Connection refused/);
    const inFlight = clone(getRef!);
    delete inFlight.endTime;
    delete inFlight.request;
    delete inFlight.response;
    expect(classifyRequest(inFlight)).toMatchObject({ requestDone: false, terminal: false });
  });

  it('builds net.request with flattened headers and device-clock ms', () => {
    const req = toNetRequest(getRef!, 'w1');
    expect(req).toMatchObject({ type: 'net.request', id: 'w1', method: 'GET', url: getRef!.uri, source: 'vm-service' });
    expect(req.ts).toBe(getRef!.startTime! / 1000);
    expect(req.headers).toEqual(expect.arrayContaining([['accept', 'application/json'], ['user-agent', 'Dart/3.10 (dart:io)']]));
    expect(req.body).toBeUndefined();
  });

  it('builds net.response with status, body, timings and remote address', () => {
    const full = fullById.get(getRef!.id)!;
    const body = bytesToWireBody(full.responseBody, 'application/json; charset=utf-8', policy.maxBodyBytes);
    const [resp] = terminalMessages(full, 'w1', body) as SdkNetResponse[];
    expect(resp).toMatchObject({ type: 'net.response', id: 'w1', status: 200, statusText: 'OK', protocol: 'http/1.1' });
    expect(resp!.ts).toBe(full.response!.endTime! / 1000);
    expect(resp!.remoteAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(resp!.headers).toEqual(expect.arrayContaining([['content-type', 'application/json; charset=utf-8']]));
    expect(resp!.body).toMatchObject({ encoding: 'utf8', size: full.responseBody!.length });
    expect(JSON.parse(resp!.body!.data).users.map((u: { name: string }) => u.name)).toEqual(['Ayşe', 'Mehmet']);
    const t = resp!.timings!;
    for (const k of ['connect', 'send', 'wait', 'receive'] as const) expect(t[k]).toBeGreaterThanOrEqual(0);
    const total = (full.response!.endTime! - full.startTime!) / 1000;
    expect(t.connect! + t.send! + t.wait! + t.receive!).toBeCloseTo(total, 1);
  });

  it('maps connection failures to net.error and 404s to normal responses', () => {
    const [err] = terminalMessages(refusedRef!, 'w9') as SdkNetError[];
    expect(err).toMatchObject({ type: 'net.error', id: 'w9' });
    expect(err!.error).toMatch(/^SocketException: Connection refused/);
    expect(err!.cancelled).toBeUndefined();
    const [notFound] = terminalMessages(missingRef!, 'w3') as SdkNetResponse[];
    expect(notFound).toMatchObject({ type: 'net.response', status: 404, statusText: 'Not Found' });
  });

  it('marks aborted requests as cancelled and treats WebSocket upgrades as complete', () => {
    const aborted = clone(refusedRef!);
    aborted.request = { error: 'HttpException: Request has been aborted' };
    expect((terminalMessages(aborted, 'a')[0] as SdkNetError).cancelled).toBe(true);
    const upgrade = clone(getRef!);
    upgrade.response = { ...upgrade.response!, statusCode: 101, reasonPhrase: 'Switching Protocols', error: 'Socket has been detached' };
    const msgs = terminalMessages(upgrade, 'u');
    expect(msgs.map((m) => m.type)).toEqual(['net.response']);
    const broken = clone(getRef!);
    broken.response = { ...broken.response!, error: 'Connection closed while receiving data' };
    expect(terminalMessages(broken, 'b').map((m) => m.type)).toEqual(['net.response', 'net.error']);
  });

  it('adds request cookies as a cookie header', () => {
    const r = clone(postRef!);
    r.request!.cookies = ['session=abc; Path=/; HttpOnly', 'lang=tr'];
    expect(toNetRequest(r, 'c').headers).toContainEqual(['cookie', 'session=abc; lang=tr']);
  });

  it('computes timings from events and phase timestamps', () => {
    const t = computeTimings({
      id: 'x',
      startTime: 1_000_000,
      events: [{ event: 'Connection established', timestamp: 1_010_000 }],
      endTime: 1_012_000,
      response: { startTime: 1_062_000, endTime: 1_070_500, statusCode: 200 },
    })!;
    expect(t).toEqual({ connect: 10, send: 2, wait: 50, receive: 8.5 });
    expect(computeTimings({ id: 'y' })).toBeUndefined();
  });

  it('wire ids are unique per isolate', () => {
    expect(wireIdFor('isolates/4429147007222695', '1895066055685939815')).toBe('4429147007222695-1895066055685939815');
    expect(wireIdFor('isolates/2', 'from_package/1')).toBe('2-from_package/1');
  });
});

describe('bodies', () => {
  it('decodes text as UTF-8 and truncates on a character boundary with the real size', () => {
    const bytes = [...Buffer.from('{"ad":"Dürbün çağ"}', 'utf8')];
    expect(bytesToWireBody(bytes, 'application/json', 100)).toEqual({ encoding: 'utf8', data: '{"ad":"Dürbün çağ"}', size: bytes.length });
    // "ü" is 2 bytes: cutting after 9 bytes would split it.
    const cut = bytesToWireBody(bytes, 'application/json', 9)!;
    expect(cut).toMatchObject({ encoding: 'utf8', size: bytes.length, truncated: true });
    expect(cut.data).toBe('{"ad":"D');
    expect(cut.data).not.toContain('�');
  });

  it('encodes binary as base64 and sniffs text when the content type is missing', () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    expect(bytesToWireBody(png, 'image/png', 100)).toEqual({ encoding: 'base64', data: Buffer.from(png).toString('base64'), size: 12 });
    expect(bytesToWireBody([...Buffer.from('plain ok')], undefined, 100)!.encoding).toBe('utf8');
    expect(bytesToWireBody(png, undefined, 100)!.encoding).toBe('base64');
    expect(bytesToWireBody([], 'text/plain', 100)).toBeUndefined();
    expect(bytesToWireBody(undefined, 'text/plain', 100)).toBeUndefined();
    expect(looksLikeText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
  });

  it('plans which bodies to fetch', () => {
    expect(requestBodyPlan(getRef!, policy).fetch).toBe(false); // GET, content-length 0
    expect(requestBodyPlan(postRef!, policy).fetch).toBe(true); // chunked JSON
    expect(requestBodyPlan(postRef!, { ...policy, captureBodies: false }).fetch).toBe(false);
    expect(responseBodyPlan(getRef!, policy).fetch).toBe(true);
    const head = clone(getRef!);
    head.method = 'HEAD';
    expect(responseBodyPlan(head, policy).fetch).toBe(false);
    const image = clone(getRef!);
    image.response!.headers = { 'content-type': ['image/jpeg'] };
    image.response!.contentLength = 3_000_000;
    expect(responseBodyPlan(image, policy)).toEqual({
      fetch: false,
      placeholder: { encoding: 'base64', data: '', size: 3_000_000, truncated: true },
    });
    image.response!.contentLength = 200_000;
    expect(responseBodyPlan(image, policy).fetch).toBe(true);
    image.response!.contentLength = -1; // unknown size binary: not fetched
    expect(responseBodyPlan(image, policy).fetch).toBe(false);
  });
});

function fakeDeps(overrides: {
  profiles?: HttpProfileJson[];
  full?: (id: string) => HttpProfileRequestJson | undefined;
  now?: () => number;
}) {
  const emitted: NetMessage[] = [];
  const sinces: (number | undefined)[] = [];
  const cleared: string[] = [];
  const queue = [...(overrides.profiles ?? [])];
  const deps = {
    getProfile: async (_iso: string, since?: number) => {
      sinces.push(since);
      return queue.length > 1 ? queue.shift()! : (queue[0] ?? { requests: [] });
    },
    getRequest: async (_iso: string, id: string) => {
      const f = overrides.full?.(id);
      if (!f) throw new Error('not found');
      return f;
    },
    clearProfile: async (iso: string) => {
      cleared.push(iso);
    },
    emit: (m: NetMessage) => emitted.push(m),
    policy: () => policy,
    now: overrides.now ?? (() => Date.now()),
    logger: testLogger,
  };
  return { deps, emitted, sinces, cleared, queue };
}

describe('HttpProfileTracker', () => {
  const ISO = 'isolates/4429147007222695';

  it('emits one request and one terminal message per request, with bodies, and never duplicates', async () => {
    const t = new HttpProfileTracker();
    const { deps, emitted, sinces } = fakeDeps({ profiles: [profile], full: (id) => fullById.get(id) });
    t.bind(deps);
    await t.poll(ISO);
    await t.idle();
    await t.poll(ISO); // same refs again (updatedSince is inclusive): nothing new
    await t.idle();
    expect(sinces).toEqual([undefined, profile.timestamp]);
    const requests = emitted.filter((m): m is SdkNetRequest => m.type === 'net.request');
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((r) => r.id)).size).toBe(4);
    for (const r of requests) {
      const terminal = emitted.filter((m) => m.id === r.id && m.type !== 'net.request');
      expect(terminal).toHaveLength(1);
      expect(emitted.indexOf(r)).toBeLessThan(emitted.indexOf(terminal[0]!));
    }
    const post = requests.find((r) => r.method === 'POST')!;
    expect(JSON.parse(post.body!.data)).toMatchObject({ user: 'yusuf' });
    const postResp = emitted.find((m): m is SdkNetResponse => m.type === 'net.response' && m.id === post.id)!;
    expect(JSON.parse(postResp.body!.data)).toMatchObject({ token: 'tok-123' });
    expect(emitted.filter((m) => m.type === 'net.error')).toHaveLength(1);
    expect(t.pendingCount()).toBe(0);
  });

  it('follows a request across polls: in flight → sent → finished', async () => {
    let now = 1_000;
    const inFlight = clone(getRef!);
    delete inFlight.endTime;
    delete inFlight.request;
    delete inFlight.response;
    const sent = clone(getRef!);
    delete sent.response;
    const t = new HttpProfileTracker();
    const { deps, emitted } = fakeDeps({
      profiles: [
        { timestamp: 1, requests: [inFlight] },
        { timestamp: 2, requests: [sent] },
        { timestamp: 3, requests: [] },
        { timestamp: 4, requests: [getRef!] },
      ],
      full: (id) => fullById.get(id),
      now: () => now,
    });
    t.bind(deps);
    await t.poll(ISO);
    expect(emitted).toHaveLength(0);
    await t.poll(ISO);
    expect(emitted.map((m) => m.type)).toEqual(['net.request']);
    expect((emitted[0] as SdkNetRequest).headers.length).toBeGreaterThan(0);
    await t.poll(ISO);
    now += 10_000;
    await t.poll(ISO);
    await t.idle();
    expect(emitted.map((m) => m.type)).toEqual(['net.request', 'net.response']);
    expect((emitted[1] as SdkNetResponse).body?.encoding).toBe('utf8');
  });

  it('reports a long-running request without headers after the grace period', async () => {
    let now = 0;
    const inFlight = clone(getRef!);
    delete inFlight.endTime;
    delete inFlight.request;
    delete inFlight.response;
    const t = new HttpProfileTracker({ requestGraceMs: 3000 });
    const { deps, emitted } = fakeDeps({ profiles: [{ requests: [inFlight] }], now: () => now });
    t.bind(deps);
    await t.poll(ISO);
    now = 3500;
    await t.poll(ISO);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as SdkNetRequest).headers).toEqual([]);
  });

  it('still emits when the body fetch fails', async () => {
    const t = new HttpProfileTracker();
    const { deps, emitted } = fakeDeps({ profiles: [{ requests: [postRef!] }], full: () => undefined });
    t.bind(deps);
    await t.poll(ISO);
    await t.idle();
    expect(emitted.map((m) => m.type)).toEqual(['net.request', 'net.response']);
    expect((emitted[0] as SdkNetRequest).body).toBeUndefined();
  });

  it('takes only the newest requests from a large backlog on the first poll', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...clone(refusedRef!), id: `r${i}`, startTime: 1000 + i }));
    const t = new HttpProfileTracker({ initialBacklog: 10 });
    const { deps, emitted } = fakeDeps({ profiles: [{ requests: many }] });
    t.bind(deps);
    await t.poll(ISO);
    const ids = emitted.filter((m) => m.type === 'net.request').map((m) => m.id);
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe(wireIdFor(ISO, 'r20'));
  });

  it('clears the in-app profile only when Dürbün enabled it and nothing is in flight', async () => {
    const finished = Array.from({ length: 5 }, (_, i) => ({ ...clone(refusedRef!), id: `f${i}` }));
    const t = new HttpProfileTracker({ clearAfterRequests: 3, minClearIntervalMs: 0 });
    const { deps, cleared } = fakeDeps({ profiles: [{ requests: finished }, { requests: [] }] });
    t.bind(deps);
    await t.poll(ISO);
    expect(cleared).toEqual([]); // not allowed: another tool may own the profiler
    t.setClearingAllowed(ISO, true);
    await t.poll(ISO);
    expect(cleared).toEqual([ISO]);

    const inFlight = clone(getRef!);
    delete inFlight.endTime;
    delete inFlight.request;
    delete inFlight.response;
    const t2 = new HttpProfileTracker({ clearAfterRequests: 3, minClearIntervalMs: 0 });
    const second = fakeDeps({ profiles: [{ requests: [...finished, inFlight] }, { requests: [] }] });
    t2.bind(second.deps);
    t2.setClearingAllowed(ISO, true);
    await t2.poll(ISO);
    await t2.poll(ISO);
    expect(second.cleared).toEqual([]);
  });

  it('does nothing once unbound', async () => {
    const t = new HttpProfileTracker();
    const { deps, emitted } = fakeDeps({ profiles: [profile], full: (id) => fullById.get(id) });
    t.bind(deps);
    t.unbind();
    await t.poll(ISO);
    expect(emitted).toHaveLength(0);
  });
});
