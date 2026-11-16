/**
 * Android driver: follows the adb server's device list (`host:track-devices-l` over its socket, pushed on every
 * change; deviceTracker.ts) and runs one AndroidDeviceSession per phone. While that stream is down (no server
 * yet, a server restart, an old server) it polls `adb devices -l` every 2 s as before (which also starts the
 * server), and tries the stream again; while it is live a check runs only every 15 s (no adb process).
 * Degrades to "unavailable" when adb is missing.
 *
 * One phone, one device: a phone seen over USB and Wi-Fi at once (wireless debugging on, cable in) has two
 * adb serials. Rows are grouped by the phone's hardware serial (`ro.serialno`, asked once per Wi-Fi serial),
 * one transport runs the session (USB first) and the others wait; when the running one goes away the
 * session moves to the next with the same device id (`android:<hardware serial>`) and resumes logcat where
 * it stopped. A Wi-Fi serial (ip:port) changes with every wireless debugging start; the id does not.
 *
 * One adb server, never killed: before running adb the driver asks the running server its version over its
 * socket (adbServer.ts). An adb client of another version would kill that server (and the connections of
 * the program that started it, which then kills ours back). On a mismatch the driver uses an adb of the
 * server's version found on this Mac (unless settings.adbPath names one), else it waits and says why.
 */
import type { ConnectionType, DeviceActionId, DeviceActionResult, DeviceSettingOverride, DriverStatus, ServerSettings, ToolCheck } from '@durbun/protocol';
import type { DeviceDriver, DriverContext, Logger, PortForward } from '../../types';
import { silentLogger } from '../../util/logger';
import { failureText } from '../exec';
import { fail } from '../shared/files';
import { Poller } from '../shared/timing';
import { defaultResolveEnv, listAdbCandidates, resolveAdb, toolSourceCode, type ResolvedTool, type ResolveEnv } from '../tools';
import { Adb } from './adb';
import { adbBinaryInfo, adbServerPort, queryAdbServerVersion, type AdbBinaryInfo } from './adbServer';
import { AdbDeviceTracker } from './deviceTracker';
import { createDropboxCursor, type DropboxCursor } from './dropbox';
import {
  connectionForSerial,
  isGenericSerial,
  mapAdbState,
  parseAdbDevices,
  parseSerialProp,
  serialFromMdnsName,
  type AdbDeviceRow,
  type AdbServerConflict,
} from './parsers';
import { AndroidDeviceSession } from './session';

const POLL_MS = 2000;
/** While the device stream is live: the server's version is checked this often (a socket call, no process). */
const TRACK_SAFETY_MS = 15_000;
const ADB_FIX = 'brew install --cask android-platform-tools';
const ADB_DOCS = 'https://developer.android.com/tools/releases/platform-tools';
/** Wi-Fi serial → device key memory (each wireless debugging start brings a new ip:port). */
const MAX_REMEMBERED_SERIALS = 500;
/** adb binaries on this Mac are re-read at most this often while a conflict lasts. */
const CANDIDATES_TTL_MS = 60_000;

export const ADB_CONFLICT_CODE = 'driver.adbVersionConflict';
export const DEVICE_ADB_CONFLICT_CODE = 'device.adbConflict';

export interface AndroidDriverOptions {
  /** Tool lookup environment (tests). */
  resolveEnv?: ResolveEnv;
  /** Tests: shorter retry delays of the device stream. */
  trackRetryMs?: { initial: number; max: number };
}

interface Candidate {
  tool: ResolvedTool;
  info: AdbBinaryInfo;
}

interface Conflict {
  /** Version of the running server (undefined: an old adb only said "out of date"). */
  server?: number;
  /** Version of the adb Dürbün would use. */
  client?: number;
  since: number;
  /** An adb of the server's version on this Mac (settings.adbPath names another one). */
  match?: string;
  candidates: AdbBinaryInfo[];
}

