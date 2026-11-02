/**
 * Apps WITHOUT the Dürbün SDK (SPEC §10): a store / Firebase / TestFlight build on a tester's phone.
 * Everything here is what the OS shows from outside — device log lines of the app's processes, process
 * start / death, crash and ANR records (dropbox, .ips) and the DeviceApp (version, build type, installer).
 * No network, no app logs, no mocks: the UI explains why.
 *
 *  - KumbaraAndroid   Play build (release, com.android.vending) on the Pixel, main + ":widget" process,
 *                     an old widget crash from this morning (previousLaunch), a live crash now and then
 *                     (logcat + its dropbox copy marked duplicateOf) and an ANR now and then.
 *  - PatiQaAndroid    Firebase App Distribution build (release, dev.firebase.appdistribution): quiet.
 *  - KumbaraIos       App Store / TestFlight build on the USB iPhone: syslog lines, an old .ips crash
 *                     report and a live SIGSEGV now and then (syslog + the copied .ips).
 */
import type { DeviceLogInput, DriverContext } from '../types';
import { type DemoDeviceAppMeta, deviceAppInput, type SimApp, type StopReason } from './appSim';
import { anrReport } from './content';
import {
  dropboxRecord,
  ipsCrashReport,
  KUMBARA_CHANNEL_CRASH,
  KUMBARA_WIDGET_NPE,
  kumbaraAnrTraces,
  kumbaraIosFrames,
  logcatFatal,
} from './crashReports';
import { ANDROID_SYSTEM, IOS_DEVICE_SYSTEM } from './devices';
import { androidLine, iosLine } from './noise';
import type { Rng } from './rng';
import type { Scheduler } from './scheduler';

export interface DeviceOnlyDeps {
  ctx: DriverContext;
  sched: Scheduler;
  rng: Rng;
  deviceId: string;
  platform: 'android' | 'ios';
  /** When the demo device "connected" (crash records older than this are from a previous launch). */
  watchStart: number;
  /** Id of the live device log entry of `kind` just pushed for this pid (for dropbox de-duplication). */
  liveEntryId(deviceId: string, pid: number, kind: 'crash' | 'anr'): number | undefined;
}

export interface DeviceOnlyIdentity {
  name: string;
  bundleId: string;
  version: string;
  build: string;
  processName: string;
}

export abstract class DeviceOnlyApp implements SimApp {
  pid: number | undefined;
  /** Second process (Android ":widget" etc.). */
  helperPid: number | undefined;
  state: 'stopped' | 'running' = 'stopped';
  installed = true;
  protected gen = 0;
  private nextPid: number;

  constructor(
    protected readonly deps: DeviceOnlyDeps,
    readonly identity: DeviceOnlyIdentity,
    readonly meta: DemoDeviceAppMeta,
    firstPid: number,
    /** Suffix of the helper process, e.g. ':widget' (Android only). */
    protected readonly helperSuffix?: string,
  ) {
    this.nextPid = firstPid;
  }

  get deviceId(): string {
    return this.deps.deviceId;
  }

  get running(): boolean {
    return this.state === 'running';
  }

  get rng(): Rng {
    return this.deps.rng;
  }

  now(): number {
    return this.deps.sched.now();
  }

  pids(): number[] {
    return [this.pid, this.helperPid].filter((p): p is number => p !== undefined);
  }

  protected abstract onProcessStart(reason: string): void;
  protected abstract onProcessEnd(reason: StopReason): void;
  protected abstract onRunning(firstLaunch: boolean): void;

  private launches = 0;

  launch(reason = 'user'): boolean {
    if (!this.installed || this.state !== 'stopped') return false;
    this.gen++;
    this.state = 'running';
    this.launches++;
    this.pid = this.nextPid;
    this.nextPid += this.rng.int(37, 420);
    if (this.helperSuffix) this.helperPid = this.pid + this.rng.int(9, 40);
    // The device reports the app (with its pids) before anyone sees the processes start.
    this.report();
    const hub = this.deps.ctx.hub;
    hub.setProcess({ deviceId: this.deviceId, pid: this.pid, name: this.identity.processName, event: 'started', ts: this.now() });
    if (this.helperPid !== undefined) {
      hub.setProcess({ deviceId: this.deviceId, pid: this.helperPid, name: `${this.identity.bundleId}${this.helperSuffix}`, event: 'started', ts: this.now() });
    }
    this.onProcessStart(reason);
    this.onRunning(this.launches === 1);
    return true;
  }

