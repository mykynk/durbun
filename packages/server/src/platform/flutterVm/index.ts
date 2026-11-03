/**
 * Flutter / Dart VM Service bridge (SPEC §5.6): zero-integration capture of logs, HTTP traffic, metrics and
 * Flutter debug actions from debug/profile builds — attached manually (URL / DevTools link / pasted
 * `flutter run` output) or automatically when a device log announces a VM service.
 */
import type { DriverStatus, LogEntry, ToolCheck } from '@durbun/protocol';
import type { DriverContext, FlutterVmModule, Logger, PlatformServices, PortForward } from '../../types';
import { redactSecrets } from '../../util/redact';
import {
  collectAnnouncements,
  isAutoAttachDevice,
  isFreshAnnouncement,
  needsPortForward,
  ProcessNameCache,
  processKeyOf,
  type Announcement,
} from './autoAttach';
import { AlreadyAttachedError, VmSession, type VmModuleContext, type VmTarget } from './session';
import { VmStateStore } from './state';
import { extractVmServiceUrl, normalizeVmServiceUrl, redactServiceUrl, withHostPort } from './url';

/** Give `flutter run` a moment to start DDS before connecting (fewer reconnects, no replays). */
const AUTO_ATTACH_DELAY_MS = 1500;
const FAILED_RETRY_MS = 60_000;

interface AutoAttempt {
  state: 'pending' | 'attached' | 'failed';
  at: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === 'ECONNREFUSED' || /ECONNREFUSED|socket hang up|ECONNRESET/.test(errorText(err));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

class FlutterVmModuleImpl implements FlutterVmModule {
  private ctx?: VmModuleContext;
  private logger?: Logger;
  private started = false;
  private readonly sessions = new Set<VmSession>();
  private readonly states = new VmStateStore();
  private readonly processes = new ProcessNameCache();
  private readonly attempts = new Map<string, AutoAttempt>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly options: FlutterVmModuleOptions = {}) {}

