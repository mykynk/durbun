/** Shared fixtures for hub / SDK / demo tests. */
import net from 'node:net';
import type { AppSession, DeviceInfo, SdkHello, ServerSettings, ServerToSdk } from '@durbun/protocol';
import { DEFAULT_SETTINGS } from '@durbun/protocol';
import { createHub } from '../../src/hub/index';
import type { Hub, HubChange } from '../../src/types';
import { silentLogger } from '../../src/util/logger';

export function makeSettings(patch: Partial<ServerSettings> = {}): ServerSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

export function makeHub(patch: Partial<ServerSettings> = {}): Hub {
  return createHub({ settings: makeSettings(patch), logger: silentLogger });
}

export function device(id: string, patch: Partial<DeviceInfo> = {}): DeviceInfo {
  const now = Date.now();
  return {
    id,
    platform: 'android',
    kind: 'physical',
    name: 'Pixel 8',
    model: 'Pixel 8',
    osVersion: '15',
    connection: 'usb',
    state: 'online',
    logs: { status: 'streaming', via: 'logcat' },
    actions: ['screenshot'],
    firstSeen: now,
    lastSeen: now,
    ...patch,
  };
}

export function appInput(deviceId: string, patch: Partial<Omit<AppSession, 'id' | 'stats'>> = {}): Omit<AppSession, 'id' | 'stats'> {
  return {
    sessionKey: 'session-1',
    deviceId,
    sdk: { name: 'durbun_flutter', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.1', pid: 8421 },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: Date.now(),
    capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'commands'],
    actions: [],
    ...patch,
  };
}

export function hello(patch: Partial<SdkHello> = {}): SdkHello {
  return {
    type: 'hello',
    protocol: 1,
    sdk: { name: 'durbun_flutter', version: '0.1.0', platform: 'flutter' },
    app: { name: 'Pati', id: 'com.mykynk.pati', version: '2.4.1', pid: 8421 },
    device: { platform: 'android', model: 'Pixel 8', name: 'Pixel 8', osVersion: '15', apiLevel: 35, isPhysical: true },
    session: 'launch-abc',
    capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'commands'],
    actions: [],
    ts: Date.now(),
    ...patch,
  };
}

/** Collects every HubChange delivered to subscribers. */
export function collectChanges(hub: Hub): { changes: HubChange[]; stop: () => void; all: () => HubChange } {
  const changes: HubChange[] = [];
  const stop = hub.subscribe((c) => changes.push(c));
  return {
    changes,
    stop,
    all: () => ({
      logs: changes.flatMap((c) => c.logs),
      network: changes.flatMap((c) => c.network),
      devices: changes.flatMap((c) => c.devices),
      removedDevices: changes.flatMap((c) => c.removedDevices),
      apps: changes.flatMap((c) => c.apps),
      metrics: changes.flatMap((c) => c.metrics),
      processes: changes.flatMap((c) => c.processes),
    }),
  };
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 3000, stepMs = 10): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Minimal NDJSON client for a raw TCP SDK connection. */
export class NdjsonClient {
  readonly received: ServerToSdk[] = [];
  closed = false;
  private buffer = '';

  constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.received.push(JSON.parse(line) as ServerToSdk);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {});
  }

  static async connect(port: number): Promise<NdjsonClient> {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    return new NdjsonClient(socket);
  }

  send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  writeRaw(data: string | Buffer): void {
    this.socket.write(data);
  }

  async next<T extends ServerToSdk['type']>(type: T, timeoutMs = 3000): Promise<Extract<ServerToSdk, { type: T }>> {
    return waitFor(() => this.received.find((m) => m.type === type) as Extract<ServerToSdk, { type: T }> | undefined, timeoutMs);
  }

  all<T extends ServerToSdk['type']>(type: T): Extract<ServerToSdk, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<ServerToSdk, { type: T }>[];
  }

  close(): void {
    this.socket.destroy();
  }
}
