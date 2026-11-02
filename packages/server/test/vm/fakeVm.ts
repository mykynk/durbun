/**
 * Scripted Dart VM service (JSON-RPC over WebSocket) for session tests that a Dart CLI cannot drive:
 * hot restarts, Flutter extensions, paused isolates, profile-mode builds. Shapes follow the recorded
 * Dart 3.10 responses in fixtures/.
 */
import http from 'node:http';
import type net from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

export interface FakeIsolate {
  id: string;
  name: string;
  extensions: string[];
  rootLib?: string;
  libraries?: string[];
  paused?: boolean;
}

interface Client {
  ws: ServerSocket;
  streams: Set<string>;
}

export const FLUTTER_DEBUG_EXTENSIONS = [
  'ext.dart.io.httpEnableTimelineLogging',
  'ext.dart.io.getHttpProfile',
  'ext.dart.io.getHttpProfileRequest',
  'ext.dart.io.clearHttpProfile',
  'ext.flutter.debugPaint',
  'ext.flutter.repaintRainbow',
  'ext.flutter.timeDilation',
  'ext.flutter.showPerformanceOverlay',
  'ext.flutter.brightnessOverride',
  'ext.flutter.platformOverride',
  'ext.flutter.debugDumpApp',
  'ext.flutter.debugDumpRenderTree',
];

export class FakeVm {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly isolates = new Map<string, FakeIsolate>();
  pid = 4321;
  startTime = 1_793_600_000_000;
  os = 'android';
  refreshRate = 60;
  /** Per-isolate HTTP timeline logging state. */
  readonly httpLogging = new Map<string, boolean>();
  /** Flutter bool extension state (ext name → value). */
  readonly flags = new Map<string, boolean>();
  timeDilation = 1;
  platformOverride: string | undefined;
  port = 0;
  private readonly clients = new Set<Client>();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private nextIsolate = 1;

