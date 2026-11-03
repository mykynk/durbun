import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDurbunPage,
  fallbackPorts,
  isPortFree,
  originFor,
  parsePortEnv,
  planHttpPort,
  probeDurbun,
  proveDurbun,
  watchAttached,
  type PortDeps,
} from '../src/ports';

const deps = (running: Record<number, string>, busy: number[]): PortDeps => ({
  probe: async (p) => (running[p] ? { version: running[p]! } : undefined),
  isFree: async (p) => !busy.includes(p) && !running[p],
});

describe('planHttpPort', () => {
  it('starts on the preferred port when it is free', async () => {
    expect(await planHttpPort(9750, 9751, deps({}, []))).toEqual({ kind: 'start', port: 9750, fallback: false });
  });
  it('attaches to a Dürbün already answering on the port', async () => {
    expect(await planHttpPort(9750, 9751, deps({ 9750: '0.1.0' }, []))).toEqual({ kind: 'attach', port: 9750, version: '0.1.0' });
  });
  it('picks a stable nearby port when another program holds it', async () => {
    expect(await planHttpPort(9750, 9751, deps({}, [9750]))).toEqual({ kind: 'start', port: 9760, fallback: true });
    expect(await planHttpPort(9750, 9751, deps({}, [9750, 9760, 9770]))).toEqual({ kind: 'start', port: 9780, fallback: true });
  });
  it('falls back to an OS-assigned port at last', async () => {
    expect(await planHttpPort(9750, 9751, deps({}, [9750, 9760, 9770, 9780]))).toEqual({ kind: 'start', port: 0, fallback: true });
  });
  it('never proposes the SDK port', () => {
    expect(fallbackPorts(9741, 9751)).toEqual([9761, 9771, 0]);
  });
});