  stop(reason: StopReason): void {
    if (this.state === 'stopped') return;
    const pids = this.pids();
    this.gen++;
    this.state = 'stopped';
    if (reason === 'demo-stop') return;
    this.onProcessEnd(reason);
    const hub = this.deps.ctx.hub;
    for (const pid of pids) {
      const name = pid === this.helperPid ? `${this.identity.bundleId}${this.helperSuffix ?? ''}` : this.identity.processName;
      hub.setProcess({ deviceId: this.deviceId, pid, name, event: 'died', ts: this.now() });
    }
    this.helperPid = undefined;
    if (reason === 'uninstall') hub.removeDeviceApps(this.deviceId, [this.identity.bundleId]);
    else this.report();
  }

  /** The device's view of this build (pids / running, version, build type, installer). */
  report(extra: { lastActivity?: number; crashReportsDelta?: number } = {}): void {
    this.deps.ctx.hub.upsertDeviceApp({
      ...deviceAppInput(this, this.deps.platform, this.meta, { pids: this.running ? this.pids() : [], running: this.running }),
      ...extra,
    });
  }

  /**
   * A crash / ANR record read from the device: one log row + the DeviceApp's crash counter. Like the real
   * drivers, the record's own time is the app's activity (an old record does not make it "active now").
   */
  protected crashRecord(entry: DeviceLogInput): void {
    this.deps.ctx.hub.pushDeviceLogs(this.deviceId, [entry]);
    this.report({ crashReportsDelta: 1, lastActivity: entry.ts });
  }

  /** Lines of this app's main (or helper) process. */
  protected deviceLog(lines: Omit<DeviceLogInput, 'pid' | 'ts'>[], helper = false): void {
    const pid = helper ? this.helperPid : this.pid;
    if (pid === undefined || lines.length === 0) return;
    const ts = this.now();
    this.deps.ctx.hub.pushDeviceLogs(
      this.deviceId,
      lines.map((l, i) => {
        const entry: DeviceLogInput = { ...l, ts: ts + i * 0.01, pid };
        if (entry.tid === undefined) entry.tid = pid + (helper ? 0 : this.rng.int(0, 3) === 0 ? this.rng.int(14, 60) : 0);
        if (this.deps.platform === 'ios' && !entry.process) entry.process = this.identity.processName;
        return entry;
      }),
    );
  }

  /** Lines of other processes about this app (system_server, runningboardd, ReportCrash…). */
  protected systemLog(lines: DeviceLogInput[]): void {
    if (lines.length === 0) return;
    const base = this.now();
    const first = lines[0]!.ts;
    for (const l of lines) l.ts = base + Math.max(0, l.ts - first);
    this.deps.ctx.hub.pushDeviceLogs(this.deviceId, lines);
  }

  /**
   * Runs `fn` now and then for the whole demo (not tied to one process): first after `firstMs`, then
   * every `minMs`–`maxMs`. `fn` decides whether the app is in a state for it.
   */
  protected loop(firstMs: number, minMs: number, maxMs: number, fn: () => void): void {
    const run = () => {
      fn();
      this.deps.sched.after(this.rng.int(minMs, maxMs), run);
    };
    this.deps.sched.after(firstMs, run);
  }

  /** Runs `fn` after `ms` if this process is still the same one. */
  protected after(ms: number, fn: () => void): void {
    const gen = this.gen;
    this.deps.sched.after(ms, () => {
      if (gen === this.gen) fn();
    });
  }

  /** Repeats `fn` (Poisson-ish, mean `meanMs`) while this process lives. */
  protected every(meanMs: number, fn: () => void, minMs = 500): void {
    const gen = this.gen;
    const cancel = this.deps.sched.repeat(
      () => Math.max(minMs, this.rng.exp(meanMs)),
      () => {
        if (gen !== this.gen) {
          cancel();
          return;
        }
        fn();
      },
    );
  }
}

/* ────────────────────────────── Kumbara · Play build on the Pixel ────────────────────────────── */

const KUMBARA = 'com.mykynk.kumbara';
const KUMBARA_UID = 10241;
const DAY = 86_400_000;

export class KumbaraAndroid extends DeviceOnlyApp {
  private readonly firstCrashAtMs: number;

