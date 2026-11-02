/**
 * Crash / ANR records the OS keeps for ANY build (SPEC §10.3), shaped like the real drivers' entries:
 * Android `dumpsys dropbox --print data_app_crash|data_app_anr` records (origin 'dropbox') and iOS `.ips`
 * crash reports (origin 'crash-report', unsymbolicated frames). Used by the demo's SDK-less apps.
 */
import type { ErrorInfo } from '@durbun/protocol';
import type { DeviceLogInput } from '../types';

const BUILD_FINGERPRINT = 'google/shiba/shiba:15/AP4A.241205.013/12621605:user/release-keys';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-11-02 09:14:12" in the desktop's local time (dropbox / crash report headers are local). */
export function localStamp(ts: number, millis = false): string {
  const d = new Date(ts);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return millis ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/* ───────────── Android (dropbox) ───────────── */

export type DropboxTag = 'data_app_crash' | 'data_app_anr';

export interface DropboxRecordInput {
  tag: DropboxTag;
  pkg: string;
  process: string;
  pid: number;
  version: string;
  versionCode: string;
  foreground: boolean;
  reportTs: number;
  /** When Dürbün started reading this device: older records are crashes of a previous launch. */
  watchStart: number;
  error: Required<Pick<ErrorInfo, 'type' | 'message' | 'stack'>>;
  /** Record body (Java stack trace / ANR traces). */
  body: string;
  /** Id of the live logcat entry for the same crash (the UI hides this copy). */
  duplicateOf?: number;
}

/**
 * Same LogEntry shape as the Android driver's dropbox reader (platform/android/dropbox.ts): message = the
 * record body (crash) or its Subject (ANR), `data.dropboxTag`, and `pid` only for records of this session
 * (an old record's pid may belong to another process by now).
 */
export function dropboxRecord(r: DropboxRecordInput): DeviceLogInput {
  const anr = r.tag === 'data_app_anr';
  const reportTs = Math.floor(r.reportTs / 1000) * 1000; // dropbox keeps whole seconds
  const previousLaunch = reportTs + 1000 <= r.watchStart;
  const data: Record<string, unknown> = {
    origin: 'dropbox',
    dropboxTag: r.tag,
    package: r.pkg,
    process: r.process,
    pid: r.pid,
    reportTs,
    previousLaunch,
    version: r.version,
    build: r.versionCode,
    debuggable: false,
    foreground: r.foreground,
  };
  if (r.duplicateOf !== undefined) data.duplicateOf = r.duplicateOf;
  const entry: DeviceLogInput = {
    ts: reportTs,
    level: anr ? 'error' : 'fatal',
    tag: r.tag,
    message: anr ? r.error.message : r.body.trim(),
    process: r.process,
    kind: anr ? 'anr' : 'crash',
    origin: 'dropbox',
    data,
    error: { ...r.error },
  };
  if (!previousLaunch) entry.pid = r.pid;
  return entry;
}

/** Kotlin home-screen widget of Kumbara (native layer) — the crash a tester saw this morning. */
export const KUMBARA_WIDGET_NPE: Required<Pick<ErrorInfo, 'type' | 'message' | 'stack'>> = {
  // type / message as the dropbox reader parses them: the first line of the record body.
  type: 'java.lang.RuntimeException',
  message:
    "Unable to start receiver com.mykynk.kumbara.widget.GoalWidgetProvider: java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String com.mykynk.kumbara.goal.Goal.getTitle()' on a null object reference",
  stack: `java.lang.RuntimeException: Unable to start receiver com.mykynk.kumbara.widget.GoalWidgetProvider: java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String com.mykynk.kumbara.goal.Goal.getTitle()' on a null object reference
	at android.app.ActivityThread.handleReceiver(ActivityThread.java:5003)
	at android.app.ActivityThread.-$$Nest$mhandleReceiver(Unknown Source:0)
	at android.app.ActivityThread$H.handleMessage(ActivityThread.java:2611)
	at android.os.Handler.dispatchMessage(Handler.java:107)
	at android.os.Looper.loopOnce(Looper.java:232)
	at android.os.Looper.loop(Looper.java:317)
	at android.app.ActivityThread.main(ActivityThread.java:8699)
	at java.lang.reflect.Method.invoke(Native Method)
	at com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run(RuntimeInit.java:580)
	at com.android.internal.os.ZygoteInit.main(ZygoteInit.java:886)
Caused by: java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String com.mykynk.kumbara.goal.Goal.getTitle()' on a null object reference
	at com.mykynk.kumbara.widget.GoalWidgetProvider.renderGoal(GoalWidgetProvider.kt:58)
	at com.mykynk.kumbara.widget.GoalWidgetProvider.onUpdate(GoalWidgetProvider.kt:31)
	at android.appwidget.AppWidgetProvider.onReceive(AppWidgetProvider.java:66)
	at com.mykynk.kumbara.widget.GoalWidgetProvider.onReceive(GoalWidgetProvider.kt:24)
	at android.app.ActivityThread.handleReceiver(ActivityThread.java:4994)
	... 9 more`,
};

/** A MethodChannel handler in the Kotlin layer throws while Flutter calls it. */
export const KUMBARA_CHANNEL_CRASH: Required<Pick<ErrorInfo, 'type' | 'message' | 'stack'>> = {
  type: 'java.lang.IllegalArgumentException',
  message: 'Unknown goal currency: XAU',
  stack: `java.lang.IllegalArgumentException: Unknown goal currency: XAU
	at com.mykynk.kumbara.money.CurrencyKt.parseCurrency(Currency.kt:41)
	at com.mykynk.kumbara.bridge.GoalChannel.createGoal(GoalChannel.kt:87)
	at com.mykynk.kumbara.bridge.GoalChannel.onMethodCall(GoalChannel.kt:52)
	at io.flutter.plugin.common.MethodChannel$IncomingMethodCallHandler.onMessage(MethodChannel.java:267)
	at io.flutter.embedding.engine.dart.DartMessenger.invokeHandler(DartMessenger.java:292)
	at io.flutter.embedding.engine.dart.DartMessenger.lambda$dispatchMessageToQueue$0$io-flutter-embedding-engine-dart-DartMessenger(DartMessenger.java:319)
	at io.flutter.embedding.engine.dart.DartMessenger$$ExternalSyntheticLambda0.run(D8$$SyntheticClass:0)
	at android.os.Handler.handleCallback(Handler.java:959)
	at android.os.Handler.dispatchMessage(Handler.java:100)
	at android.os.Looper.loopOnce(Looper.java:232)
	at android.os.Looper.loop(Looper.java:317)
	at android.app.ActivityThread.main(ActivityThread.java:8699)
	at java.lang.reflect.Method.invoke(Native Method)
	at com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run(RuntimeInit.java:580)
	at com.android.internal.os.ZygoteInit.main(ZygoteInit.java:886)`,
};

/** The grouped logcat crash (what the logcat parser produces for AndroidRuntime FATAL EXCEPTION). */
export function logcatFatal(process: string, pid: number, error: Required<Pick<ErrorInfo, 'type' | 'message' | 'stack'>>): string {
  return `FATAL EXCEPTION: main\nProcess: ${process}, PID: ${pid}\n${error.stack}`;
}

/** Main-thread stack of the ANR: Room write on the main thread from the Kotlin bridge. */
export function kumbaraAnrTraces(pid: number, ts: number): { body: string; stack: string } {
  const stack = `"main" prio=5 tid=1 Native
  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72c1e3b8 self=0xb400007a1c2f3000
  | sysTid=${pid} nice=-10 cgrp=top-app sched=0/0 handle=0x7b8f0a54f8
  | state=S schedstat=( 2814306532 412308911 4021 ) utm=241 stm=40 core=5 HZ=100
  native: #00 pc 000000000005f2a8  /apex/com.android.runtime/lib64/bionic/libc.so (fdatasync+8)
  native: #01 pc 00000000000c9a10  /system/lib64/libsqlite.so (unixSync+176)
  at android.database.sqlite.SQLiteConnection.nativeExecuteForChangedRowCount(Native method)
  at android.database.sqlite.SQLiteConnection.executeForChangedRowCount(SQLiteConnection.java:972)
  at android.database.sqlite.SQLiteSession.executeForChangedRowCount(SQLiteSession.java:752)
  at androidx.sqlite.db.framework.FrameworkSQLiteStatement.executeUpdateDelete(FrameworkSQLiteStatement.kt:38)
  at com.mykynk.kumbara.data.GoalDao_Impl.updateAll(GoalDao_Impl.java:211)
  at com.mykynk.kumbara.bridge.GoalChannel.syncGoals(GoalChannel.kt:64)
  at com.mykynk.kumbara.bridge.GoalChannel.onMethodCall(GoalChannel.kt:49)
  at io.flutter.plugin.common.MethodChannel$IncomingMethodCallHandler.onMessage(MethodChannel.java:267)
  at android.os.Handler.handleCallback(Handler.java:959)
  at android.os.Looper.loop(Looper.java:317)
  at android.app.ActivityThread.main(ActivityThread.java:8699)`;
  const body = `----- pid ${pid} at ${localStamp(ts, true)} -----\nCmd line: com.mykynk.kumbara\nBuild fingerprint: '${BUILD_FINGERPRINT}'\nABI: 'arm64'\n\n${stack}\n\n----- end ${pid} -----`;
  return { body, stack };
}

/* ───────────── iOS (.ips crash reports) ───────────── */

/** One frame of the crashed thread: image (name, on-device path, load address) + offset; system frames carry symbols. */
export interface IpsDemoFrame {
  image: string;
  path: string;
  base: number;
  offset: number;
  symbol?: string;
  symbolLocation?: number;
}

export interface IpsInput {
  bundleId: string;
  appName: string;
  process: string;
  /** On-device path of the executable (…/Runner.app/Runner). */
  procPath: string;
  pid: number;
  version: string;
  build: string;
  model: string;
  osVersion: string;
  osBuild: string;
  reportTs: number;
  watchStart: number;
  incident: string;
  frames: IpsDemoFrame[];
  exceptionType: string;
  signal: string;
  subtype: string;
  /** Mach exception codes, e.g. "0x0000000000000001, 0x0000000000000010". */
  codes: string;
  /** termination.indicator, e.g. "Segmentation fault: 11" (namespace SIGNAL, code = the signal number). */
  indicator: string;
  signalNumber: number;
  /** Name of the copy, e.g. "Runner-2026-11-02-091412.ips". */
  fileName: string;
}

/** Where the copy of a report lives and how the UI downloads it (SPEC §10.3; same as the iOS driver). */
export interface IpsCopy {
  /** Absolute path of the copy (`<tempDir>/crash/<udid>/<fileName>`). */
  file: string;
  /** `/api/files/crash/<udid>/<fileName>`. */
  reportUrl: string;
}

const hex16 = (n: number) => `0x${n.toString(16).padStart(16, '0')}`;

/** Apple-style frame line, as the iOS driver prints it (platform/ios/crashReport.ts formatFrame). */
function frameLine(index: number, f: IpsDemoFrame): string {
  const tail = f.symbol ? `${f.symbol}${f.symbolLocation !== undefined ? ` + ${f.symbolLocation}` : ''}` : `${f.image} + 0x${f.offset.toString(16)}`;
  return `${String(index).padEnd(4)}${f.image.padEnd(Math.max(24, f.image.length + 1))}${hex16(f.base + f.offset)} ${tail}`;
}

/** "2026-11-02 09:14:12.3450 +0300" — the local time stamps of .ips files (`digits` fraction digits). */
function ipsStamp(ts: number, digits: number): string {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const zone = `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
  const frac = pad(d.getMilliseconds(), 3).padEnd(digits, '0').slice(0, digits);
  return `${localStamp(ts)}.${frac} ${zone}`;
}

/**
 * The crash report file itself, as `devicectl device copy from --domain-type systemCrashLogs` copies it:
 * a JSON header line and the JSON body (bug_type 309, iOS 15+). Small but complete enough for Xcode and
 * for the iOS driver's parser; app frames stay unsymbolicated (release build, no dSYM on the device).
 */
export function ipsReportText(r: IpsInput): string {
  const images: IpsDemoFrame[] = [];
  for (const f of r.frames) if (!images.some((i) => i.image === f.image)) images.push(f);
  const header = {
    app_name: r.appName,
    timestamp: ipsStamp(r.reportTs + 410, 2),
    app_version: r.version,
    slice_uuid: '6f0e5c1e-8d2b-3f4a-9b7c-1a2d3e4f5a6b',
    build_version: r.build,
    platform: 2,
    bundleID: r.bundleId,
    share_with_app_devs: 0,
    is_first_party: 0,
    bug_type: '309',
    os_version: `iPhone OS ${r.osVersion} (${r.osBuild})`,
    roots_installed: 0,
    name: r.process,
    incident_id: r.incident,
  };
  const body = {
    uptime: 186_000,
    procRole: 'Foreground',
    version: 2,
    userID: 501,
    deployVersion: 210,
    modelCode: r.model,
    coalitionID: 1_312,
    osVersion: { isEmbedded: true, train: `iPhone OS ${r.osVersion}`, releaseType: 'User', build: r.osBuild },
    captureTime: ipsStamp(r.reportTs, 4),
    codeSigningMonitor: 1,
    incident: r.incident,
    pid: r.pid,
    translated: false,
    cpuType: 'ARM-64',
    roots_installed: 0,
    bug_type: '309',
    procName: r.process,
    procPath: r.procPath,
    bundleInfo: { CFBundleShortVersionString: r.version, CFBundleVersion: r.build, CFBundleIdentifier: r.bundleId },
    storeInfo: { deviceIdentifierForVendor: 'B6B2E3F1-4C3A-4A7E-9D61-2F8C0A1B3D5E', thirdParty: true },
    parentProc: 'launchd',
    parentPid: 1,
    coalitionName: r.bundleId,
    crashReporterKey: '4b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c',
    isCorpse: 1,
    exception: { codes: r.codes, rawCodes: r.codes.split(',').map((c) => Number.parseInt(c.trim(), 16)), type: r.exceptionType, signal: r.signal, subtype: r.subtype },
    termination: { flags: 0, code: r.signalNumber, namespace: 'SIGNAL', indicator: r.indicator, byProc: 'exc handler', byPid: r.pid },
    vmregion: { loadAddress: 0, summary: '0x0000000000000010 is not in any region.' },
    faultingThread: 0,
    threads: [
      {
        triggered: true,
        id: 1_204_187,
        queue: 'com.apple.main-thread',
        frames: r.frames.map((f) => ({
          imageOffset: f.offset,
          ...(f.symbol ? { symbol: f.symbol } : {}),
          ...(f.symbolLocation !== undefined ? { symbolLocation: f.symbolLocation } : {}),
          imageIndex: images.findIndex((i) => i.image === f.image),
        })),
      },
    ],
    usedImages: images.map((i) => ({ source: 'P', arch: 'arm64', base: i.base, name: i.image, path: i.path })),
    sharedCache: { base: 6_442_450_944, size: 4_105_617_408, uuid: '9f1e7c2a-3b4d-3e5f-8a6b-7c8d9e0f1a2b' },
    legacyInfo: { threadTriggered: { queue: 'com.apple.main-thread' } },
    logWritingSignature: 'b7e1d2c3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9',
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}\n`;
}

/**
 * A crash report copied from the device (devicectl … systemCrashLogs), as one log row: the same shape as
 * the iOS driver's crashReportEntry (platform/ios/crashReport.ts) for this report, plus the copy's path
 * and download URL when the copy could be written.
 */
export function ipsCrashReport(r: IpsInput, copy?: IpsCopy): DeviceLogInput {
  const frames = r.frames.map((f, i) => frameLine(i, f)).join('\n');
  const exc = `${r.exceptionType} (${r.signal})`;
  const termination = `SIGNAL ${r.signalNumber} ${r.indicator}`;
  return {
    ts: r.reportTs,
    level: 'fatal',
    kind: 'crash',
    origin: 'crash-report',
    tag: 'crash-report',
    message: `${r.appName} ${r.version} (${r.build}) crashed: ${exc} · ${r.subtype}`,
    error: {
      type: r.exceptionType,
      message: `${exc} · ${r.subtype} · Termination: ${termination}`,
      stack: `Thread 0 Crashed (com.apple.main-thread):\n${frames}`,
    },
    data: {
      origin: 'crash-report',
      bundleId: r.bundleId,
      reportTs: r.reportTs,
      previousLaunch: r.reportTs < r.watchStart,
      symbolicated: false,
      appName: r.appName,
      version: r.version,
      build: r.build,
      exceptionType: r.exceptionType,
      signal: r.signal,
      termination,
      incident: r.incident,
      osVersion: `iPhone OS ${r.osVersion} (${r.osBuild})`,
      bugType: '309',
      ...(copy ? { file: copy.file, reportUrl: copy.reportUrl } : {}),
    },
    process: r.process,
    pid: r.pid,
  };
}

/** Flutter engine + app frames of a SIGSEGV in a release build (`slide` = per-launch ASLR shift). */
export function kumbaraIosFrames(slide: number, bundlePath: string): IpsDemoFrame[] {
  const app = { image: 'App', path: `${bundlePath}/Frameworks/App.framework/App`, base: 0x106c80000 + slide };
  const flutter = { image: 'Flutter', path: `${bundlePath}/Frameworks/Flutter.framework/Flutter`, base: 0x103400000 + slide };
  const runner = { image: 'Runner', path: `${bundlePath}/Runner`, base: 0x1029f0000 + slide };
  const cf = { image: 'CoreFoundation', path: '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', base: 0x1a3e44000 };
  const gs = { image: 'GraphicsServices', path: '/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices', base: 0x1e9a10000 };
  const uikit = { image: 'UIKitCore', path: '/System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore', base: 0x1a6200000 };
  const dyld = { image: 'dyld', path: '/usr/lib/dyld', base: 0x1c7f30000 };
  return [
    { ...app, offset: 0x2c41a8 },
    { ...app, offset: 0x2c3f10 },
    { ...app, offset: 0x1d02c4 },
    { ...flutter, offset: 0x72a1c0 },
    { ...flutter, offset: 0x72b5e4 },
    { ...flutter, offset: 0x5d8e30 },
    { ...runner, offset: 0x5c8f4 },
    { ...cf, offset: 0x9c3f8, symbol: '__CFRUNLOOP_IS_CALLING_OUT_TO_A_SOURCE1_PERFORM_FUNCTION__', symbolLocation: 60 },
    { ...cf, offset: 0x9b8d4, symbol: '__CFRunLoopDoSource1', symbolLocation: 520 },
    { ...cf, offset: 0x99f88, symbol: '__CFRunLoopRun', symbolLocation: 1872 },
    { ...cf, offset: 0x99250, symbol: 'CFRunLoopRunSpecific', symbolLocation: 608 },
    { ...gs, offset: 0x14d8, symbol: 'GSEventRunModal', symbolLocation: 164 },
    { ...uikit, offset: 0x3a4cb4, symbol: '-[UIApplication _run]', symbolLocation: 888 },
    { ...uikit, offset: 0x453a4c, symbol: 'UIApplicationMain', symbolLocation: 340 },
    { ...runner, offset: 0x8f14 },
    { ...dyld, offset: 0x5ec4, symbol: 'start', symbolLocation: 2724 },
  ];
}