describe('watchAttached', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('reports a Dürbün that stopped answering once, after consecutive misses', async () => {
    const answers = [true, false, true, false, false, false, false];
    let probes = 0;
    const onGone = vi.fn();
    watchAttached(9750, { probe: async () => (answers[probes++] ? { version: '0.1.0' } : undefined), onGone, intervalMs: 2, misses: 3 });
    await vi.waitFor(() => expect(onGone).toHaveBeenCalledOnce());
    expect(probes).toBe(6); // the success at #3 reset the count; #4–#6 were the three misses
    await wait(20);
    expect(probes).toBe(6);
  });
  it('stops probing when stopped', async () => {
    const probe = vi.fn(async () => undefined);
    const onGone = vi.fn();
    const stop = watchAttached(9750, { probe, onGone, intervalMs: 2, misses: 3 });
    stop();
    await wait(20);
    expect(probe).not.toHaveBeenCalled();
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe('parsePortEnv', () => {
  it('accepts 1–65535 and falls back otherwise', () => {
    expect(parsePortEnv('9800', 9750)).toBe(9800);
    expect(parsePortEnv(' 9801 ', 9751)).toBe(9801);
    expect(parsePortEnv(undefined, 9750)).toBe(9750);
    expect(parsePortEnv('0', 9750)).toBe(9750);
    expect(parsePortEnv('70000', 9750)).toBe(9750);
    expect(parsePortEnv('abc', 9750)).toBe(9750);
  });
});

describe('isPortFree', () => {
  let srv: net.Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));
  it('detects a listening port', async () => {
    srv = net.createServer();
    const port = await new Promise<number>((r) => srv!.listen(0, '127.0.0.1', () => r((srv!.address() as net.AddressInfo).port)));
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((r) => srv!.close(() => r()));
    srv = undefined;
    expect(await isPortFree(port)).toBe(true);
  });
  it('counts a program on 0.0.0.0 as taken (127.0.0.1 would bind on top of it, the LAN bind would fail)', async () => {
    srv = net.createServer();
    const port = await new Promise<number>((r) => srv!.listen(0, '0.0.0.0', () => r((srv!.address() as net.AddressInfo).port)));
    expect(await isPortFree(port)).toBe(false);
  });
});

/* ───────────── "is it really Dürbün?" before the window is handed over ───────────── */

const UI_INDEX = readFileSync(path.resolve(__dirname, '..', '..', '..', 'packages', 'ui', 'index.html'), 'utf8');
/** The server's page when no UI is built (packages/server/src/http/static.ts fallbackPageHtml, shortened). */
const PLACEHOLDER = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Dürbün</title></head><body><main><h1>Dürbün çalışıyor</h1><footer>Sunucu / server v0.1.0 · <a href="/api/health">/api/health</a></footer></main></body></html>';

interface Fake {
  port: number;
  hosts: string[];
  close(): Promise<void>;
}

/** A local HTTP server on 127.0.0.1: `health` is the /api/health body, `root` answers "/". */
async function fakeServer(opts: { health?: unknown; root?: (res: http.ServerResponse) => void }): Promise<Fake> {
  const hosts: string[] = [];
  const srv = http.createServer((req, res) => {
    hosts.push(String(req.headers.host));
    if (req.url === '/api/health' && opts.health !== undefined) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(opts.health));
      return;
    }
    if (req.url === '/' && opts.root) {
      opts.root(res);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
  return { port, hosts, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const html = (body: string) => (res: http.ServerResponse) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
};
const healthy = { ok: true, name: 'durbun', version: '0.1.0' };
const prove = (port: number) => proveDurbun(port, { health: (p) => probeDurbun(p) });

describe('proveDurbun', () => {
  const open: Fake[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((f) => f.close()));
  });
  const serve = async (opts: Parameters<typeof fakeServer>[0]) => {
    const f = await fakeServer(opts);
    open.push(f);
    return f;
  };

  it('accepts a Dürbün that serves its UI, and talks to the host the window loads', async () => {
    const f = await serve({ health: healthy, root: html(UI_INDEX) });
    expect(await prove(f.port)).toEqual({ version: '0.1.0', page: 'ui' });
    // Probe and window use the same host: 127.0.0.1, never "localhost" (Chromium tries ::1 first).
    expect(originFor(f.port)).toBe(`http://127.0.0.1:${f.port}`);
    expect(new Set(f.hosts)).toEqual(new Set([new URL(originFor(f.port)).host]));
  });

  it('accepts a Dürbün without a UI build (its own placeholder page)', async () => {
    const f = await serve({ health: healthy, root: html(PLACEHOLDER) });
    expect(await prove(f.port)).toEqual({ version: '0.1.0', page: 'placeholder' });
  });

  it('refuses a program that only answers /api/health like Dürbün (audit PoC)', async () => {
    const f = await serve({ health: { ok: true, name: 'durbun', version: '9.9.9' } });
    expect(await probeDurbun(f.port)).toEqual({ version: '9.9.9' }); // the health check alone is fooled
    expect(await prove(f.port)).toBeUndefined();
  });

  it('refuses a page that is not Dürbün\'s, or not HTML, or a redirect', async () => {
    const other = await serve({ health: healthy, root: html('<!doctype html><title>Vite App</title><div id="root"></div>') });
    expect(await prove(other.port)).toBeUndefined();
    const json = await serve({
      health: healthy,
      root: (res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ html: UI_INDEX }));
      },
    });
    expect(await prove(json.port)).toBeUndefined();
    const target = await serve({ health: healthy, root: html(UI_INDEX) });
    const redirect = await serve({
      health: healthy,
      root: (res) => {
        res.statusCode = 302;
        res.setHeader('location', `http://127.0.0.1:${target.port}/`);
        res.end();
      },
    });
    expect(await prove(redirect.port)).toBeUndefined();
  });

  it('refuses a health answer without a real version', async () => {
    for (const version of [undefined, '?', '', 'latest', '1.2', '1.2.3; rm -rf', 'x'.repeat(300)]) {
      const f = await serve({ health: { ok: true, name: 'durbun', version }, root: html(UI_INDEX) });
      expect(await prove(f.port), String(version)).toBeUndefined();
    }
    const pre = await serve({ health: { ok: true, name: 'durbun', version: '0.2.0-beta.1' }, root: html(UI_INDEX) });
    expect(await prove(pre.port)).toEqual({ version: '0.2.0-beta.1', page: 'ui' });
  });

  it('hands an impersonator no window: the plan moves to a fallback port instead of attaching', async () => {
    const f = await serve({ health: healthy });
    const plan = await planHttpPort(f.port, 0, { probe: prove, isFree: async (p) => p !== f.port });
    expect(plan).toEqual({ kind: 'start', port: f.port + 10, fallback: true });
  });
});

describe('classifyDurbunPage', () => {
  it('knows the UI build by its application-name, in either Unicode form', () => {
    expect(classifyDurbunPage(UI_INDEX)).toBe('ui');
    expect(classifyDurbunPage(UI_INDEX.normalize('NFD'))).toBe('ui');
  });
  it('knows the placeholder page and nothing else', () => {
    expect(classifyDurbunPage(PLACEHOLDER)).toBe('placeholder');
    expect(classifyDurbunPage('<title>Dürbün</title>')).toBeUndefined();
    expect(classifyDurbunPage('<html><body>ok</body></html>')).toBeUndefined();
  });
});