  constructor(deps: DeviceOnlyDeps) {
    const now = deps.sched.now();
    super(
      deps,
      { name: 'Kumbara', bundleId: KUMBARA, version: '3.1.0', build: '310', processName: KUMBARA },
      { buildType: 'release', install: { source: 'play', installer: 'com.android.vending', firstInstall: now - 41 * DAY, lastUpdate: now - 6 * DAY } },
      12_045,
      ':widget',
    );
    this.firstCrashAtMs = deps.rng.int(52_000, 68_000);
  }

  /**
   * What the dropbox scan finds on connect (last 24 h): the widget crashed this morning, before Dürbün
   * was watching → previousLaunch.
   */
  reportEarlierCrash(): void {
    const reportTs = this.deps.watchStart - (3 * 3_600_000 + 12 * 60_000 + 9_000);
    this.crashRecord(
      dropboxRecord({
        tag: 'data_app_crash',
        pkg: KUMBARA,
        process: `${KUMBARA}:widget`,
        pid: 9312,
        version: this.identity.version,
        versionCode: this.identity.build,
        foreground: false,
        reportTs,
        watchStart: this.deps.watchStart,
        error: KUMBARA_WIDGET_NPE,
        body: `${KUMBARA_WIDGET_NPE.stack}`,
      }),
    );
  }

