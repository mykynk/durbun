/**
 * Android driver: polls `adb devices -l` every 2 s (after `adb start-server`) and runs one
 * AndroidDeviceSession per serial. Degrades to "unavailable" when adb is missing.
 */
import type { DeviceActionId, DeviceActionResult, DriverStatus, ServerSettings, ToolCheck } from '@durbun/protocol';
import type { DeviceDriver, DriverContext, Logger, PortForward } from '../../types';
import { silentLogger } from '../../util/logger';
import { failureText } from '../exec';
import { fail } from '../shared/files';
import { Poller } from '../shared/timing';
import { resolveAdb, type ResolvedTool } from '../tools';
import { Adb } from './adb';
import { createDropboxCursor, type DropboxCursor } from './dropbox';
import { parseAdbDevices } from './parsers';
import { AndroidDeviceSession } from './session';

const POLL_MS = 2000;
const ADB_FIX = 'brew install --cask android-platform-tools';
const ADB_DOCS = 'https://developer.android.com/tools/releases/platform-tools';

export class AndroidDriver implements DeviceDriver {
  readonly id = 'android' as const;
  private ctx?: DriverContext;
  private logger: Logger = silentLogger;
  private adb: Adb | null = null;
  private adbVersion?: string;
  private adbProblem?: string;
  private pollProblem?: string;
  private pollFailures = 0;
  private polls = 0;
  private poller?: Poller;
  private running = false;
  private readonly sessions = new Map<string, AndroidDeviceSession>();
  /** Dropbox records already reported, per serial — a replugged phone does not repeat old crashes. */
  private readonly dropboxCursors = new Map<string, DropboxCursor>();
  private unsubSettings?: () => void;
  private adbPathSetting?: string;

