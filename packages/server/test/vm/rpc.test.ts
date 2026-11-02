import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { connectVmService, probeVmService, RpcCodes, RpcError, type VmServiceClient } from '../../src/platform/flutterVm/rpc';

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface FakeServerOptions {
  /** Raw HTTP status line for WebSocket upgrades (e.g. "302 Found"), with an optional Location. */
  upgradeStatus?: string;
  upgradeLocation?: string;
  /** Location for a 302 on GET of the root (DDS active). */
  rootLocation?: string;
  /** Collects the path of every plain HTTP request. */
  httpPaths?: string[];
}

interface FakeServer {
  port: number;
  sockets: Set<ServerSocket>;
  close(): Promise<void>;
}

const servers: FakeServer[] = [];
const clients: VmServiceClient[] = [];

async function startFake(onRequest: (req: RpcRequest, ws: ServerSocket) => void, opts: FakeServerOptions = {}): Promise<FakeServer> {
  const sockets = new Set<ServerSocket>();
  const server = http.createServer((req, res) => {
    opts.httpPaths?.push(req.url ?? '');
    if (opts.rootLocation) {
      res.writeHead(302, { location: opts.rootLocation });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('This VM does not have a registered Dart Development Service (DDS) instance and is not currently serving Dart DevTools.');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (opts.upgradeStatus) {
      const location = opts.upgradeLocation ? `Location: ${opts.upgradeLocation}\r\n` : '';
      socket.end(`HTTP/1.1 ${opts.upgradeStatus}\r\n${location}Content-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => onRequest(JSON.parse(String(data)) as RpcRequest, ws));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const fake: FakeServer = {
    port,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
  servers.push(fake);
  return fake;
}

const reply = (ws: ServerSocket, id: string, result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
const notify = (ws: ServerSocket, streamId: string, event: Record<string, unknown>) =>
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params: { streamId, event } }));

async function connect(port: number, path = '/tok12345=/'): Promise<VmServiceClient> {
  const c = await connectVmService(`http://127.0.0.1:${port}${path}`, { requestTimeoutMs: 2000 });
  clients.push(c);
  return c;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('VmServiceClient', () => {
  it('correlates replies by id and maps VM errors', async () => {
    const vm = await startFake((req, ws) => {
      if (req.method === 'getVersion') reply(ws, req.id, { type: 'Version', major: 4, minor: 20 });
      if (req.method === 'getObject') {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32602, message: 'Invalid params', data: { details: "getObject: invalid 'objectId' parameter: objects/9" } },
          }),
        );
      }
    });
    const c = await connect(vm.port);
    expect(c.url).toBe(`ws://127.0.0.1:${vm.port}/tok12345=/ws`);
    expect(c.redirected).toBe(false);
    const [version, failure] = await Promise.all([
      c.call('getVersion'),
      c.call('getObject', { objectId: 'objects/9' }).catch((e: unknown) => e),
    ]);
    expect(version).toEqual({ type: 'Version', major: 4, minor: 20 });
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as RpcError).code).toBe(RpcCodes.invalidParams);
    expect((failure as RpcError).details).toBe("getObject: invalid 'objectId' parameter: objects/9");
    expect((failure as RpcError).message).toContain('Invalid params');
  });

  it('times out per call and ignores late replies', async () => {
    let late: (() => void) | undefined;
    const vm = await startFake((req, ws) => {
      if (req.method === 'slow') late = () => reply(ws, req.id, { late: true });
      if (req.method === 'fast') reply(ws, req.id, { ok: true });
    });
    const c = await connect(vm.port);
    const err = await c.call('slow', {}, 50).catch((e: unknown) => e);
    expect((err as RpcError).code).toBe(RpcCodes.timeout);
    late?.();
    expect(await c.call('fast')).toEqual({ ok: true });
  });

  it('flags events that arrive while streamListen is pending as history (DDS replay)', async () => {
    const vm = await startFake((req, ws) => {
      if (req.method !== 'streamListen') return;
      if (req.params.streamId === 'Logging') {
        notify(ws, 'Logging', { kind: 'Logging', timestamp: 1 });
        notify(ws, 'Logging', { kind: 'Logging', timestamp: 2 });
        reply(ws, req.id, { type: 'Success' });
        notify(ws, 'Logging', { kind: 'Logging', timestamp: 3 });
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 103, message: 'Stream already subscribed' } }));
      }
    });
    const c = await connect(vm.port);
    const seen: [number | undefined, boolean][] = [];
    c.onEvent((stream, event, meta) => stream === 'Logging' && seen.push([event.timestamp, meta.historical]));
    await c.streamListen('Logging');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    await expect(c.streamListen('Extension')).resolves.toBeUndefined(); // 103 = already subscribed = fine
  });

  it('sends extension parameters as strings', async () => {
    const received: RpcRequest[] = [];
    const vm = await startFake((req, ws) => {
      received.push(req);
      reply(ws, req.id, { type: 'HttpTimelineLoggingState', enabled: true });
    });
    const c = await connect(vm.port);
    await c.callExtension('ext.dart.io.getHttpProfile', 'isolates/1', { updatedSince: 1793610561119707, enabled: true, skip: undefined });
    expect(received[0]!.params).toEqual({ isolateId: 'isolates/1', updatedSince: '1793610561119707', enabled: 'true' });
  });

  it('rejects pending calls when the VM goes away and reports who closed', async () => {
    const vm = await startFake((req, ws) => {
      if (req.method === 'hang') setTimeout(() => ws.terminate(), 20);
    });
    const c = await connect(vm.port);
    const closes: boolean[] = [];
    c.onClose((info) => closes.push(info.local));
    const err = await c.call('hang', {}, 5000).catch((e: unknown) => e);
    expect((err as RpcError).code).toBe(RpcCodes.closed);
    expect(closes).toEqual([false]);
    expect(c.closed).toBe(true);
    await expect(c.call('getVM')).rejects.toMatchObject({ code: RpcCodes.closed });

    const vm2 = await startFake(() => {});
    const c2 = await connect(vm2.port);
    const closes2: boolean[] = [];
    c2.onClose((info) => closes2.push(info.local));
    await c2.close();
    expect(closes2).toEqual([true]);
  });
});