export class AndroidDriver implements DeviceDriver {
  readonly id = 'android' as const;
  private ctx?: DriverContext;
  private logger: Logger = silentLogger;
  private adb: Adb | null = null;
  private adbVersion?: string;
  /** adb protocol version of `this.adb` (41 for 1.0.41). */
  private clientProtocol?: number;
  private adbProblem?: string;
  private pollProblem?: string;
  private pollFailures = 0;
  private polls = 0;
  private poller?: Poller;
  private running = false;
  /** One session per phone, by device key (hardware serial, else adb serial). */
  private readonly sessions = new Map<string, AndroidDeviceSession>();
  /** Dropbox records already reported, per device key — a replugged phone does not repeat old crashes. */
  private readonly dropboxCursors = new Map<string, DropboxCursor>();
  /** DeviceApp ids published, per device key — apps uninstalled while the phone was unplugged go at the replug. */
  private readonly publishedApps = new Map<string, Set<string>>();
  /** Settings Dürbün changed, per device key — the old values can be put back after a replug too. */
  private readonly settingOverrides = new Map<string, Map<string, DeviceSettingOverride>>();
  /** adb serial → device key, for serials whose phone had to be asked (Wi-Fi). */
  private readonly keyOfSerial = new Map<string, string>();
  private readonly resolving = new Set<string>();
  /** Hardware serial → device key of a USB session whose adb serial differs from it. */
  private readonly aliases = new Map<string, string>();
  private unsubSettings?: () => void;
  private adbPathSetting?: string;
  /** The running adb server has another version: adb is not run (it would kill that server). */
  private conflict?: Conflict;
  /** An adb of the running server's version is used instead of the resolved one. */
  private adopted?: { server: number; path: string; own: string };
  private candidatesCache?: { at: number; list: Candidate[] };
  private conflictTask?: Promise<void>;
  /** The adb server's pushed device list (null before start). */
  private tracker: AdbDeviceTracker | null = null;
  /** A new list arrived while a poll ran: apply it once more. */
  private trackDirty = false;

  constructor(private readonly options: AndroidDriverOptions = {}) {}

  private renv(): ResolveEnv {
    return this.options.resolveEnv ?? defaultResolveEnv();
  }

  async start(ctx: DriverContext): Promise<void> {
    if (this.running) return;
    this.ctx = ctx;
    this.logger = ctx.logger.child('android');
    this.running = true;
    this.adbPathSetting = ctx.settings().adbPath;
    await this.initAdb(ctx.settings());
    this.unsubSettings = ctx.onSettings((s) => void this.onSettings(s));
    this.tracker = new AdbDeviceTracker({
      port: () => adbServerPort(this.serverEnv()),
      onList: () => {
        this.trackDirty = true;
        this.poller?.trigger();
      },
      onDown: (reason) => {
        this.logger.debug(`adb device stream down (${reason}); polling adb devices`);
        this.poller?.setInterval(POLL_MS);
        this.poller?.trigger();
      },
      ...(this.options.trackRetryMs ? { retryMs: this.options.trackRetryMs } : {}),
    });
    this.poller = new Poller(() => this.poll(), POLL_MS, this.logger, 'adb devices');
    this.poller.start();
  }

  /** The Mac woke from sleep: read the device list again now and re-check every phone's streams and forwards. */
  async resume(): Promise<void> {
    if (!this.running) return;
    try {
      this.tracker?.ensure(true);
      this.poller?.trigger();
      await Promise.all([...this.sessions.values()].map((s) => s.afterWake()));
    } catch (e) {
      this.logger.debug(`android resume failed: ${(e as Error).message}`);
    }
  }