  protected onProcessStart(reason: string): void {
    const pid = this.pid as number;
    const ss = ANDROID_SYSTEM.systemServer.pid;
    this.systemLog([
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Start proc ${pid}:${KUMBARA}/u0a${KUMBARA_UID - 10000} for ${reason === 'boot' ? 'broadcast' : 'next-top-activity'} {${KUMBARA}/${KUMBARA}.MainActivity}`),
    ]);
    this.after(60, () =>
      this.deviceLog([
        { level: 'info', tag: 'nativeloader', message: `Configuring clns-9 for other apk /data/app/~~Rk2w9pQe1Lr6sV3tY0uI8o==/${KUMBARA}-${this.rng.hex(6)}==/base.apk. target_sdk_version=35, uses_libraries=, library_path=/data/app/~~Rk2w9pQe1Lr6sV3tY0uI8o==/${KUMBARA}/lib/arm64, permitted_path=/data:/mnt/expand:/data/user/0/${KUMBARA}` },
        { level: 'info', tag: 'flutter', message: '[IMPORTANT:flutter/shell/platform/android/android_context_vk_impeller.cc(62)] Using the Impeller rendering backend (Vulkan).' },
        { level: 'info', tag: 'FirebaseInitProvider', message: 'FirebaseApp initialization successful' },
        { level: 'debug', tag: 'NetworkSecurityConfig', message: 'Using Network Security Config from resource network_security_config debugBuild: false' },
      ]),
    );
    this.after(240, () =>
      this.deviceLog([{ level: 'debug', tag: 'GoalWidget', message: 'onUpdate appWidgetIds=[17] goals=3' }], true),
    );
  }

  protected onProcessEnd(reason: StopReason): void {
    const ss = ANDROID_SYSTEM.systemServer.pid;
    const pid = this.pid as number;
    if (reason === 'crash') {
      this.systemLog([
        androidLine(ss, ss + 9, 'warn', 'ActivityTaskManager', `  Force finishing activity ${KUMBARA}/.MainActivity`),
        androidLine(ss, ss + 9, 'info', 'ActivityManager', `Process ${KUMBARA} (pid ${pid}) has died: fg  TOP`),
      ]);
      return;
    }
    this.systemLog([
      androidLine(ss, ss + 5, 'info', 'ActivityManager', `Force stopping ${KUMBARA} appid=${KUMBARA_UID} user=0: from pid ${this.rng.int(9000, 9900)}`),
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Process ${KUMBARA} (pid ${pid}) has died: cch+5 CEM`),
    ]);
  }

  protected onRunning(firstLaunch: boolean): void {
    // A release Flutter build is quiet: a few engine / plugin lines and whatever the app prints itself.
    this.every(9_000, () => {
      const pick = this.rng.weighted<() => void>([
        [() => this.deviceLog([{ level: 'info', tag: 'flutter', message: `Kumbara: hedef ilerlemesi güncellendi (Tatil fonu %${this.rng.int(38, 47)})` }]), 1.2],
        [() => this.deviceLog([{ level: 'debug', tag: 'TrafficStats', message: `tagSocket(${this.rng.int(90, 180)}) with statsTag=0xffffffff, statsUid=-1` }]), 1],
        [() => this.deviceLog([{ level: 'info', tag: 'WM-WorkerWrapper', message: `Worker result SUCCESS for Work [ id=${this.rng.uuid()}, tags={ ${KUMBARA}.sync.GoalSyncWorker } ]` }]), 0.6],
        [() => this.deviceLog([{ level: 'debug', tag: 'BillingClient', message: 'Billing service connected.' }]), 0.3],
        [() => this.deviceLog([{ level: 'debug', tag: 'GoalWidget', message: `onUpdate appWidgetIds=[17] goals=3 progress=${this.rng.int(38, 47)}%` }], true), 0.5],
      ]);
      pick();
    });
    if (firstLaunch) {
      // Now and then for the whole demo (a crash must not cancel the ANR schedule).
      this.loop(this.firstCrashAtMs, 300_000, 480_000, () => this.crash());
      this.loop(this.rng.int(150_000, 190_000), 420_000, 600_000, () => this.anr());
    }
  }

  /** Live crash in the Kotlin bridge: logcat shows it now, the dropbox poll (≤ 30 s) finds its copy. */
  private crash(): void {
    if (!this.running) return;
    const pid = this.pid as number;
    const ts = this.now();
    this.deviceLog([
      { level: 'fatal', tag: 'AndroidRuntime', kind: 'crash', message: logcatFatal(KUMBARA, pid, KUMBARA_CHANNEL_CRASH), error: { ...KUMBARA_CHANNEL_CRASH } },
    ]);
    const liveId = this.deps.liveEntryId(this.deviceId, pid, 'crash');
    this.after(60, () => this.stop('crash'));
    this.deps.sched.after(this.rng.int(6_000, 18_000), () =>
      this.crashRecord(
        dropboxRecord({
          tag: 'data_app_crash',
          pkg: KUMBARA,
          process: KUMBARA,
          pid,
          version: this.identity.version,
          versionCode: this.identity.build,
          foreground: true,
          reportTs: ts,
          watchStart: this.deps.watchStart,
          error: KUMBARA_CHANNEL_CRASH,
          body: KUMBARA_CHANNEL_CRASH.stack,
          duplicateOf: liveId,
        }),
      ),
    );
    this.deps.sched.after(this.rng.int(9_000, 14_000), () => this.launch('user'));
  }

  /** Room write on the main thread: ActivityManager reports the ANR, dropbox keeps the traces. */
  private anr(): void {
    if (!this.running) return;
    const pid = this.pid as number;
    const ss = ANDROID_SYSTEM.systemServer.pid;
    const ts = this.now();
    this.systemLog([{ ...androidLine(ss, ss + 2, 'error', 'ActivityManager', anrReport(KUMBARA, pid, new Date(ts)).replace(`${KUMBARA}/.ui.MainActivity`, `${KUMBARA}/.MainActivity`)), kind: 'anr' }]);
    const liveId = this.deps.liveEntryId(this.deviceId, ss, 'anr');
    const traces = kumbaraAnrTraces(pid, ts);
    const subject = `Input dispatching timed out (8f2c1a0 ${KUMBARA}/${KUMBARA}.MainActivity (server) is not responding. Waited 5001ms for MotionEvent)`;
    this.deps.sched.after(this.rng.int(8_000, 20_000), () =>
      this.crashRecord(
        dropboxRecord({
          tag: 'data_app_anr',
          pkg: KUMBARA,
          process: KUMBARA,
          pid,
          version: this.identity.version,
          versionCode: this.identity.build,
          foreground: true,
          reportTs: ts,
          watchStart: this.deps.watchStart,
          error: { type: 'ANR', message: subject, stack: traces.stack },
          body: traces.body,
          duplicateOf: liveId,
        }),
      ),
    );
  }
}

/* ────────────────────────────── Pati QA · Firebase build on the Pixel ────────────────────────────── */

const PATI_QA = 'com.mykynk.pati.staging';

export class PatiQaAndroid extends DeviceOnlyApp {
  constructor(deps: DeviceOnlyDeps) {
    const now = deps.sched.now();
    super(
      deps,
      { name: 'Pati QA', bundleId: PATI_QA, version: '2.5.0-rc.2', build: '252', processName: PATI_QA },
      { buildType: 'release', install: { source: 'firebase', installer: 'dev.firebase.appdistribution', firstInstall: now - 12 * DAY, lastUpdate: now - DAY } },
      15_310,
    );
  }

