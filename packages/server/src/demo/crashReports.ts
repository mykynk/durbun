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
  const previousLaunch = r.reportTs + 1000 <= r.watchStart;
  const data: Record<string, unknown> = {
    origin: 'dropbox',
    dropboxTag: r.tag,
    package: r.pkg,
    process: r.process,
    pid: r.pid,
    reportTs: r.reportTs,
    previousLaunch,
    version: r.version,
    build: r.versionCode,
    debuggable: false,
    foreground: r.foreground,
  };
  if (r.duplicateOf !== undefined) data.duplicateOf = r.duplicateOf;
  const entry: DeviceLogInput = {
    ts: r.reportTs,
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

export interface IpsInput {
  bundleId: string;
  appName: string;
  process: string;
  pid: number;
  version: string;
  build: string;
  osVersion: string;
  osBuild: string;
  reportTs: number;
  watchStart: number;
  incident: string;
  /** Unsymbolicated frames of the crashed thread: [image, address, load address]. */
  frames: [string, number, number][];
  exceptionType: string;
  signal: string;
  subtype: string;
  termination: string;
  file: string;
}

const hex16 = (n: number) => `0x${n.toString(16).padStart(16, '0')}`;

/** Apple-style unsymbolicated frame line: index, image, address, "<image> + 0x<offset>". */
function frameLine(index: number, image: string, address: number, load: number): string {
  return `${String(index).padEnd(4)}${image.padEnd(Math.max(24, image.length + 1))}${hex16(address)} ${image} + 0x${(address - load).toString(16)}`;
}

/**
 * A crash report copied from the device (devicectl … systemCrashLogs), as one log row — the same shape
 * as the iOS driver's crashReportEntry (platform/ios/crashReport.ts).
 */
export function ipsCrashReport(r: IpsInput): DeviceLogInput {
  const frames = r.frames.map(([image, addr, load], i) => frameLine(i, image, addr, load)).join('\n');
  const exc = `${r.exceptionType} (${r.signal})`;
  return {
    ts: r.reportTs,
    level: 'fatal',
    kind: 'crash',
    origin: 'crash-report',
    tag: 'crash-report',
    message: `${r.appName} ${r.version} (${r.build}) crashed: ${exc} · ${r.subtype}`,
    pid: r.pid,
    process: r.process,
    error: {
      type: r.exceptionType,
      message: `${exc} · ${r.subtype} · Termination: ${r.termination}`,
      stack: `Thread 0 Crashed:\n${frames}`,
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
      termination: r.termination,
      incident: r.incident,
      osVersion: `iPhone OS ${r.osVersion} (${r.osBuild})`,
      bugType: '309',
      file: r.file,
    },
  };
}

/** Flutter engine + app frames of a SIGSEGV in a release build (load addresses differ per launch). */
export function kumbaraIosFrames(slide: number): [string, number, number][] {
  const runner = 0x1029f0000 + slide;
  const flutter = 0x103400000 + slide;
  const app = 0x106c80000 + slide;
  return [
    ['App', app + 0x2c41a8, app],
    ['App', app + 0x2c3f10, app],
    ['App', app + 0x1d02c4, app],
    ['Flutter', flutter + 0x72a1c0, flutter],
    ['Flutter', flutter + 0x72b5e4, flutter],
    ['Flutter', flutter + 0x5d8e30, flutter],
    ['Runner', runner + 0x5c8f4, runner],
    ['CoreFoundation', 0x1a3e44000 + 0x9c3f8, 0x1a3e44000],
    ['CoreFoundation', 0x1a3e44000 + 0x9b8d4, 0x1a3e44000],
    ['GraphicsServices', 0x1e9a10000 + 0x14d8, 0x1e9a10000],
    ['UIKitCore', 0x1a6200000 + 0x3a4cb4, 0x1a6200000],
    ['Runner', runner + 0x8f14, runner],
    ['dyld', 0x1c7f30000 + 0x5ec4, 0x1c7f30000],
  ];
}