  /** Whether the device list comes from the adb server's stream right now (no polling). */
  get tracking(): boolean {
    return !!this.tracker?.live;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubSettings?.();
    this.unsubSettings = undefined;
    this.tracker?.stop();
    this.tracker = null;
    await this.poller?.stop();
    this.poller = undefined;
    await this.conflictTask;
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
    if (this.conflict) return { ...base, available: true, detail: conflictText(this.conflict, this.adb.path), code: ADB_CONFLICT_CODE };
    if (this.adbProblem || this.pollProblem) {
      return { ...base, available: !this.adbProblem, detail: this.adbProblem ?? this.pollProblem, code: 'driver.adbError' };
    }
    const n = [...this.sessions.values()].filter((s) => s.isOnline).length;
    const adb = this.adbVersion ? `adb ${this.adbVersion}` : 'adb';
    return {
      ...base,
      available: true,
      detail: `${adb} · ${n} device${n === 1 ? '' : 's'} online`,
      code: 'driver.android.online',
      params: { adb, count: n },
    };
  }

  async checks(): Promise<ToolCheck[]> {
    const settings = this.ctx?.settings() ?? { adbPath: undefined };
    const tool = resolveAdb(settings, this.renv());
    const label = 'Android Debug Bridge (adb)';
    if (!tool) {
      return [
        {
          id: 'adb',
          label,
          status: 'missing',
          detail: 'adb not found (settings.adbPath, $ANDROID_HOME, ~/Library/Android/sdk/platform-tools, PATH)',
          code: 'doctor.adb.notFound',
          fix: ADB_FIX,
          docsUrl: ADB_DOCS,
        },
      ];
    }
    const info = await adbBinaryInfo(tool.path, tool.env);
    const version = info.version;
    const rows: ToolCheck[] = [
      {
        id: 'adb',
        label,
        // A warning only when settings.adbPath names something unusable (another adb was taken instead).
        status: version ? (settings.adbPath?.trim() && tool.source !== 'settings' ? 'warn' : 'ok') : 'error',
        ...(version ? { version } : {}),
        path: tool.path,
        detail: version ? (tool.detail ?? sourceText(tool)) : `${tool.path} exists but "adb version" failed`,
        ...(version ? toolSourceCode(tool) : { code: 'doctor.adb.versionFailed', params: { path: tool.path } }),
        ...(version ? {} : { fix: ADB_FIX, docsUrl: ADB_DOCS }),
      },
    ];
    const server = await this.serverRow(tool, info);
    if (server) rows.push(server);
    return rows;
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

  /** PlatformServices.forwardToDevice for android:<key>. */
  async forward(deviceId: string, devicePort: number): Promise<PortForward> {
    const session = this.sessionFor(deviceId);
    if (session) return session.forward(devicePort);
    // Not tracked (driver not started): use adb directly.
    const tool = this.adb?.tool ?? resolveAdb(this.ctx?.settings() ?? { adbPath: undefined }, this.renv());
    if (!tool) throw new Error('adb is not available');
    const adb = new Adb(tool);
    const key = deviceId.slice('android:'.length);
    const serial = [...this.keyOfSerial].find(([, k]) => k === key)?.[0] ?? key;
    const r = await adb.forward(serial, devicePort);
    if (!r.port) throw new Error(`adb forward to device port ${devicePort} failed: ${r.error ?? 'unknown error'}`);
    const port = r.port;
    return { host: '127.0.0.1', port, dispose: async () => void (await adb.forwardRemove(serial, port)) };
  }

  /* ───────────── adb binary & server ───────────── */

  private sessionFor(deviceId: string): AndroidDeviceSession | undefined {
    if (!this.owns(deviceId)) return undefined;
    return this.sessions.get(deviceId.slice('android:'.length));
  }

  private makeAdb(tool: ResolvedTool): Adb {
    const adb = new Adb(tool);
    adb.onServerConflict = (c) => this.onServerKilled(adb, c);
    return adb;
  }

  private async initAdb(settings: ServerSettings): Promise<void> {
    const tool = resolveAdb(settings, this.renv());
    this.adbProblem = undefined;
    this.conflict = undefined;
    this.adopted = undefined;
    this.candidatesCache = undefined;
    if (!tool) {
      this.adb = null;
      this.adbVersion = undefined;
      this.clientProtocol = undefined;
      this.logger.info('adb not found; Android devices are unavailable');
      return;
    }
    const adb = this.makeAdb(tool);
    const info = await adbBinaryInfo(tool.path, tool.env);
    this.adb = adb;
    this.clientProtocol = info.protocol;
    if (!info.version) {
      this.adbProblem = `${tool.path} exists but "adb version" failed`;
      return;
    }
    this.adbVersion = info.version;
    // `adb start-server` would kill a server of another version: ask it first.
    if (!(await this.serverMatches())) return;
    const r = await this.adb.startServer();
    if (!r.ok) this.logger.warn(`adb start-server failed: ${failureText(r)}`);
    this.logger.debug(`using adb ${this.adbVersion} at ${this.adb.path} (${this.adb.tool.source})`);
  }

  /**
   * true when adb may run now: no server, a server of our version, or an answer we could not read (then
   * a kill shows up in the commands' stderr). On a mismatch an adb of the server's version is adopted when
   * one exists (and settings.adbPath is empty), else the driver waits.
   */
  private async serverMatches(): Promise<boolean> {
    const server = await queryAdbServerVersion(adbServerPort(this.serverEnv()));
    // While waiting, an answer we cannot read keeps us waiting (running adb could restart that server again).
    if (server === undefined) return !this.conflict;
    if (server === 'none' || !this.clientProtocol || server === this.clientProtocol) {
      if (this.conflict) this.endConflict(server === 'none' ? 'no adb server runs any more' : 'the versions match now');
      return true;
    }
    return this.onConflict(server);
  }

  private serverEnv(): NodeJS.ProcessEnv {
    return { ...this.renv().env, ...this.adb?.tool.env };
  }

  /** A command of ours killed a server of another version (it said so on stderr). */
  private onServerKilled(adb: Adb, c: AdbServerConflict): void {
    if (!this.running || adb !== this.adb || this.conflictTask) return;
    this.logger.warn(
      `adb at ${adb.path} restarted an adb server of another version${c.serverVersion ? ` (${c.serverVersion}, ours ${c.clientVersion ?? '?'})` : ''}`,
    );
    this.conflictTask = this.onConflict(c.serverVersion)
      .then(() => undefined)
      .catch((e: Error) => this.logger.debug(`adb conflict handling failed: ${e.message}`))
      .finally(() => {
        this.conflictTask = undefined;
      });
  }

  private async onConflict(server: number | undefined): Promise<boolean> {
    const settings = this.ctx?.settings() ?? { adbPath: undefined };
    const candidates = await this.candidates(settings);
    const own = this.adb?.path ?? '';
    const match = server !== undefined ? candidates.find((c) => c.info.protocol === server) : undefined;
    if (match && !settings.adbPath?.trim() && match.tool.path !== own) {
      // Same version as the running server: both programs share it and nobody restarts it.
      this.adb = this.makeAdb(match.tool);
      this.adbVersion = match.info.version;
      this.clientProtocol = server;
      this.adopted = { server: server!, path: match.tool.path, own: this.adopted?.own ?? own };
      if (this.conflict) this.endConflict(`using ${match.tool.path}`);
      this.logger.info(`another program runs adb server version ${server}; using the adb of that version at ${match.tool.path} instead of ${own}`);
      this.poller?.trigger();
      return true;
    }
    const first = !this.conflict;
    this.conflict = {
      ...(server !== undefined ? { server } : {}),
      ...(this.clientProtocol ? { client: this.clientProtocol } : {}),
      since: this.conflict?.since ?? Date.now(),
      ...(match ? { match: match.tool.path } : {}),
      candidates: candidates.map((c) => c.info),
    };
    if (first) {
      const text = conflictText(this.conflict, own);
      this.logger.warn(text);
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(sessions.map((s) => s.dispose('disconnected', { detail: text, code: DEVICE_ADB_CONFLICT_CODE })));
    }
    return false;
  }

  private endConflict(why: string): void {
    this.logger.info(`adb server conflict over: ${why}`);
    this.conflict = undefined;
  }

  private async candidates(settings: Pick<ServerSettings, 'adbPath'>): Promise<Candidate[]> {
    const cached = this.candidatesCache;
    if (cached && Date.now() - cached.at < CANDIDATES_TTL_MS) return cached.list;
    const tools = listAdbCandidates(settings, this.renv()).slice(0, 12);
    const list = await Promise.all(tools.map(async (tool) => ({ tool, info: await adbBinaryInfo(tool.path, tool.env) })));
    this.candidatesCache = { at: Date.now(), list };
    return list;
  }

  /** Doctor row about the running adb server: only when its version differs from ours (or we adopted one). */
  private async serverRow(tool: ResolvedTool, info: AdbBinaryInfo): Promise<ToolCheck | undefined> {
    const label = 'adb server';
    if (this.adopted && !this.conflict) {
      return {
        id: 'adb-server',
        label,
        status: 'ok',
        version: String(this.adopted.server),
        path: this.adopted.path,
        detail: `Another program runs adb server version ${this.adopted.server}; Dürbün uses the adb of that version (${this.adopted.path}) instead of ${this.adopted.own} so neither restarts the other's server.`,
        code: 'doctor.adbMatchedServer',
        params: { server: this.adopted.server, path: this.adopted.path, own: this.adopted.own },
      };
    }
    let conflict = this.conflict;
    if (!conflict) {
      const server = await queryAdbServerVersion(adbServerPort({ ...this.renv().env, ...tool.env }));
      if (typeof server !== 'number' || !info.protocol || server === info.protocol) return undefined;
      const candidates = await this.candidates(this.ctx?.settings() ?? { adbPath: undefined });
      const match = candidates.find((c) => c.info.protocol === server);
      conflict = {
        server,
        client: info.protocol,
        since: Date.now(),
        ...(match ? { match: match.tool.path } : {}),
        candidates: candidates.map((c) => c.info),
      };
    }
    const others = conflict.candidates
      .map((c) => `${c.path} (${c.protocol !== undefined ? `version ${c.protocol}` : 'version unknown'})`)
      .join(', ');
    return {
      id: 'adb-server',
      label,
      status: 'error',
      ...(conflict.server !== undefined ? { version: String(conflict.server) } : {}),
      detail: `${conflictText(conflict, this.adb?.path ?? tool.path)}${others ? ` adb on this Mac: ${others}.` : ''}`,
      code: ADB_CONFLICT_CODE,
      params: {
        server: conflict.server ?? '',
        client: conflict.client ?? '',
        path: this.adb?.path ?? tool.path,
        match: conflict.match ?? '',
      },
    };
  }

  private async onSettings(s: ServerSettings): Promise<void> {
    if (!this.running || s.adbPath === this.adbPathSetting) return;
    this.adbPathSetting = s.adbPath;
    const before = this.adb?.path;
    const next: ResolvedTool | null = resolveAdb(s, this.renv());
    if (next?.path === before && !this.adbProblem && !this.conflict) return;
    // adb changed: drop every device and rediscover with the new binary.
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((x) => x.dispose('stopped')));
    await this.initAdb(s);
    this.poller?.trigger();
  }