  protected onProcessStart(): void {
    const pid = this.pid as number;
    const ss = ANDROID_SYSTEM.systemServer.pid;
    this.systemLog([
      androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', `START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000 cmp=${PATI_QA}/com.mykynk.pati.MainActivity} with LAUNCH_MULTIPLE from uid 10162 (BAL_ALLOW_VISIBLE_WINDOW) result code=0`),
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Start proc ${pid}:${PATI_QA}/u0a251 for next-top-activity {${PATI_QA}/com.mykynk.pati.MainActivity}`),
    ]);
    this.after(80, () =>
      this.deviceLog([
        { level: 'info', tag: 'flutter', message: '[IMPORTANT:flutter/shell/platform/android/android_context_vk_impeller.cc(62)] Using the Impeller rendering backend (Vulkan).' },
        { level: 'info', tag: 'FirebaseApp', message: 'Device unlocked: initializing all Firebase APIs for app [DEFAULT]' },
        { level: 'info', tag: 'FirebaseInitProvider', message: 'FirebaseApp initialization successful' },
      ]),
    );
    this.after(700, () =>
      this.systemLog([androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', `Displayed ${PATI_QA}/com.mykynk.pati.MainActivity for user 0: +${this.rng.int(540, 820)}ms`)]),
    );
  }

  protected onProcessEnd(): void {
    const ss = ANDROID_SYSTEM.systemServer.pid;
    this.systemLog([androidLine(ss, ss + 9, 'info', 'ActivityManager', `Process ${PATI_QA} (pid ${this.pid}) has died: cch+15 CEM`)]);
  }

  protected onRunning(): void {
    // Release build without --dart-define=DURBUN=true: Dart prints nothing; only native noise remains.
    this.every(20_000, () => {
      if (this.rng.chance(0.6)) this.deviceLog([{ level: 'debug', tag: 'TrafficStats', message: `tagSocket(${this.rng.int(90, 180)}) with statsTag=0xffffffff, statsUid=-1` }]);
      else this.deviceLog([{ level: 'debug', tag: 'FirebaseMessaging', message: 'Unable to log event: analytics library is missing' }]);
    });
    this.after(6_000, () => this.deviceLog([{ level: 'debug', tag: 'ProfileInstaller', message: `Installing profile for ${PATI_QA}` }]));
  }
}

/* ────────────────────────────── Kumbara · TestFlight / App Store build on the USB iPhone ────────────────────────────── */

export class KumbaraIos extends DeviceOnlyApp {
  private readonly containerUuid: string;
  private readonly incidentRng: Rng;

  constructor(deps: DeviceOnlyDeps) {
    super(
      deps,
      { name: 'Kumbara', bundleId: KUMBARA, version: '3.1.0', build: '310', processName: 'Runner' },
      { buildType: 'release', install: { source: 'store-or-testflight' } },
      2_841,
    );
    this.containerUuid = deps.rng.uuid(true);
    this.incidentRng = deps.rng.fork(77);
  }

  /** The .ips the crash-report scan copies on connect: a SIGSEGV from earlier today (previousLaunch). */
  reportEarlierCrash(): void {
    this.crashRecord(this.ips(1_977, this.deps.watchStart - (5 * 3_600_000 + 41 * 60_000)));
  }

  private ips(pid: number, reportTs: number): DeviceLogInput {
    const d = new Date(reportTs);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    return ipsCrashReport({
      bundleId: KUMBARA,
      appName: 'Kumbara',
      process: 'Runner',
      pid,
      version: this.identity.version,
      build: this.identity.build,
      osVersion: '17.6.1',
      osBuild: '21G93',
      reportTs,
      watchStart: this.deps.watchStart,
      incident: this.incidentRng.uuid(true),
      frames: kumbaraIosFrames(this.incidentRng.int(1, 0x3fff) * 0x4000),
      exceptionType: 'EXC_BAD_ACCESS',
      signal: 'SIGSEGV',
      subtype: 'KERN_INVALID_ADDRESS at 0x0000000000000010',
      termination: 'SIGNAL 11 Segmentation fault: 11',
      file: `Runner-${stamp}.ips`,
    });
  }

  private appLabel(pid: number): string {
    return `app<${KUMBARA}(${this.containerUuid})>:${pid}`;
  }

  protected onProcessStart(): void {
    const pid = this.pid as number;
    const rb = IOS_DEVICE_SYSTEM.runningboardd.pid;
    const sb = IOS_DEVICE_SYSTEM.springboard.pid;
    this.systemLog([
      iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', 'process', `[${this.appLabel(pid)}] is not RunningBoard jetsam managed.`),
      iosLine(sb, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[${this.appLabel(pid)}] Bootstrap success!`),
    ]);
    this.after(150, () =>
      this.deviceLog([
        { level: 'info', tag: 'com.apple.runningboard', subsystem: 'com.apple.runningboard', category: 'monitor', message: `Received state update for ${pid} (${this.appLabel(pid).replace(`:${pid}`, '')}, running-active-NotVisible` },
        { level: 'info', tag: 'flutter', message: '[IMPORTANT:flutter/shell/platform/darwin/ios/ios_context_metal_impeller.mm(42)] Using the Impeller rendering backend (Metal).' },
      ]),
    );
  }

  protected onProcessEnd(reason: StopReason): void {
    const pid = this.pid as number;
    const rb = IOS_DEVICE_SYSTEM.runningboardd.pid;
    const sb = IOS_DEVICE_SYSTEM.springboard.pid;
    if (reason === 'crash') {
      this.systemLog([
        iosLine(IOS_DEVICE_SYSTEM.reportCrash.pid, 'ReportCrash', 'info', 'com.apple.ReportCrash', 'default', `Formulating fatal 309 report for corpse[${pid}] Runner`),
        iosLine(rb, 'runningboardd', 'error', 'com.apple.runningboard', 'process', `[${this.appLabel(pid)}] termination reported by launchd (2, 11, 11)`),
        iosLine(sb, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[${this.appLabel(pid)}] Process exited: <RBSProcessExitContext| specific, status:<RBSProcessExitStatus| domain:signal(2) code:SIGSEGV(11)>>.`),
      ]);
      return;
    }
    this.systemLog([
      iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', 'process', `[${this.appLabel(pid)}] termination reported by launchd (15, 0, 0)`),
      iosLine(sb, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[${this.appLabel(pid)}] Process exited: <RBSProcessExitContext| voluntary>.`),
    ]);
  }

  protected onRunning(firstLaunch: boolean): void {
    this.every(8_000, () => {
      const pick = this.rng.weighted<() => void>([
        [
          () =>
            this.deviceLog([
              {
                level: 'info',
                tag: 'com.apple.CFNetwork',
                subsystem: 'com.apple.CFNetwork',
                category: 'Summary',
                message: `Task <${this.rng.uuid(true)}>.<${this.rng.int(1, 9)}> summary for task success {transaction_duration_ms=${this.rng.int(140, 620)}, response_status=200, connection=${this.rng.int(3, 9)}, protocol="h2", domain_lookup_duration_ms=0, connect_duration_ms=0, secure_connection_duration_ms=0, private_relay=false, request_start_ms=1, request_duration_ms=0, response_start_ms=${this.rng.int(120, 600)}, response_duration_ms=${this.rng.int(2, 30)}, request_bytes=${this.rng.int(280, 420)}, response_bytes=${this.rng.int(900, 4200)}, cache_hit=false}`,
              },
            ]),
          1,
        ],
        [() => this.deviceLog([{ level: 'info', tag: 'flutter', message: `Kumbara: ${this.rng.int(2, 4)} hedef senkronize edildi` }]), 0.8],
        [() => this.deviceLog([{ level: 'debug', tag: 'com.apple.UIKit', subsystem: 'com.apple.UIKit', category: 'EventDispatch', message: 'Sending UIEvent type: 0; subtype: 0; to windows: 1' }]), 0.8],
      ]);
      pick();
    });
    if (firstLaunch) this.loop(this.rng.int(100_000, 130_000), 360_000, 540_000, () => this.crash());
  }

  /** SIGSEGV in a release build: syslog shows the exit, the crash-report scan copies the .ips. */
  private crash(): void {
    if (!this.running) return;
    const pid = this.pid as number;
    const ts = this.now();
    this.stop('crash');
    this.deps.sched.after(this.rng.int(3_000, 7_000), () => this.crashRecord(this.ips(pid, ts)));
    this.deps.sched.after(this.rng.int(11_000, 16_000), () => this.launch('user'));
  }
}