  addIsolate(partial: Partial<FakeIsolate> = {}): FakeIsolate {
    const n = this.nextIsolate++;
    const iso: FakeIsolate = {
      id: `isolates/${1000 + n}`,
      name: 'main',
      extensions: [...FLUTTER_DEBUG_EXTENSIONS],
      rootLib: 'package:pati/main.dart',
      libraries: ['dart:core', 'package:flutter/src/widgets/binding.dart', 'package:pati/main.dart'],
      ...partial,
    };
    this.isolates.set(iso.id, iso);
    return iso;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/fakeTok12=/`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('This VM does not have a registered Dart Development Service (DDS) instance and is not currently serving Dart DevTools.');
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = { ws, streams: new Set() };
        this.clients.add(client);
        ws.on('close', () => this.clients.delete(client));
        ws.on('message', (data) => this.handle(client, JSON.parse(String(data)) as { id: string; method: string; params?: Record<string, unknown> }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  /** Push an event to every client subscribed to the stream. */
  emit(streamId: string, event: Record<string, unknown>): void {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'streamNotify',
      params: { streamId, event: { type: 'Event', timestamp: Date.now(), ...event } },
    });
    for (const c of this.clients) if (c.streams.has(streamId)) c.ws.send(payload);
  }

  isolateRef(iso: FakeIsolate): Record<string, unknown> {
    return { type: '@Isolate', id: iso.id, name: iso.name, number: iso.id.split('/')[1], isSystemIsolate: false, isolateGroupId: 'isolateGroups/1' };
  }

  /** Flutter hot restart: the root isolate is replaced by a new "main" isolate. */
  hotRestart(): FakeIsolate {
    const old = [...this.isolates.values()].find((i) => i.name === 'main');
    const fresh = this.addIsolate({ extensions: ['ext.dart.io.httpEnableTimelineLogging', 'ext.dart.io.getHttpProfile'] });
    if (old) {
      this.isolates.delete(old.id);
      this.emit('Isolate', { kind: 'IsolateExit', isolate: this.isolateRef(old) });
    }
    this.emit('Isolate', { kind: 'IsolateStart', isolate: this.isolateRef(fresh) });
    this.emit('Isolate', { kind: 'IsolateRunnable', isolate: this.isolateRef(fresh) });
    for (const ext of FLUTTER_DEBUG_EXTENSIONS.slice(2)) {
      fresh.extensions.push(ext);
      this.emit('Isolate', { kind: 'ServiceExtensionAdded', isolate: this.isolateRef(fresh), extensionRPC: ext });
    }
    return fresh;
  }

  dropClients(): void {
    for (const c of this.clients) c.ws.terminate();
  }

  callsOf(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  private handle(client: Client, msg: { id: string; method: string; params?: Record<string, unknown> }): void {
    const params = msg.params ?? {};
    this.calls.push({ method: msg.method, params });
    const ok = (result: unknown) => client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    const fail = (code: number, message: string) => client.ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
    const iso = typeof params.isolateId === 'string' ? this.isolates.get(params.isolateId) : undefined;
    switch (msg.method) {
      case 'getVersion':
        return ok({ type: 'Version', major: 4, minor: 20 });
      case 'getSupportedProtocols':
        return ok({ type: 'ProtocolList', protocols: [{ protocolName: 'VM Service', major: 4, minor: 20 }] });
      case 'getVM':
        return ok({
          type: 'VM',
          pid: this.pid,
          startTime: this.startTime,
          operatingSystem: this.os,
          _currentRSS: 200 * 1024 * 1024,
          isolates: [...this.isolates.values()].map((i) => this.isolateRef(i)),
          isolateGroups: [{ type: '@IsolateGroup', id: 'isolateGroups/1', name: 'main' }],
        });
      case 'getIsolate':
        if (!iso) return ok({ type: 'Sentinel', kind: 'Collected' });
        return ok({
          type: 'Isolate',
          ...this.isolateRef(iso),
          runnable: true,
          pauseEvent: { type: 'Event', kind: iso.paused ? 'PauseBreakpoint' : 'Resume' },
          rootLib: iso.rootLib ? { type: '@Library', uri: iso.rootLib } : undefined,
          libraries: (iso.libraries ?? []).map((uri) => ({ type: '@Library', uri })),
          extensionRPCs: iso.extensions,
        });
      case 'streamListen':
        if (client.streams.has(String(params.streamId))) return fail(103, 'Stream already subscribed');
        client.streams.add(String(params.streamId));
        return ok({ type: 'Success' });
      case 'streamCancel':
        client.streams.delete(String(params.streamId));
        return ok({ type: 'Success' });
      case 'getMemoryUsage':
        return ok({ type: 'MemoryUsage', heapUsage: 50 * 1024 * 1024, heapCapacity: 64 * 1024 * 1024, externalUsage: 2 * 1024 * 1024 });
      case '_flutter.listViews':
        return ok({ type: 'FlutterViewList', views: [{ type: 'FlutterView', id: '_flutterView/0x1', isolate: { id: [...this.isolates.keys()][0] } }] });
      case '_flutter.getDisplayRefreshRate':
        return ok({ type: 'DisplayRefreshRate', fps: this.refreshRate });
      default:
        break;
    }
    if (!iso || !iso.extensions.includes(msg.method)) return fail(-32601, 'Method not found');
    switch (msg.method) {
      case 'ext.dart.io.httpEnableTimelineLogging':
        if (params.enabled !== undefined) this.httpLogging.set(iso.id, params.enabled === 'true');
        return ok({ type: 'HttpTimelineLoggingState', enabled: this.httpLogging.get(iso.id) ?? false });
      case 'ext.dart.io.getHttpProfile':
        return ok({ type: 'HttpProfile', timestamp: Date.now() * 1000, requests: [] });
      case 'ext.dart.io.clearHttpProfile':
        return ok({ type: 'Success' });
      case 'ext.flutter.timeDilation':
        if (params.timeDilation !== undefined) this.timeDilation = Number(params.timeDilation);
        return ok({ timeDilation: this.timeDilation.toFixed(1), type: '_extensionType', method: msg.method });
      case 'ext.flutter.platformOverride':
        if (params.value !== undefined) this.platformOverride = params.value === 'default' ? undefined : String(params.value);
        return ok({ value: this.platformOverride ?? 'android', type: '_extensionType', method: msg.method });
      case 'ext.flutter.brightnessOverride':
        return ok({ value: params.value === 'Brightness.dark' ? 'Brightness.dark' : 'Brightness.light', type: '_extensionType' });
      case 'ext.flutter.debugDumpApp':
      case 'ext.flutter.debugDumpRenderTree':
        return ok({ data: 'RenderView#1\n └─child: RenderBox', type: '_extensionType', method: msg.method });
      default: {
        if (params.enabled !== undefined) this.flags.set(msg.method, params.enabled === 'true');
        return ok({ enabled: this.flags.get(msg.method) ? 'true' : 'false', type: '_extensionType', method: msg.method });
      }
    }
  }
}