  /* ───────────── polling ───────────── */

  private async poll(): Promise<void> {
    if (!this.running || !this.ctx) return;
    this.polls += 1;
    if (!this.adb || this.adbProblem) {
      // Re-resolve now and then so installing platform-tools needs no restart.
      if (this.polls % 15 === 1) await this.initAdb(this.ctx.settings());
      if (!this.adb || this.adbProblem) return;
    }
    await this.conflictTask;
    if (!(await this.serverMatches()) || !this.running) return;
    const tracker = this.tracker;
    if (tracker?.live) {
      // Pushed by the server: nothing to run.
      this.poller?.setInterval(TRACK_SAFETY_MS);
      this.pollFailures = 0;
      this.pollProblem = undefined;
      do {
        this.trackDirty = false;
        await this.applyRows(parseAdbDevices(tracker.list ?? ''));
      } while (this.trackDirty && this.running && tracker.live && !this.conflict);
      return;
    }
    this.poller?.setInterval(POLL_MS);
    const adb = this.adb;
    const r = await adb.devices();
    if (!this.running) return;
    if (this.conflict || this.conflictTask) return; // this very call restarted another server
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
    await this.applyRows(parseAdbDevices(r.stdout));
    // A server runs now (`adb devices` starts one): follow its pushed list instead of polling.
    if (this.running && !this.conflict) tracker?.ensure();
  }