  async start(ctx: DriverContext & { platform: PlatformServices }): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.logger = ctx.logger.child('flutter-vm');
    this.started = true;
    this.unsubscribe.push(ctx.onLogs((entries) => this.onDeviceLogs(entries)));
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const off of this.unsubscribe.splice(0)) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    await Promise.all([...this.sessions].map((s) => s.end('Dürbün stopped', { cleanup: true }).catch(() => {})));
    this.sessions.clear();
    this.attempts.clear();
  }

  status(): DriverStatus {
    const n = this.attachedSessions().length;
    const auto = this.ctx?.settings().autoAttachVmService ?? true;
    let detail: string;
    if (!this.started) detail = 'Not started';
    else if (n > 0) detail = `${n} app${n === 1 ? '' : 's'} attached through the Dart VM service`;
    else detail = auto ? 'Waiting for Flutter debug apps (auto-attach on)' : 'No app attached (auto-attach off)';
    return { id: 'flutter-vm', available: true, active: this.started, detail };
  }

  async checks(): Promise<ToolCheck[]> {
    const n = this.attachedSessions().length;
    const auto = this.ctx?.settings().autoAttachVmService ?? true;
    const names = this.attachedSessions().map((s) => s.name);
    return [
      {
        id: 'flutter-vm',
        label: 'Flutter / Dart VM service bridge',
        status: 'ok',
        detail:
          `${n} attached${names.length ? ` (${names.join(', ')})` : ''} · auto-attach ${auto ? 'on' : 'off'}` +
          (auto ? '' : ' — paste the "A Dart VM Service … is available at" URL to attach manually'),
      },
    ];
  }

  async attach(input: string, opts: { deviceId?: string } = {}): Promise<{ appId: string }> {
    this.requireStarted();
    const wsUrl = extractVmServiceUrl(input);
    if (!wsUrl) {
      throw new Error(
        'No Dart VM service URL found. Paste the URL printed by `flutter run` ("A Dart VM Service … is available at: http://127.0.0.1:…/…=/"), a DevTools link, or the whole output.',
      );
    }
    const existing = this.attachedSessions().find((s) => s.target.wsUrl === wsUrl);
    if (existing?.appId) return { appId: existing.appId };
    const target: VmTarget = {
      wsUrl,
      reconnectUrl: wsUrl,
      origin: 'manual',
      displayUrl: wsUrl,
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    };
    try {
      return await this.openSession(target);
    } catch (err) {
      // A device-side URL copied from logcat/syslog (device loopback) needs a port forward.
      const host = new URL(wsUrl).hostname;
      if (!opts.deviceId || !needsPortForward(opts.deviceId, host) || !isConnectionRefused(err)) throw err;
      return this.attachThroughForward(wsUrl, opts.deviceId);
    }
  }

  private async attachThroughForward(wsUrl: string, deviceId: string): Promise<{ appId: string }> {
    const ctx = this.requireStarted();
    const port = Number(new URL(wsUrl).port);
    const forward = await ctx.platform.forwardToDevice(deviceId, port);
    // The session owns (and disposes) the forward from here on, also when start() fails.
    return this.openSession({
      wsUrl: withHostPort(wsUrl, forward.host, forward.port),
      reconnectUrl: withHostPort(wsUrl, forward.host, forward.port),
      deviceId,
      forward,
      origin: 'manual',
      displayUrl: wsUrl,
    });
  }

  async detach(appId: string): Promise<void> {
    const session = this.liveSessions().find((s) => s.appId === appId);
    if (!session) throw new Error(`No Dart VM service session for app ${appId}`);
    await session.end('detached by the user', { cleanup: true });
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  private requireStarted(): VmModuleContext {
    if (!this.started || !this.ctx) throw new Error('The Flutter VM module is not running');
    return this.ctx;
  }

  private liveSessions(): VmSession[] {
    return [...this.sessions].filter((s) => !s.isEnded);
  }

  /** Sessions that completed their attach. */
  private attachedSessions(): VmSession[] {
    return this.liveSessions().filter((s) => !!s.appId);
  }

  private async openSession(target: VmTarget): Promise<{ appId: string }> {
    const ctx = this.requireStarted();
    const session = new VmSession(target, {
      ctx,
      logger: this.logger!,
      states: this.states,
      processName: (deviceId, pid) => this.processes.get(deviceId, pid),
      onEnded: (s) => this.onSessionEnded(s),
      duplicateOf: (s) => this.attachedSessions().find((o) => o !== s && o.isSameVm(s)),
      ...(this.options.reconnectDelaysMs ? { reconnectDelaysMs: this.options.reconnectDelaysMs } : {}),
      ...(this.options.deviceAppWaitMs !== undefined ? { deviceAppWaitMs: this.options.deviceAppWaitMs } : {}),
    });
    this.sessions.add(session);
    try {
      return await session.start();
    } catch (err) {
      this.sessions.delete(session);
      if (err instanceof AlreadyAttachedError) return { appId: err.appId };
      throw err;
    }
  }

  private onSessionEnded(session: VmSession): void {
    this.sessions.delete(session);
    // Let a re-announced URL (e.g. logcat replay after a device reconnect) attach again.
    if (session.target.origin !== 'auto' || !session.target.deviceId) return;
    const key = this.attemptKey(session.target.deviceId, session.target.displayUrl);
    if (this.attempts.get(key)?.state === 'attached') this.attempts.delete(key);
  }

  private attemptKey(deviceId: string, url: string): string {
    return `${deviceId}|${url}`;
  }

  /** Synchronous tap on every appended log batch: must stay cheap and never throw. */
  private onDeviceLogs(entries: LogEntry[]): void {
    try {
      const found = collectAnnouncements(entries, this.processes);
      if (found.length === 0 || !this.started || !this.ctx?.settings().autoAttachVmService) return;
      for (const a of found) {
        if (!isAutoAttachDevice(a.deviceId)) continue;
        void this.autoAttach(a).catch((err) => this.logger?.warn(`auto-attach failed: ${errorText(err)}`));
      }
    } catch (err) {
      this.logger?.warn(`VM service log tap failed: ${errorText(err)}`);
    }
  }

  private async autoAttach(a: Announcement): Promise<void> {
    const ctx = this.requireStarted();
    const key = this.attemptKey(a.deviceId, a.url);
    const prev = this.attempts.get(key);
    if (prev && (prev.state !== 'failed' || Date.now() - prev.at < FAILED_RETRY_MS)) return;
    this.attempts.set(key, { state: 'pending', at: Date.now() });
    if (this.attempts.size > 500) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.attempts.delete(oldest);
    }
    const fresh = isFreshAnnouncement(a.ts);
    const processKey = processKeyOf(a);

    // A new URL for the same app on the same device: the app restarted, the old session is stale.
    for (const s of this.liveSessions()) {
      if (s.target.origin === 'auto' && s.target.deviceId === a.deviceId && s.target.processKey === processKey && s.target.displayUrl !== a.url) {
        await s.end('the app restarted (new VM service URL)').catch(() => {});
      }
    }

    await sleep(this.options.autoAttachDelayMs ?? AUTO_ATTACH_DELAY_MS);
    if (!this.started) return;

    let forward: PortForward | undefined;
    let handedOver = false;
    try {
      const announced = new URL(a.url);
      let wsUrl = normalizeVmServiceUrl(a.url);
      if (needsPortForward(a.deviceId, announced.hostname)) {
        const port = Number(announced.port);
        if (!Number.isInteger(port) || port <= 0) throw new Error(`No port in ${redactSecrets(a.url)}`);
        forward = await ctx.platform.forwardToDevice(a.deviceId, port);
        wsUrl = withHostPort(wsUrl, forward.host, forward.port);
      }
      const target: VmTarget = {
        wsUrl,
        reconnectUrl: wsUrl,
        deviceId: a.deviceId,
        origin: 'auto',
        displayUrl: a.url,
        processKey,
        hints: { ...(a.pid ? { pid: a.pid } : {}), ...(a.process ? { processName: a.process } : {}) },
        ...(forward ? { forward } : {}),
      };
      handedOver = true; // the session disposes the forward from here on, also when start() fails
      await this.openSession(target);
      this.attempts.set(key, { state: 'attached', at: Date.now() });
    } catch (err) {
      if (forward && !handedOver) await forward.dispose().catch(() => {});
      this.attempts.set(key, { state: 'failed', at: Date.now() });
      if (!this.started) return; // shutting down: not a user-facing failure
      const message = errorText(err);
      if (!fresh) {
        this.logger?.debug(`auto-attach to an old VM service announcement failed: ${message}`);
        return;
      }
      this.logger?.warn(`auto-attach to ${redactServiceUrl(a.url)} on ${a.deviceId} failed: ${message}`);
      const params = { url: redactServiceUrl(a.url), error: message };
      try {
        ctx.hub.notice({
          level: 'warn',
          message: `Could not attach to the Dart VM service: ${message}`,
          code: 'vm.attachFailed',
          params,
          deviceId: a.deviceId,
        });
        ctx.hub.pushSystemLog(a.deviceId, {
          message: `Could not attach to the Dart VM service at ${redactServiceUrl(a.url)}: ${message}`,
          level: 'warn',
          code: 'vm.attachFailed',
          params,
        });
      } catch (hubErr) {
        this.logger?.debug(`reporting the attach failure failed: ${errorText(hubErr)}`);
      }
    }
  }
}

/** Timing overrides (tests); production code calls `createFlutterVmModule()`. */
export interface FlutterVmModuleOptions {
  autoAttachDelayMs?: number;
  reconnectDelaysMs?: number[];
  deviceAppWaitMs?: number;
}

export function createFlutterVmModule(options: FlutterVmModuleOptions = {}): FlutterVmModule {
  return new FlutterVmModuleImpl(options);
}
