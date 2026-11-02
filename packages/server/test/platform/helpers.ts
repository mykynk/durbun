/** Test doubles for HubSink / DriverContext used by the platform tests. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import {
  DEFAULT_SETTINGS,
  type DeviceApp,
  type DeviceInfo,
  type LogEntry,
  type MetricSample,
  type ProcessUpdate,
  type ServerSettings,
  type UiNotice,
} from '@durbun/protocol';
import type { DeviceLogInput, DriverContext, HubSink, SdkAttachMeta, SystemLogInput } from '../../src/types';
import { silentLogger } from '../../src/util/logger';

export interface FakeHub extends HubSink {
  devices: Map<string, DeviceInfo>;
  upserts: DeviceInfo[];
  patches: Array<{ id: string; patch: Partial<DeviceInfo> }>;
  disconnected: Array<{ id: string; detail?: string; code?: string }>;
  logs: Array<{ deviceId: string; entry: DeviceLogInput }>;
  batches: number;
  system: Array<{ deviceId: string; input: SystemLogInput }>;
  processes: Array<Omit<ProcessUpdate, 'ts'> & { ts?: number }>;
  metrics: MetricSample[];
  notices: UiNotice[];
  /** Merged device apps by key, plus every raw upsert input in order. */
  deviceApps: Map<string, DeviceApp>;
  deviceAppUpserts: Array<Parameters<HubSink['upsertDeviceApp']>[0]>;
  removedDeviceApps: Array<{ deviceId: string; ids?: string[] }>;
}

export function createFakeHub(): FakeHub {
  let nextId = 1;
  const hub: FakeHub = {
    devices: new Map(),
    upserts: [],
    patches: [],
    disconnected: [],
    logs: [],
    batches: 0,
    system: [],
    processes: [],
    metrics: [],
    notices: [],
    deviceApps: new Map(),
    deviceAppUpserts: [],
    removedDeviceApps: [],
    upsertDeviceApp(input) {
      hub.deviceAppUpserts.push(structuredClone(input));
      const key = `${input.deviceId}|${input.id}`;
      const prev = hub.deviceApps.get(key);
      const { crashReportsDelta, ...rest } = input;
      const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const next: DeviceApp = {
        key,
        buildType: 'unknown',
        install: { source: 'unknown' },
        pids: [],
        running: false,
        ...prev,
        ...structuredClone(defined),
        lastActivity: Math.max(prev?.lastActivity ?? 0, input.lastActivity ?? Date.now()),
        ...(crashReportsDelta || prev?.crashReports ? { crashReports: (prev?.crashReports ?? 0) + (crashReportsDelta ?? 0) } : {}),
      } as DeviceApp;
      hub.deviceApps.set(key, next);
      return next;
    },
    removeDeviceApps(deviceId, ids) {
      hub.removedDeviceApps.push({ deviceId, ...(ids ? { ids: [...ids] } : {}) });
      for (const key of [...hub.deviceApps.keys()]) {
        const app = hub.deviceApps.get(key)!;
        if (app.deviceId === deviceId && (!ids || ids.includes(app.id))) hub.deviceApps.delete(key);
      }
    },
    upsertDevice(device) {
      hub.upserts.push(structuredClone(device));
      hub.devices.set(device.id, { ...hub.devices.get(device.id), ...structuredClone(device) });
    },
    patchDevice(id, patch) {
      hub.patches.push({ id, patch: structuredClone(patch) });
      const d = hub.devices.get(id);
      if (d) hub.devices.set(id, { ...d, ...structuredClone(patch) });
    },
    markDeviceDisconnected(id, detail, code) {
      hub.disconnected.push({ id, detail, code });
      const d = hub.devices.get(id);
      if (d) hub.devices.set(id, { ...d, state: 'disconnected' });
    },
    pushDeviceLogs(deviceId, entries) {
      hub.batches += 1;
      for (const entry of entries) hub.logs.push({ deviceId, entry });
    },
    setProcess(update) {
      hub.processes.push(update);
    },
    pushSystemLog(deviceId, input) {
      hub.system.push({ deviceId, input });
      const entry: LogEntry = {
        id: nextId++,
        ts: Date.now(),
        deviceId,
        source: 'system',
        level: input.level ?? 'info',
        tag: 'durbun',
        message: input.message,
        ...(input.code ? { code: input.code } : {}),
      };
      return entry;
    },
    pushMetrics(samples) {
      hub.metrics.push(...samples);
    },
    notice(n) {
      hub.notices.push(n);
    },
  };
  return hub;
}

export interface FakeCtx extends DriverContext {
  hub: FakeHub;
  attached: Array<{ stream: Duplex; meta: SdkAttachMeta }>;
  setSettings(patch: Partial<ServerSettings>): void;
}

const createdTempDirs: string[] = [];
function cleanupTempDirs(): void {
  for (const d of createdTempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
try {
  // Registered for the importing test file (vitest isolates modules per file).
  afterAll(cleanupTempDirs);
} catch {
  // Imported outside vitest (manual verification scripts).
  process.once('exit', cleanupTempDirs);
}

export function createCtx(opts: { settings?: Partial<ServerSettings>; tempDir?: string } = {}): FakeCtx {
  const hub = createFakeHub();
  let settings: ServerSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const listeners = new Set<(s: ServerSettings) => void>();
  let tempDir = opts.tempDir;
  if (!tempDir) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durbun-platform-test-'));
    createdTempDirs.push(tempDir);
  }
  const attached: FakeCtx['attached'] = [];
  return {
    hub,
    attached,
    getDevices: () => [...hub.devices.values()],
    getApps: () => [],
    getDeviceApps: () => [...hub.deviceApps.values()],
    onLogs: () => () => {},
    sdk: {
      attachStream(stream, meta) {
        attached.push({ stream, meta });
      },
      openVirtual() {
        throw new Error('not used in platform tests');
      },
    },
    settings: () => settings,
    onSettings(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSettings(patch) {
      settings = { ...settings, ...patch };
      for (const l of listeners) l(settings);
    },
    logger: silentLogger,
    tempDir,
    fileUrl: (name) => `/api/files/${encodeURIComponent(name)}`,
    ports: { http: 9750, sdk: 9751 },
  };
}

/** Poll until `fn` returns truthy (or throw after `timeoutMs`). */
export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 8000, stepMs = 25): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}