  /** Group the rows by phone, start / move / update sessions, drop the phones that are gone. */
  private async applyRows(rows: AdbDeviceRow[]): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const groups = new Map<string, AdbDeviceRow[]>();
    for (const row of rows) {
      const key = this.keyFor(row);
      if (key === undefined) continue; // asking the phone for its serial
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    for (const [key, list] of groups) {
      if (this.conflict || !this.running) return; // a command just restarted another adb server
      let session = this.sessions.get(key);
      const primary = pickPrimaryTransport(list, session?.serial);
      if (!session) {
        session = this.createSession(key, primary);
      } else if (session.serial !== primary.serial) {
        session = await this.handover(key, session, primary, list);
        if (!this.running) return;
      }
      session.setConnections(transportsOf(list, primary));
      void session.update(primary);
    }
    if (this.conflict || !this.running) return;
    // A Wi-Fi serial being asked for its phone may belong to a device that only changed ip:port.
    const waiting = this.resolving.size > 0;
    for (const [key, session] of [...this.sessions]) {
      if (groups.has(key)) continue;
      if (waiting && session.deviceInfo.connection === 'wifi') continue;
      this.sessions.delete(key);
      this.logger.info(`Android device detached: ${session.serial}`);
      await session.dispose('disconnected');
    }
  }

