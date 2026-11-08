import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import type { Adb } from '../../src/platform/android/adb';
import type { PortMapping } from '../../src/platform/android/parsers';
import {
  acceptsConnections,
  AdbReverseRouter,
  durbunAnswersAt,
  probeDurbun,
  REVERSE_TIMING,
  ROUTE_ELSEWHERE_CODE,
} from '../../src/platform/android/reverse';
import type { RunResult } from '../../src/platform/exec';
import { silentLogger } from '../../src/util/logger';
import { createCtx, type FakeCtx } from './helpers';

/**
 * Two Dürbüns on one computer must not take a phone's adb reverse route from each other on every check
 * (r1-desktop request). Everything listens on OS-assigned loopback ports; the fake adb keeps the device's
 * reverse table in memory.
 */

const SERIAL = 'R58M123ABC';
const ID = `android:${SERIAL}`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function ok(): RunResult<string> {
  return { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false };
}

/** The device's reverse table ("tcp:9751" → "tcp:54321"), shared by every fake adb client. */
type Table = Map<string, string>;

function fakeAdb(table: Table) {
  const calls: string[] = [];
  const adb = {
    async reverseList(): Promise<PortMapping[]> {
      calls.push('list');
      return [...table].map(([local, remote]) => ({ local, remote }));
    },
    async reverse(_serial: string, devicePort: number, hostPort: number) {
      calls.push(`reverse tcp:${devicePort} tcp:${hostPort}`);
      table.set(`tcp:${devicePort}`, `tcp:${hostPort}`);
      return ok();
    },
    async reverseRemove(_serial: string, devicePort: number) {
      calls.push(`remove tcp:${devicePort}`);
      table.delete(`tcp:${devicePort}`);
      return ok();
    },
  } as unknown as Adb;
  return { adb, calls };
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

/** An HTTP server answering /api/health like a Dürbün (or with `body` / `status`). */
function healthServer(body: unknown = { ok: true, name: 'durbun', version: '0.1.0' }, status = 200): Promise<number> {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/health') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return listen(server);
}

/** Another Dürbün's per-device SDK listener (accepts and drops). */
function tcpListener(): Promise<number> {
  return listen(net.createServer((s) => s.destroy()));
}

/** A TCP server whose sockets `onSocket` handles (left open: they are destroyed before the server closes). */
async function rawServer(onSocket: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const port = await listen(
    net.createServer((s) => {
      sockets.add(s);
      onSocket(s);
    }),
  );
  closers.push(async () => sockets.forEach((s) => s.destroy()));
  return port;
}

/** A loopback port nothing listens on (bound once, then closed). */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Fake HTTP port of every instance below (the UI's port: tcp:9750 must never point there). */
const HTTP = 9700;

/**
 * One Dürbün's router for the device: its device gateway (what tcp:9750 is reversed to) is `gatewayPort`
 * (never a real Dürbün's port), its HTTP port `HTTP`.
 */
async function instance(table: Table, gatewayPort: number | undefined): Promise<{ router: AdbReverseRouter; calls: string[]; ctx: FakeCtx }> {
  const ctx = createCtx();
  ctx.ports = { http: HTTP, sdk: 9803, ...(gatewayPort === undefined ? {} : { device: gatewayPort }) };
  const { adb, calls } = fakeAdb(table);
  const router = new AdbReverseRouter({ adb: () => adb, serial: SERIAL, deviceId: ID, ctx, logger: silentLogger });
  await router.start();
  closers.push(() => router.stop(false));
  return { router, calls, ctx };
}

const routeLines = (ctx: FakeCtx) => ctx.hub.system.filter((s) => s.input.code === ROUTE_ELSEWHERE_CODE);

describe('probes', () => {
  it('tells a Dürbün from another program or nothing on a port', async () => {
    expect(await durbunAnswersAt(await healthServer())).toBe(true);
    expect(await durbunAnswersAt(await healthServer({ ok: true, name: 'something-else' }))).toBe(false);
    expect(await durbunAnswersAt(await healthServer('<html>hi</html>'))).toBe(false);
    expect(await durbunAnswersAt(await healthServer({ ok: true, name: 'durbun' }, 503))).toBe(false);
    expect(await durbunAnswersAt(await tcpListener())).toBe(false);
    expect(await durbunAnswersAt(await deadPort())).toBe(false);
    expect(await acceptsConnections(await tcpListener())).toBe(true);
    expect(await acceptsConnections(await deadPort())).toBe(false);
    expect(await acceptsConnections(0)).toBe(false);
  });

  it('tells a busy Dürbün (accepts, answers late or drops) from a port nothing listens on', async () => {
    expect(await probeDurbun(await healthServer())).toBe('durbun');
    expect(await probeDurbun(await healthServer({ ok: true, name: 'metro' }))).toBe('notDurbun');
    expect(await probeDurbun(await healthServer('<html>hi</html>'))).toBe('notDurbun');
    expect(await probeDurbun(await healthServer({ ok: true, name: 'durbun' }, 503))).toBe('notDurbun');
    expect(await probeDurbun(await rawServer((s) => s.end('SSH-2.0-OpenSSH_9.6\r\n')))).toBe('notDurbun');
    expect(await probeDurbun(await deadPort())).toBe('refused');
    expect(await probeDurbun(0)).toBe('refused');
    expect(await probeDurbun(await rawServer(() => undefined), 200)).toBe('noAnswer');
    expect(await probeDurbun(await tcpListener())).toBe('noAnswer'); // accepted, then reset
  });
});

describe('AdbReverseRouter with another Dürbün on the same computer', () => {
  it('leaves the route of another running Dürbün alone and says so once', async () => {
    const otherHttp = await healthServer();
    const otherSdk = await tcpListener();
    const table: Table = new Map([
      ['tcp:9751', `tcp:${otherSdk}`],
      ['tcp:9750', `tcp:${otherHttp}`],
    ]);
    const me = await instance(table, 9802);
    for (let i = 0; i < 3; i++) expect(await me.router.ensure()).toBe(false);
    expect(me.calls).toEqual(['list', 'list', 'list']); // no `adb reverse`: nothing re-pointed
    expect([...table]).toEqual([
      ['tcp:9751', `tcp:${otherSdk}`],
      ['tcp:9750', `tcp:${otherHttp}`],
    ]);
    expect(me.router.heldBy).toBe(otherHttp);
    const lines = routeLines(me.ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ deviceId: ID, input: { level: 'warn', params: { port: otherHttp } } });
    expect(lines[0]!.input.message).toContain(`localhost:${otherHttp}`);
    // Stopping removes only our own mappings: the other Dürbün keeps its route.
    await me.router.stop(true);
    expect(table.size).toBe(2);
  });

  it('two Dürbüns settle on the first one instead of taking turns every check', async () => {
    const table: Table = new Map();
    const a = await instance(table, await healthServer());
    const b = await instance(table, await healthServer());
    expect(await a.router.ensure()).toBe(true);
    const first = [...table];
    for (let round = 0; round < 3; round++) {
      expect(await b.router.ensure()).toBe(false);
      expect(await a.router.ensure()).toBe(true);
      expect([...table]).toEqual(first);
    }
    expect(table.get('tcp:9751')).toBe(`tcp:${a.router.localPort}`);
    expect(b.calls.filter((c) => c.startsWith('reverse'))).toEqual([]);
    expect(a.calls.filter((c) => c.startsWith('reverse'))).toHaveLength(2); // its own first setup only
    expect(routeLines(b.ctx)).toHaveLength(1);
    expect(routeLines(a.ctx)).toHaveLength(0);
  });

  it('takes stale mappings over at once when nothing answers behind them', async () => {
    const table: Table = new Map([
      ['tcp:9751', `tcp:${await deadPort()}`],
      ['tcp:9750', `tcp:${await deadPort()}`],
    ]);
    const me = await instance(table, 9802);
    expect(await me.router.ensure()).toBe(true);
    expect(table.get('tcp:9751')).toBe(`tcp:${me.router.localPort}`);
    expect(table.get('tcp:9750')).toBe('tcp:9802');
    expect(routeLines(me.ctx)).toHaveLength(0);
  });

  it('a program that is not a Dürbün on the mapped HTTP port does not keep the route', async () => {
    const table: Table = new Map([
      ['tcp:9751', `tcp:${await tcpListener()}`],
      ['tcp:9750', `tcp:${await healthServer({ ok: true, name: 'metro' })}`],
    ]);
    const me = await instance(table, 9802);
    expect(await me.router.ensure()).toBe(true);
    expect(table.get('tcp:9750')).toBe('tcp:9802');
    expect(table.get('tcp:9751')).toBe(`tcp:${me.router.localPort}`);
  });

  it('a Dürbün that answers but no longer serves the device (dead SDK listener) loses the route after a grace', async () => {
    const otherHttp = await healthServer();
    const table: Table = new Map([
      ['tcp:9751', `tcp:${await deadPort()}`],
      ['tcp:9750', `tcp:${otherHttp}`],
    ]);
    const me = await instance(table, 9802);
    for (let i = 1; i < REVERSE_TIMING.takeOverAfterChecks; i++) {
      expect(await me.router.ensure()).toBe(false); // give it time to repair its own route
      expect(table.get('tcp:9750')).toBe(`tcp:${otherHttp}`);
    }
    expect(await me.router.ensure()).toBe(true);
    expect(table.get('tcp:9750')).toBe('tcp:9802');
    expect(table.get('tcp:9751')).toBe(`tcp:${me.router.localPort}`);
    expect(me.router.heldBy).toBeUndefined();
    expect(routeLines(me.ctx)).toHaveLength(0); // it never served the device: nothing to explain
  });

  it('takes the route back once the other Dürbün is gone, and explains a new owner again', async () => {
    const table: Table = new Map();
    const a = await instance(table, await healthServer());
    const bHttp = await healthServer();
    const b = await instance(table, bHttp);
    await a.router.ensure();
    await b.router.ensure();
    expect(routeLines(b.ctx)).toHaveLength(1);
    // A quits cleanly (removes its mappings): B routes the device at its next check.
    await a.router.stop(true);
    expect(table.size).toBe(0);
    expect(await b.router.ensure()).toBe(true);
    expect(table.get('tcp:9750')).toBe(`tcp:${bHttp}`);
    expect(b.router.heldBy).toBeUndefined();
    // A third Dürbün takes it later (an older build that re-points on every check): B says so again.
    const cHttp = await healthServer();
    const cSdk = await tcpListener();
    table.set('tcp:9751', `tcp:${cSdk}`).set('tcp:9750', `tcp:${cHttp}`);
    expect(await b.router.ensure()).toBe(false);
    expect(routeLines(b.ctx).map((l) => l.input.params)).toEqual([{ port: a.ctx.ports.device }, { port: cHttp }]);
  });
});

describe('AdbReverseRouter never routes the phone to the HTTP port', () => {
  it('reverses tcp:9750 to the device gateway and moves its own older HTTP-port mapping there', async () => {
    const table: Table = new Map([['tcp:9750', `tcp:${HTTP}`]]); // this Dürbün's mapping from an older build
    const me = await instance(table, 9802);
    expect(await me.router.ensure()).toBe(true);
    expect(table.get('tcp:9750')).toBe('tcp:9802');
    expect(table.get('tcp:9751')).toBe(`tcp:${me.router.localPort}`);
    expect(me.router.heldBy).toBeUndefined();
    expect(routeLines(me.ctx)).toHaveLength(0);
    await me.router.stop(true);
    expect(table.size).toBe(0);
  });

  it('without a gateway, sets no tcp:9750 mapping and removes its own HTTP-port one', async () => {
    const table: Table = new Map([['tcp:9750', `tcp:${HTTP}`]]);
    const me = await instance(table, undefined);
    expect(await me.router.ensure()).toBe(true);
    expect([...table]).toEqual([['tcp:9751', `tcp:${me.router.localPort}`]]);
    expect(me.calls).toContain('remove tcp:9750');
  });

  it('names the other Dürbün by the HTTP port its gateway reports, not by the gateway port', async () => {
    const otherGateway = await healthServer({ ok: true, name: 'durbun', version: '0.1.0', httpPort: 9750 });
    const table: Table = new Map([
      ['tcp:9751', `tcp:${await tcpListener()}`],
      ['tcp:9750', `tcp:${otherGateway}`],
    ]);
    const me = await instance(table, 9802);
    expect(await me.router.ensure()).toBe(false);
    expect(me.router.heldBy).toBe(9750);
    expect(routeLines(me.ctx).map((l) => l.input.params)).toEqual([{ port: 9750 }]);
    expect(routeLines(me.ctx)[0]!.input.message).toContain('localhost:9750');
  });
});

describe('AdbReverseRouter and a busy owner', () => {
  /** A Dürbün whose /api/health answers after `delay.ms` (0 = at once), e.g. its event loop is busy. */
  async function busyDurbun(delay: { ms: number }): Promise<number> {
    const server = http.createServer((req, res) => {
      const answer = () =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'durbun', version: '0.1.0' }));
      if (delay.ms) setTimeout(answer, delay.ms).unref();
      else answer();
    });
    return listen(server);
  }

  function shortProbes(ms: number) {
    const saved = REVERSE_TIMING.probeTimeoutMs;
    REVERSE_TIMING.probeTimeoutMs = ms;
    closers.push(async () => {
      REVERSE_TIMING.probeTimeoutMs = saved;
    });
  }

  it('one health check missed by a running owner does not take its route; a second one in a row does', async () => {
    shortProbes(200);
    const delay = { ms: 0 };
    const otherHttp = await busyDurbun(delay);
    const otherSdk = await tcpListener();
    const table: Table = new Map([
      ['tcp:9751', `tcp:${otherSdk}`],
      ['tcp:9750', `tcp:${otherHttp}`],
    ]);
    const owned = [...table];
    const me = await instance(table, 9802);
    expect(await me.router.ensure()).toBe(false);
    expect(me.router.heldBy).toBe(otherHttp);
    delay.ms = 500; // e.g. it is parsing a large session import
    expect(await me.router.ensure()).toBe(false);
    expect([...table]).toEqual(owned);
    expect(me.router.heldBy).toBe(otherHttp);
    delay.ms = 0; // back: the grace starts over
    expect(await me.router.ensure()).toBe(false);
    delay.ms = 500;
    expect(await me.router.ensure()).toBe(false);
    expect([...table]).toEqual(owned);
    expect(me.calls.filter((c) => c.startsWith('reverse'))).toEqual([]);
    expect(routeLines(me.ctx)).toHaveLength(1);
    // Still no answer at the next check (hung, or paused in a debugger): the device gets a working route.
    expect(await me.router.ensure()).toBe(true);
    expect(table.get('tcp:9750')).toBe('tcp:9802');
    expect(table.get('tcp:9751')).toBe(`tcp:${me.router.localPort}`);
    expect(me.router.heldBy).toBeUndefined();
  });

  it('a port that only accepts and never answers is not taken at the first check either', async () => {
    shortProbes(200);
    const table: Table = new Map([
      ['tcp:9751', `tcp:${await tcpListener()}`],
      ['tcp:9750', `tcp:${await rawServer(() => undefined)}`],
    ]);
    const before = [...table];
    const me = await instance(table, 9802);
    expect(await me.router.ensure()).toBe(false);
    expect([...table]).toEqual(before);
    expect(await me.router.ensure()).toBe(true);
    expect(table.get('tcp:9750')).toBe('tcp:9802');
  });
});

