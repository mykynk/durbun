// @vitest-environment node
/**
 * /api/android/wireless: the REAL server module (loaded from its sources, a fake adb behind it) and the dev mock
 * (dev/mock-wireless.mjs) must answer with the same fields.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs dev tool without types
import { createMockWireless } from '../../../../dev/mock-wireless.mjs';

const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ path.resolve(__dirname, '../../../../../server', file)) as Promise<T>;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, p: string) => Promise<void>;
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(handler: Handler): Promise<string> {
  const s = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function realServer(): Promise<string> {
  const { createWirelessModule } = await load<{ createWirelessModule: (deps: unknown) => { handle: (req: unknown, res: unknown, segs: string[]) => Promise<void> } }>('src/http/androidWireless.ts');
  const { AdbWireless } = await load<{ AdbWireless: new (adb: unknown) => unknown }>('src/platform/android/wireless.ts');
  const { sendError } = await load<{ sendError: (res: unknown, status: number, message: string, code?: string, headers?: unknown, params?: unknown) => void }>('src/http/util.ts');
  const ok = (stdout: string) => ({ ok: true, code: 0, signal: null, timedOut: false, stdout, stderr: '' });
  const adb = {
    run: async (args: string[]) =>
      args[0] === 'pair'
        ? ok('Successfully paired to 192.168.1.42:37115 [guid=adb-R58N91XYZ-Qw3rTy]\n')
        : args[0] === 'connect'
          ? ok(`connected to ${args[1]}\n`)
          : ok('List of discovered mdns services\nadb-R58N91XYZ-Qw3rTy\t_adb-tls-pairing._tcp\t192.168.1.42:37115\nadb-R58N91XYZ-Qw3rTy\t_adb-tls-connect._tcp\t192.168.1.42:41235\n'),
  };
  const mod = createWirelessModule({ drivers: () => [{ id: 'android', wireless: () => new AdbWireless(adb) }], devices: () => [], settleMs: 0 });
  return serve(async (req, res, p) => {
    try {
      await mod.handle(req, res, p.split('/').filter(Boolean).slice(1));
    } catch (e) {
      const err = e as { status?: number; message: string; code?: string; params?: Record<string, string | number> };
      sendError(res, err.status ?? 500, err.message, err.code, {}, err.params);
    }
  });
}

const post = (base: string, op: string, body: unknown) =>
  fetch(`${base}/api/android/wireless/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const keys = (o: unknown) => Object.keys(o as object).sort();

describe('/api/android/wireless: server and mock', () => {
  it('state, pair (with the automatic connect), connect and a refused input carry the same fields', async () => {
    const real = await realServer();
    const mock = await serve(async (req, res, p) => {
      if (!(await createMockWirelessOnce().handle(req, res, p))) res.end();
    });

    const [s1, s2] = await Promise.all([real, mock].map(async (b) => (await fetch(`${b}/api/android/wireless`)).json()));
    expect(keys(s2)).toEqual(keys(s1));
    for (const kind of ['pairing', 'connect']) {
      const a = (s1.services as { kind: string }[]).find((s) => s.kind === kind);
      const b = (s2.services as { kind: string; connected?: boolean }[]).find((s) => s.kind === kind);
      const { connected: _c, ...bWithout } = b as { connected?: boolean };
      expect([kind, keys(bWithout)]).toEqual([kind, keys(a)]);
    }

    const body = { host: '192.168.1.42', port: 37115, code: '123456' };
    const [p1, p2] = await Promise.all([real, mock].map(async (b) => (await post(b, 'pair', body)).json()));
    expect(keys(p2)).toEqual(keys(p1));
    expect(keys(p2.connected)).toEqual(keys(p1.connected));
    expect(p2).toMatchObject({ ok: true, code: p1.code });

    const [c1, c2] = await Promise.all([real, mock].map(async (b) => (await post(b, 'connect', { host: '192.168.1.42', port: 41235 })).json()));
    expect(keys(c2)).toEqual(keys(c1));

    const bad = await Promise.all([real, mock].map(async (b) => post(b, 'pair', { host: '-x', port: 1, code: '123456' })));
    expect(bad.map((r) => r.status)).toEqual([400, 400]);
    const [e1, e2] = await Promise.all(bad.map((r) => r.json()));
    expect(e2).toEqual(e1);
  });
});

let mockInstance: ReturnType<typeof createMockWireless> | undefined;
function createMockWirelessOnce() {
  mockInstance ??= createMockWireless();
  return mockInstance;
}
