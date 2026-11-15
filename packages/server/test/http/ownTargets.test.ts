/**
 * Requests Dürbün sends itself (replay, flow http.request steps) never reach its own server, while other local
 * services stay reachable. Real HTTP servers on ephemeral ports: the app, a "tester backend" and a redirector.
 */
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowRun } from '@durbun/protocol';
import {
  assertNotOwnServer,
  DESKTOP_REQUEST_HEADER,
  isThisMacAddress,
  isThisMacHostname,
  normalizeAddress,
  OwnServerRequestError,
} from '../../src/http/ownTargets';
import { sendDesktopRequest } from '../../src/http/replay';
import { checkLocalAccess } from '../../src/http/security';
import { connectUi, sampleNetwork, startTestApp, type TestApp } from './fakes';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

interface Backend {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

/** A local service on an ephemeral port; `/to?u=<url>` answers 302 to that URL, everything else 200. */
async function backend(): Promise<Backend> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/to') {
      res.writeHead(Number(u.searchParams.get('status') ?? 302), { Location: u.searchParams.get('u') ?? '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: u.pathname }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let t: TestApp | undefined;
let b: Backend | undefined;
afterEach(async () => {
  await t?.close();
  await b?.close();
  t = undefined;
  b = undefined;
});

const lanAddress = (): string | undefined => {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') return a.address;
  return undefined;
};

describe('this Mac addresses', () => {
  it('normalizes brackets, zones and IPv4-mapped IPv6', () => {
    expect(normalizeAddress('[::1]')).toBe('::1');
    expect(normalizeAddress('fe80::1%en0')).toBe('fe80::1');
    expect(normalizeAddress('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('0:0:0:0:0:ffff:7f00:2')).toBe('127.0.0.2');
  });

  it('knows loopback, unspecified and interface addresses', () => {
    const own = new Set(['192.168.1.20', 'fe80::1']);
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '0.0.0.0', '::', '[::ffff:7f00:1]', '192.168.1.20', 'fe80::1%en0']) expect(isThisMacAddress(a, own), a).toBe(true);
    for (const a of ['192.168.1.21', '10.0.2.2', '8.8.8.8', '2001:db8::1']) expect(isThisMacAddress(a, own), a).toBe(false);
  });

  it('knows local host names without DNS', () => {
    const names = { addresses: new Set(['192.168.1.20']), hostNames: new Set(['yusufs-mac', 'yusufs-mac.local']) };
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '[::1]', '0.0.0.0', '192.168.1.20', 'yusufs-mac.local', 'localhost.']) {
      expect(isThisMacHostname(h, names), h).toBe(true);
    }
    for (const h of ['example.com', '192.168.1.21', 'other-mac.local']) expect(isThisMacHostname(h, names), h).toBe(false);
  });

  it('refuses only own ports on this Mac; resolves names only for own ports', async () => {
    const lookups: string[] = [];
    const lookup = async (h: string) => {
      lookups.push(h);
      return h === 'rebind.example' ? ['127.0.0.1'] : ['93.184.216.34'];
    };
    const guard = { ownPorts: () => [9750, 41000], lookup };
    await expect(assertNotOwnServer(new URL('http://127.0.0.1:9750/api/health'), guard)).rejects.toBeInstanceOf(OwnServerRequestError);
    await expect(assertNotOwnServer(new URL('http://localhost:41000/'), guard)).rejects.toMatchObject({ code: 'net.ownServer', params: { port: 41000 } });
    await expect(assertNotOwnServer(new URL('http://rebind.example:9750/api/export'), guard)).rejects.toMatchObject({ code: 'net.ownServer' });
    // Other local services and other machines on the same port stay reachable.
    await assertNotOwnServer(new URL('http://localhost:3000/api'), guard);
    await assertNotOwnServer(new URL('http://other.example:9750/'), guard);
    await assertNotOwnServer(new URL('http://10.0.2.2:9750/'), guard);
    expect(lookups).toEqual(['rebind.example', 'other.example']);
    const lan = lanAddress();
    if (lan) await expect(assertNotOwnServer(new URL(`http://${lan}:9750/`), guard)).rejects.toMatchObject({ code: 'net.ownServer' });
  });
});

describe('checkLocalAccess and the desktop marker', () => {
  it('refuses a loopback request that carries the marker header', () => {
    const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Parameters<typeof checkLocalAccess>[0];
    expect(checkLocalAccess(req({ host: '127.0.0.1:9750' }), 9750)).toEqual({ ok: true });
    expect(checkLocalAccess(req({ host: '127.0.0.1:9750', [DESKTOP_REQUEST_HEADER.toLowerCase()]: '1' }), 9750).ok).toBe(false);
  });
});

describe('desktop requests against real local servers', () => {
  it('replay: refuses the app\'s own HTTP and gateway ports (directly and through a redirect), sends to other local services', async () => {
    t = await startTestApp();
    b = await backend();
    const ui = await connectUi(t.port);
    try {
      await ui.waitForType('snapshot');
      const replay = (id: string, url: string) => {
        t!.hub.recordDesktopRequest(sampleNetwork(id, { url, method: 'GET', requestHeaders: [['Accept', 'application/json']], requestBody: undefined, hasRequestBody: false }));
        return ui.command({ name: 'net.replay', id });
      };

      const own = await replay('c:1', `http://127.0.0.1:${t.port}/api/flow-environments`);
      expect(own).toMatchObject({ ok: false, code: 'net.ownServer' });
      const viaLocalhost = await replay('c:2', `http://localhost:${t.port}/api/export`);
      expect(viaLocalhost).toMatchObject({ ok: false, code: 'net.ownServer' });
      expect(t.app.devicePort).toBeTypeOf('number');
      const gateway = await replay('c:3', `http://127.0.0.1:${t.app.devicePort}/api/health`);
      expect(gateway).toMatchObject({ ok: false, code: 'net.ownServer' });

      const redirected = await replay('c:4', `http://127.0.0.1:${b.port}/to?u=${encodeURIComponent(`http://127.0.0.1:${t.port}/api/flow-environments`)}`);
      expect(redirected).toMatchObject({ ok: false, code: 'net.ownServer' });
      expect(redirected.ok ? '' : redirected.error).toMatch(/redirected/);

      // A tester's backend on localhost (a foreign port of this Mac) is a normal target, redirects inside it
      // included; it sees the marker, the Network tab copy does not.
      const fine = await replay('c:5', `http://localhost:${b.port}/to?u=/users`);
      expect(fine).toMatchObject({ ok: true, data: { state: 'complete', status: 200 } });
      const last = b.seen.at(-1)!;
      expect(last.url).toBe('/users');
      expect(last.headers[DESKTOP_REQUEST_HEADER.toLowerCase()]).toBe('1');
      const recorded = t.hub.getNetworkDetail((fine as { data: { id: string } }).data.id)!;
      expect(recorded.requestHeaders.map(([k]) => k.toLowerCase())).not.toContain(DESKTOP_REQUEST_HEADER.toLowerCase());
    } finally {
      ui.close();
    }
  });

  it('a marked request that still reaches /api is refused (DNS changed after the check)', async () => {
    t = await startTestApp();
    const res = await fetch(`${t.base}/api/health`, { headers: { [DESKTOP_REQUEST_HEADER]: '1' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('access.denied');
    expect((await fetch(`${t.base}/api/health`)).status).toBe(200);
  });

  it('follows redirects like fetch: 303 turns into GET without body, credentials stay on the same origin only', async () => {
    b = await backend();
    const other = await backend();
    try {
      const recorded: unknown[] = [];
      const hub = { recordDesktopRequest: (d: never) => (recorded.push(d), d) };
      const target = `http://127.0.0.1:${other.port}/landed`;
      const res = await sendDesktopRequest(
        { hub, maxBodyBytes: 1000, source: 'replay', idPrefix: 'replay', guard: { ownPorts: () => [1] } },
        {
          method: 'POST',
          url: `http://127.0.0.1:${b.port}/to?status=303&u=${encodeURIComponent(target)}`,
          headers: [
            ['Authorization', 'Bearer s3cret'],
            ['Content-Type', 'application/json'],
            [DESKTOP_REQUEST_HEADER, 'spoofed'],
          ],
          body: Buffer.from('{"a":1}'),
        },
      );
      expect(res.detail).toMatchObject({ state: 'complete', status: 200 });
      expect(res.finalUrl).toBe(target);
      const landed = other.seen.at(-1)!;
      expect(landed.method).toBe('GET');
      expect(landed.headers.authorization).toBeUndefined();
      expect(landed.headers['content-type']).toBeUndefined();
      expect(landed.headers[DESKTOP_REQUEST_HEADER.toLowerCase()]).toBe('1');
      expect(b.seen.at(-1)!.headers.authorization).toBe('Bearer s3cret');
      expect(recorded).toHaveLength(1);
      // The caller's (spoofed) marker is not recorded either.
      expect((recorded[0] as { requestHeaders: [string, string][] }).requestHeaders.map(([k]) => k)).toEqual(['Authorization', 'Content-Type']);
    } finally {
      await other.close();
    }
  });
});

describe('the desktop marker goes to this Mac only, hop by hop', () => {
  it('a remote target gets no marker; a redirect to this Mac adds it, one away from it drops it', async () => {
    const seen: { url: string; marker: string | null }[] = [];
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      seen.push({ url: url.toString(), marker: new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).get(DESKTOP_REQUEST_HEADER) });
      const to = url.searchParams.get('to');
      return to ? new Response(null, { status: 302, headers: { Location: to } }) : new Response('ok');
    }) as typeof fetch;
    const hub = { recordDesktopRequest: (d: never) => d };
    const send = (url: string) =>
      sendDesktopRequest({ hub, maxBodyBytes: 100, source: 'replay', idPrefix: 'replay', fetchImpl, guard: { ownPorts: () => [9750] } }, { method: 'GET', url, headers: [['Accept', '*/*']] });

    await send('https://api.example.com/plain');
    expect(seen).toEqual([{ url: 'https://api.example.com/plain', marker: null }]);

    seen.length = 0;
    await send(`https://api.example.com/a?to=${encodeURIComponent('http://127.0.0.1:3000/local?to=https%3A%2F%2Fcdn.example.com%2Fz')}`);
    expect(seen.map((h) => [new URL(h.url).host, h.marker])).toEqual([
      ['api.example.com', null],
      ['127.0.0.1:3000', '1'],
      ['cdn.example.com', null],
    ]);
  });
});

describe('flows', () => {
  const json = { 'Content-Type': 'application/json' };
  async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${t!.base}${url}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  }
  const flow = (id: string, url: string) => ({
    format: 'durbun-flow',
    version: 1,
    id,
    name: id,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      { id: 'req', type: 'http.request', params: { method: 'GET', url } },
    ],
    edges: [{ from: 'start', to: 'req' }],
  });
  async function waitRun(id: string): Promise<FlowRun> {
    for (let i = 0; i < 200; i++) {
      const { data } = await call<FlowRun>('GET', `/api/flow-runs/${id}`);
      if (data.status !== 'running') return data;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('run did not end');
  }

  it('preflight refuses a step to the own server and warns for other services on this Mac; a redirect fails the step', async () => {
    t = await startTestApp({ flowsBackground: false });
    b = await backend();

    expect((await call('POST', '/api/flows', { flow: flow('own', `http://127.0.0.1:${t.port}/api/flow-environments`) })).status).toBe(201);
    const refused = await call<{ code: string; preflight: { issues: { code: string; level: string }[] } }>('POST', '/api/flows/own/run', {});
    expect(refused.status).toBe(409);
    expect(refused.data.preflight.issues).toContainEqual(expect.objectContaining({ code: 'preflight.http.ownServer', level: 'error' }));

    const sneaky = `http://localhost:${b.port}/to?u=${encodeURIComponent(`http://127.0.0.1:${t.port}/api/flow-environments`)}`;
    expect((await call('POST', '/api/flows', { flow: flow('sneaky', sneaky) })).status).toBe(201);
    const started = await call<FlowRun>('POST', '/api/flows/sneaky/run', {});
    expect(started.status).toBe(202);
    expect(started.data.preflight).toContainEqual(expect.objectContaining({ code: 'preflight.http.thisMac', level: 'warn', params: { host: `localhost:${b.port}` } }));
    const run = await waitRun(started.data.id);
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'req')).toMatchObject({ errorCode: 'net.ownServer' });

    expect((await call('POST', '/api/flows', { flow: flow('fine', `http://localhost:${b.port}/users`) })).status).toBe(201);
    const ok = await waitRun((await call<FlowRun>('POST', '/api/flows/fine/run', {})).data.id);
    expect(ok.status).toBe('passed');
    expect(b.seen.at(-1)!.url).toBe('/users');
  });
});