describe('AdbReverseRouter keeps explaining a yielded route', () => {
  /** ctx.onLogs as the hub calls it: every stored batch, all devices. */
  function tapLogs(ctx: FakeCtx) {
    const taps = new Set<(entries: LogEntry[]) => void>();
    ctx.onLogs = (listener) => {
      taps.add(listener);
      return () => {
        taps.delete(listener);
      };
    };
    const emit = (id: number) => {
      const entry = { id, ts: Date.now(), deviceId: 'ios:x', source: 'device', level: 'info', message: 'x' } as LogEntry;
      for (const t of taps) t([entry]);
    };
    return { taps, emit };
  }

  async function yielded() {
    const otherHttp = await healthServer();
    const table: Table = new Map([
      ['tcp:9751', `tcp:${await tcpListener()}`],
      ['tcp:9750', `tcp:${otherHttp}`],
    ]);
    const me = await instance(table, 9802);
    return { me, table, otherHttp };
  }

  it('pushes the line again once the shared log ring has evicted it', async () => {
    const { me, table } = await yielded();
    me.ctx.setSettings({ maxLogEntries: 1000 });
    const logs = tapLogs(me.ctx);
    expect(await me.router.ensure()).toBe(false);
    expect(routeLines(me.ctx)).toHaveLength(1);
    expect(logs.taps.size).toBe(1);
    const firstId = me.ctx.hub.system.length; // FakeHub ids count up from 1
    logs.emit(firstId + 999); // 999 newer lines: ours is still in the ring
    await me.router.ensure();
    expect(routeLines(me.ctx)).toHaveLength(1);
    logs.emit(firstId + 1000); // e.g. ~3 min of a busy iPhone's syslog
    await me.router.ensure();
    expect(routeLines(me.ctx)).toHaveLength(2);
    await me.router.ensure();
    expect(routeLines(me.ctx)).toHaveLength(2); // the new line is the newest again
    // The route becomes ours: no more taps.
    table.clear();
    expect(await me.router.ensure()).toBe(true);
    expect(logs.taps.size).toBe(0);
  });

  it('pushes the line again after routeNoticeRepeatMs while still yielding ("clear logs" may have removed it)', async () => {
    const saved = REVERSE_TIMING.routeNoticeRepeatMs;
    REVERSE_TIMING.routeNoticeRepeatMs = 80;
    closers.push(async () => {
      REVERSE_TIMING.routeNoticeRepeatMs = saved;
    });
    const { me, otherHttp } = await yielded();
    const logs = tapLogs(me.ctx);
    await me.router.ensure();
    await me.router.ensure();
    expect(routeLines(me.ctx)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    await me.router.ensure();
    await me.router.ensure();
    expect(routeLines(me.ctx).map((l) => l.input.params)).toEqual([{ port: otherHttp }, { port: otherHttp }]);
    await me.router.stop(false);
    expect(logs.taps.size).toBe(0);
  });
});