describe('connectVmService', () => {
  it('follows the VM service → DDS redirect and normalizes the target', async () => {
    const dds = await startFake((req, ws) => {
      if (req.method === 'getSupportedProtocols') {
        reply(ws, req.id, {
          type: 'ProtocolList',
          protocols: [
            { protocolName: 'VM Service', major: 4, minor: 20 },
            { protocolName: 'DDS', major: 2, minor: 1 },
          ],
        });
      }
    });
    const vm = await startFake(() => {}, { upgradeStatus: '302 Found', upgradeLocation: `http://127.0.0.1:${dds.port}/qbokSmrYPWk=/` });
    const c = await connect(vm.port, '/EVgSrEEqGvY=/');
    expect(c.redirected).toBe(true);
    expect(c.url).toBe(`ws://127.0.0.1:${dds.port}/qbokSmrYPWk=/ws`);
    expect(await c.isDds()).toBe(true);
  });

  it('gives a clear error for refused upgrades and redirect loops', async () => {
    const forbidden = await startFake(() => {}, { upgradeStatus: '403 Forbidden' });
    await expect(connect(forbidden.port)).rejects.toThrow(/HTTP 403/);
    const loop = await startFake(() => {}, { upgradeStatus: '302 Found', upgradeLocation: '/tok12345=/' });
    await expect(connectVmService(`http://127.0.0.1:${loop.port}/tok12345=/`, { maxRedirects: 2 })).rejects.toThrow(/Too many redirects/);
  });
});

describe('probeVmService', () => {
  it('detects DDS from the root redirect (never touches /ws)', async () => {
    const paths: string[] = [];
    const vm = await startFake(() => {}, {
      rootLocation: 'http://127.0.0.1:49232/qbokSmrYPWk=/devtools/?uri=ws%3A%2F%2F127.0.0.1%3A49232%2FqbokSmrYPWk%3D%2Fws',
      httpPaths: paths,
    });
    const result = await probeVmService(`ws://127.0.0.1:${vm.port}/EVgSrEEqGvY=/ws`);
    expect(result).toEqual({ kind: 'dds', wsUrl: 'ws://127.0.0.1:49232/qbokSmrYPWk=/ws' });
    // A plain GET of /<token>=/ws kills a raw Dart VM service (verified on 3.10): only the root is probed.
    expect(paths).toEqual(['/EVgSrEEqGvY=/']);
  });

  it('reports a plain VM service and unreachable addresses', async () => {
    const vm = await startFake(() => {});
    expect(await probeVmService(`http://127.0.0.1:${vm.port}/EVgSrEEqGvY=/`)).toEqual({ kind: 'vm', status: 200 });
    const free = net.createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
    const port = (free.address() as net.AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    const unreachable = await probeVmService(`ws://127.0.0.1:${port}/x1234=/ws`, 1000);
    expect(unreachable.kind).toBe('unreachable');
  });
});
