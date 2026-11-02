/** Test doubles for the Flutter VM module: a DriverContext whose SDK layer records virtual sessions. */
import os from 'node:os';
import type {
  AppSession,
  DeviceInfo,
  LogEntry,
  SdkCommandResult,
  SdkConfig,
  SdkHello,
  SdkToServer,
  ServerSettings,
  ServerToSdk,
  UiNotice,
} from '@durbun/protocol';
import { DEFAULT_SETTINGS } from '@durbun/protocol';
import type {
  DriverContext,
  Logger,
  PlatformServices,
  PortForward,
  SdkAttachMeta,
  SystemLogInput,
  VirtualSdkSession,
} from '../../src/types';

export const testLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => testLogger,
};

/** Logger that records lines (`level message`); DURBUN_TEST_VERBOSE=1 also prints them. */
export function recordingLogger(lines: string[]): Logger {
  const write = (level: string) => (message: string, ...args: unknown[]) => {
    const line = `${level} ${message}${args.length ? ' ' + args.map(String).join(' ') : ''}`;
    lines.push(line);
    if (process.env.DURBUN_TEST_VERBOSE) console.log(line);
  };
  const logger: Logger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
  };
  return logger;
}

export class FakeVirtualSession implements VirtualSdkSession {
  readonly messages: SdkToServer[] = [];
  readonly appId: Promise<string>;
  closed = false;
  closeReason?: string;
  private readonly listeners = new Set<(m: ServerToSdk) => void>();
  private resolveAppId!: (id: string) => void;
  private nextCommand = 1;

  constructor(
    readonly meta: SdkAttachMeta,
    private readonly owner: FakeContext,
    readonly assignedAppId: string,
  ) {
    this.appId = new Promise((resolve) => (this.resolveAppId = resolve));
  }

  send(message: SdkToServer): void {
    if (this.closed) throw new Error('virtual session closed');
    this.messages.push(message);
    if (message.type === 'hello') {
      this.owner.registerApp(this, message);
      queueMicrotask(() => {
        this.deliver({
          type: 'welcome',
          protocol: 1,
          server: 'durbun/test',
          appId: this.assignedAppId,
          config: this.owner.config,
          mocks: [],
        });
        this.resolveAppId(this.assignedAppId);
      });
    }
  }

  onMessage(listener: (message: ServerToSdk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(reason?: string): void {
    this.closed = true;
    this.closeReason = reason;
    const app = this.owner.apps.find((a) => a.id === this.assignedAppId);
    if (app) app.connected = false;
  }

  deliver(message: ServerToSdk): void {
    for (const l of [...this.listeners]) l(message);
  }

  /** Send a command like the SDK layer does and wait for the command.result. */
  async command(name: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<SdkCommandResult> {
    const id = `c${this.nextCommand++}`;
    const before = this.messages.length;
    this.deliver({ type: 'command', id, name, ...(params ? { params } : {}) });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = this.messages
        .slice(before)
        .find((m): m is SdkCommandResult => m.type === 'command.result' && m.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`command ${name} timed out`);
  }

  ofType<T extends SdkToServer['type']>(type: T): Extract<SdkToServer, { type: T }>[] {
    return this.messages.filter((m) => m.type === type) as Extract<SdkToServer, { type: T }>[];
  }
}

export interface FakeContext extends DriverContext {
  platform: PlatformServices;
  config: SdkConfig;
  apps: AppSession[];
  devices: DeviceInfo[];
  virtuals: FakeVirtualSession[];
  systemLogs: { deviceId: string; input: SystemLogInput }[];
  notices: UiNotice[];
  forwards: { deviceId: string; port: number; disposed: boolean }[];
  /** Device port → local port the fake forward returns (identity when absent). */
  forwardPortMap: Map<number, number>;
  settingsValue: ServerSettings;
  /** Internal diagnostics written by the module. */
  logLines: string[];
  emitLogs(entries: LogEntry[]): void;
  registerApp(session: FakeVirtualSession, hello: SdkHello): void;
}

export function createFakeContext(overrides: Partial<SdkConfig> = {}): FakeContext {
  const logListeners = new Set<(entries: LogEntry[]) => void>();
  let appCounter = 0;
  const logLines: string[] = [];
  const ctx: FakeContext = {
    logLines,
    config: {
      captureBodies: true,
      maxBodyBytes: 1_048_576,
      metricsIntervalMs: 500,
      deviceLogsAvailable: false,
      ...overrides,
    },
    apps: [],
    devices: [],
    virtuals: [],
    systemLogs: [],
    notices: [],
    forwards: [],
    forwardPortMap: new Map(),
    settingsValue: { ...DEFAULT_SETTINGS, metricsIntervalMs: 500 },
    hub: {
      upsertDevice: () => {},
      patchDevice: () => {},
      markDeviceDisconnected: () => {},
      pushDeviceLogs: () => {},
      setProcess: () => {},
      pushSystemLog: (deviceId, input) => {
        ctx.systemLogs.push({ deviceId, input });
        return {
          id: ctx.systemLogs.length,
          ts: Date.now(),
          deviceId,
          source: 'system',
          level: input.level ?? 'info',
          tag: 'durbun',
          message: input.message,
        };
      },
      pushMetrics: () => {},
      notice: (n) => {
        ctx.notices.push(n);
      },
    },
    getDevices: () => ctx.devices,
    getApps: () => ctx.apps,
    onLogs: (listener) => {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    sdk: {
      attachStream: () => {},
      openVirtual: (meta) => {
        const v = new FakeVirtualSession(meta, ctx, `app:${++appCounter}`);
        ctx.virtuals.push(v);
        return v;
      },
    },
    settings: () => ctx.settingsValue,
    onSettings: () => () => {},
    logger: recordingLogger(logLines),
    tempDir: os.tmpdir(),
    fileUrl: (name) => `/api/files/${name}`,
    ports: { http: 9750, sdk: 9751 },
    platform: {
      forwardToDevice: async (deviceId: string, port: number): Promise<PortForward> => {
        const record = { deviceId, port, disposed: false };
        ctx.forwards.push(record);
        return {
          host: '127.0.0.1',
          port: ctx.forwardPortMap.get(port) ?? port,
          dispose: async () => {
            record.disposed = true;
          },
        };
      },
    },
    emitLogs: (entries) => {
      for (const l of [...logListeners]) l(entries);
    },
    registerApp: (session, hello) => {
      ctx.apps.push({
        id: session.assignedAppId,
        sessionKey: hello.session,
        deviceId: session.meta.deviceId ?? 'net:other-dart-vm',
        sdk: hello.sdk,
        app: hello.app,
        transport: session.meta.transport,
        connected: true,
        connectedAt: Date.now(),
        capabilities: hello.capabilities,
        actions: hello.actions ?? [],
        stats: { logs: 0, requests: 0, errors: 0 },
      });
    },
  };
  return ctx;
}

export async function waitFor<T>(
  probe: () => T | undefined | false,
  timeoutMs: number,
  label: string,
  intervalMs = 25,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