  async start(ctx: DriverContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.logger = ctx.logger.child('android');
    this.running = true;
    this.adbPathSetting = ctx.settings().adbPath;
    await this.initAdb(ctx.settings());
    this.unsubSettings = ctx.onSettings((s) => void this.onSettings(s));
    this.poller = new Poller(() => this.poll(), POLL_MS, this.logger, 'adb devices');
    this.poller.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubSettings?.();
    this.unsubSettings = undefined;
    await this.poller?.stop();
    this.poller = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.dispose('stopped')));
  }

  status(): DriverStatus {
    const base = { id: this.id, active: this.running };
    if (!this.adb) {
      return {
        ...base,
        available: false,
        detail: this.adbProblem ?? 'adb was not found — install Android platform-tools to see Android devices',
        code: 'logs.adbMissing',
      };
    }
    if (this.adbProblem || this.pollProblem) {
      return { ...base, available: !this.adbProblem, detail: this.adbProblem ?? this.pollProblem, code: 'driver.adbError' };
    }
    const n = [...this.sessions.values()].filter((s) => s.isOnline).length;
    const adb = this.adbVersion ? `adb ${this.adbVersion}` : 'adb';
    return { ...base, available: true, detail: `${adb} · ${n} device${n === 1 ? '' : 's'} online` };
  }

  async checks(): Promise<ToolCheck[]> {
    const settings = this.ctx?.settings() ?? { adbPath: undefined };
    const tool = resolveAdb(settings);
    const label = 'Android Debug Bridge (adb)';
    if (!tool) {
      return [
        {
          id: 'adb',
          label,
          status: 'missing',
          detail: 'adb not found (settings.adbPath, $ANDROID_HOME, ~/Library/Android/sdk/platform-tools, PATH)',
          fix: ADB_FIX,
          docsUrl: ADB_DOCS,
        },
      ];
    }
    const version = await new Adb(tool).version();
    return [
      {
        id: 'adb',
        label,
        status: version ? (tool.detail ? 'warn' : 'ok') : 'error',
        ...(version ? { version } : {}),
        path: tool.path,
        detail: version ? (tool.detail ?? sourceText(tool)) : `${tool.path} exists but "adb version" failed`,
        ...(version ? {} : { fix: ADB_FIX, docsUrl: ADB_DOCS }),
      },
    ];
  }

  owns(deviceId: string): boolean {
    return deviceId.startsWith('android:');
  }

  async runAction(deviceId: string, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
    const session = this.sessionFor(deviceId);
    if (!session) return fail(`Unknown Android device ${deviceId}`, 'action.deviceNotFound');
    try {
      return await session.runAction(action, params ?? {});
    } catch (e) {
      return fail(`${action} failed: ${(e as Error).message}`);
    }
  }

  watchMetrics(deviceId: string, target: { pid?: number; processName?: string }, enabled: boolean): void {
    this.sessionFor(deviceId)?.watchMetrics(target, enabled);
  }

  /** PlatformServices.forwardToDevice for android:<serial>. */
  async forward(deviceId: string, devicePort: number): Promise<PortForward> {
    const session = this.sessionFor(deviceId);
    if (session) return session.forward(devicePort);
    // Not tracked (driver not started): use adb directly.
    const tool = this.adb?.tool ?? resolveAdb(this.ctx?.settings() ?? { adbPath: undefined });
    if (!tool) throw new Error('adb is not available');
    const adb = new Adb(tool);
    const serial = deviceId.slice('android:'.length);
    const r = await adb.forward(serial, devicePort);
    if (!r.port) throw new Error(`adb forward to device port ${devicePort} failed: ${r.error ?? 'unknown error'}`);
    const port = r.port;
    return { host: '127.0.0.1', port, dispose: async () => void (await adb.forwardRemove(serial, port)) };
  }

  /* ───────────── internals ───────────── */

  private sessionFor(deviceId: string): AndroidDeviceSession | undefined {
    if (!this.owns(deviceId)) return undefined;
    return this.sessions.get(deviceId.slice('android:'.length));
  }

  private async initAdb(settings: ServerSettings): Promise<void> {
    const tool = resolveAdb(settings);
    this.adbProblem = undefined;
    if (!tool) {
      this.adb = null;
      this.adbVersion = undefined;
      this.logger.info('adb not found; Android devices are unavailable');
      return;
    }
    const adb = new Adb(tool);
    const version = await adb.version();
    if (!version) {
      this.adb = adb;
      this.adbProblem = `${tool.path} exists but "adb version" failed`;
      return;
    }
    this.adb = adb;
    this.adbVersion = version;
    const r = await adb.startServer();
    if (!r.ok) this.logger.warn(`adb start-server failed: ${failureText(r)}`);
    this.logger.debug(`using adb ${version} at ${tool.path} (${tool.source})`);
  }

  private async onSettings(s: ServerSettings): Promise<void> {
    if (!this.running || s.adbPath === this.adbPathSetting) return;
    this.adbPathSetting = s.adbPath;
    const before = this.adb?.path;
    const next: ResolvedTool | null = resolveAdb(s);
    if (next?.path === before && !this.adbProblem) return;
    // adb changed: drop every device and rediscover with the new binary.
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((x) => x.dispose('stopped')));
    await this.initAdb(s);
    this.poller?.trigger();
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.ctx) return;
    this.polls += 1;
    if (!this.adb || this.adbProblem) {
      // Re-resolve now and then so installing platform-tools needs no restart.
      if (this.polls % 15 === 1) await this.initAdb(this.ctx.settings());
      if (!this.adb || this.adbProblem) return;
    }
    const adb = this.adb;
    const r = await adb.devices();
    if (!this.running) return;
    if (!r.ok) {
      this.pollFailures += 1;
      this.pollProblem = `adb devices failed: ${failureText(r)}`;
      if (this.pollFailures === 3) {
        this.logger.warn(this.pollProblem);
        // adb is broken: treat every device as gone until it recovers.
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.all(sessions.map((s) => s.dispose('disconnected')));
      }
      return;
    }
    this.pollFailures = 0;
    this.pollProblem = undefined;
    const rows = parseAdbDevices(r.stdout);
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.serial);
      let session = this.sessions.get(row.serial);
      if (!session) {
        let cursor = this.dropboxCursors.get(row.serial);
        if (!cursor) this.dropboxCursors.set(row.serial, (cursor = createDropboxCursor()));
        session = new AndroidDeviceSession(
          { ctx: this.ctx, adb: () => this.adb, logger: this.logger, dropboxCursor: cursor },
          row,
        );
        this.sessions.set(row.serial, session);
        session.announce();
        this.logger.info(`Android device attached: ${row.serial} (${row.state})`);
      }
      void session.update(row);
    }
    for (const [serial, session] of [...this.sessions]) {
      if (seen.has(serial)) continue;
      this.sessions.delete(serial);
      this.logger.info(`Android device detached: ${serial}`);
      await session.dispose('disconnected');
    }
  }
}

function sourceText(tool: ResolvedTool): string {
  switch (tool.source) {
    case 'settings':
      return 'from settings.adbPath';
    case 'env':
      return 'from $ANDROID_HOME / $ANDROID_SDK_ROOT';
    case 'sdk':
      return 'from ~/Library/Android/sdk';
    case 'path':
      return 'from PATH';
    default:
      return tool.source;
  }
}