  private createSession(key: string, row: AdbDeviceRow, previous?: ReturnType<AndroidDeviceSession['handoverState']>): AndroidDeviceSession {
    const ctx = this.ctx!;
    let cursor = this.dropboxCursors.get(key);
    if (!cursor) this.dropboxCursors.set(key, (cursor = createDropboxCursor()));
    let published = this.publishedApps.get(key);
    if (!published) this.publishedApps.set(key, (published = new Set()));
    let overrides = this.settingOverrides.get(key);
    if (!overrides) this.settingOverrides.set(key, (overrides = new Map()));
    const session = new AndroidDeviceSession(
      {
        ctx,
        adb: () => this.adb,
        logger: this.logger,
        dropboxCursor: cursor,
        publishedApps: published,
        settingOverrides: overrides,
        onHardwareSerial: (hw) => this.noteHardwareSerial(key, hw),
      },
      row,
      { key, ...(previous ? { previous } : {}) },
    );
    this.sessions.set(key, session);
    session.announce();
    this.logger.info(`Android device attached: ${row.serial} (${row.state})${key !== row.serial ? ` as ${key}` : ''}`);
    return session;
  }

  /** The running transport of a phone went away (or USB came back): continue on `to`, same device id. */
  private async handover(
    key: string,
    from: AndroidDeviceSession,
    to: AdbDeviceRow,
    list: AdbDeviceRow[],
  ): Promise<AndroidDeviceSession> {
    const fromStillThere = list.some((r) => r.serial === from.serial && mapAdbState(r.state) === 'online');
    const state = from.handoverState();
    this.sessions.delete(key);
    this.logger.info(`Android device ${key}: moving from ${from.serial} to ${to.serial}`);
    await from.dispose('handover', { removeMappings: fromStillThere });
    return this.createSession(key, to, state);
  }

  /**
   * Device key of an adb row: the hardware serial for Wi-Fi serials (asked once: `getprop ro.serialno`),
   * the adb serial for USB (adb's USB serial is the hardware serial) and emulators. undefined = still asking.
   */
  private keyFor(row: AdbDeviceRow): string | undefined {
    const known = this.keyOfSerial.get(row.serial);
    if (known) return this.aliases.get(known) ?? known;
    if (connectionForSerial(row.serial) !== 'wifi') return row.serial;
    if (mapAdbState(row.state) !== 'online') {
      // The phone cannot be asked: its mDNS name carries the serial; an ip:port stays its own device.
      const fromName = serialFromMdnsName(row.serial);
      if (fromName && !isGenericSerial(fromName)) return this.aliases.get(fromName) ?? fromName;
      return row.serial;
    }
    if (!this.resolving.has(row.serial)) void this.resolveKey(row.serial);
    return undefined;
  }

  private async resolveKey(serial: string): Promise<void> {
    const adb = this.adb;
    if (!adb) return;
    this.resolving.add(serial);
    try {
      const r = await adb.shell(serial, 'getprop ro.serialno', { timeoutMs: 5000 });
      const hw = r.ok ? parseSerialProp(r.stdout) : undefined;
      const key = hw && !isGenericSerial(hw) ? hw : serial;
      this.remember(serial, key);
      if (key !== serial) this.logger.debug(`Wi-Fi transport ${serial} belongs to the phone ${key}`);
    } catch (e) {
      this.remember(serial, serial);
      this.logger.debug(`could not read the serial of ${serial}: ${(e as Error).message}`);
    } finally {
      this.resolving.delete(serial);
      this.poller?.trigger();
    }
  }

  private remember(serial: string, key: string): void {
    this.keyOfSerial.delete(serial);
    this.keyOfSerial.set(serial, key);
    if (this.keyOfSerial.size > MAX_REMEMBERED_SERIALS) {
      const oldest = this.keyOfSerial.keys().next().value;
      if (oldest !== undefined) this.keyOfSerial.delete(oldest);
    }
  }

  /** A session read `ro.serialno`: Wi-Fi transports reporting that serial join it. */
  private noteHardwareSerial(key: string, hw: string): void {
    if (!hw || hw === key || isGenericSerial(hw)) return;
    if (this.aliases.get(hw) === key) return;
    this.aliases.set(hw, key);
    this.poller?.trigger();
  }
}

/**
 * The transport that runs a phone's session: the current one while it is online (unless it is Wi-Fi and
 * USB is online too), else online USB / local, else online Wi-Fi, else whatever is listed.
 */
export function pickPrimaryTransport(rows: AdbDeviceRow[], current?: string): AdbDeviceRow {
  const online = rows.filter((r) => mapAdbState(r.state) === 'online');
  const cur = rows.find((r) => r.serial === current);
  const wired = online.find((r) => connectionForSerial(r.serial) !== 'wifi');
  if (cur && mapAdbState(cur.state) === 'online' && (connectionForSerial(cur.serial) !== 'wifi' || !wired)) return cur;
  return wired ?? online[0] ?? cur ?? rows[0]!;
}

/** Every online transport of a phone, the running one first. */
export function transportsOf(rows: AdbDeviceRow[], primary: AdbDeviceRow): ConnectionType[] {
  const out: ConnectionType[] = [connectionForSerial(primary.serial)];
  for (const r of rows) {
    if (r === primary || mapAdbState(r.state) !== 'online') continue;
    const c = connectionForSerial(r.serial);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function conflictText(c: Conflict, ownPath: string): string {
  const versions =
    c.server !== undefined
      ? `Another program runs adb server version ${c.server}; the adb Dürbün uses (${ownPath}) is version ${c.client ?? '?'}.`
      : `Another program runs an adb server of another version than the adb Dürbün uses (${ownPath}).`;
  const fix = c.match
    ? ` Set adbPath in Settings to ${c.match} (the same version).`
    : ' Quit the program that started it, or set adbPath in Settings to the adb that program uses.';
  return `${versions} Running Dürbün's adb would restart that server and cut the other program's device connections, so Android devices wait.${fix}`;
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
