/** Realistic LogEntry / AppSession fixtures for the query tests (shapes per SPEC §9). */
import type { AppSession, LogEntry } from '@durbun/protocol';

export const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
let nextId = 1;

export function entry(partial: Partial<LogEntry> & Pick<LogEntry, 'message'>): LogEntry {
  return {
    id: nextId++,
    ts: NOW - 1_000,
    deviceId: 'demo:1',
    source: 'device',
    level: 'info',
    tag: 'App',
    ...partial,
  };
}

function session(id: string, deviceId: string, name: string, bundleId: string, platform: AppSession['sdk']['platform'], extra: Partial<AppSession['app']> = {}): AppSession {
  return {
    id,
    sessionKey: `${id}-key`,
    deviceId,
    sdk: { name: platform === 'flutter' ? 'durbun-flutter' : 'durbun-android', version: '0.1.0', platform },
    app: { name, id: bundleId, version: '1.4.0', ...extra },
    transport: 'demo',
    connected: true,
    connectedAt: NOW - 60_000,
    capabilities: ['logs', 'network'],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  };
}

export const APPS: Record<string, AppSession> = {
  'app:1': session('app:1', 'demo:1', 'Pati', 'com.mykynk.pati', 'flutter', { pid: 4123 }),
  'app:2': session('app:2', 'demo:1', 'Mahalle', 'com.mykynk.mahalle', 'android', { pid: 5120 }),
  'app:3': session('app:3', 'demo:2', 'Pati', 'com.mykynk.pati', 'flutter', { processName: 'Runner', pid: 811 }),
  'app:4': session('app:4', 'demo:2', 'Kasa', 'com.mykynk.kasa', 'ios', { processName: 'Kasa', pid: 812 }),
};

export const JAVA_CRASH = `FATAL EXCEPTION: main
Process: com.mykynk.mahalle, PID: 5120
java.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} not attached to a context.
	at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)
	at com.mykynk.mahalle.ui.basket.BasketFragment.renderTotals(BasketFragment.kt:214)
	at kotlinx.coroutines.DispatchedTask.run(DispatchedTask.kt:108)
	at android.os.Looper.loop(Looper.java:317)
	at java.lang.reflect.Method.invoke(Native Method)`;

export const DART_STACK = `#0      PaymentService.charge (package:pati/core/payment/payment_service.dart:88:7)
<asynchronous suspension>
#1      CheckoutController.submit (package:pati/features/checkout/checkout_controller.dart:142:22)
<asynchronous suspension>`;

export const FLUTTER_BOX = `══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════════════════════════════════════════════
The following assertion was thrown during layout:
A RenderFlex overflowed by 38 pixels on the right.

The relevant error-causing widget was:
  Row Row:file:///Users/deniz/dev/pati/lib/features/pets/widgets/pet_card.dart:57:16
════════════════════════════════════════════════════════════════════════════════════════════════════`;

export const IOS_NATIVE_CRASH =
  "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[__NSCFString objectForKey:]: unrecognized selector sent to instance 0x600000c8c120'\n*** First throw call stack:\n(0x180b21234 0x18015b3d8 0x180b2a5c4 0x180b0c8a4 0x180b0de8c 0x104a1c2d8)\nlibc++abi: terminating due to uncaught exception of type NSException";

export const SWIFT_FRAMES = `Fatal error: Unexpectedly found nil while unwrapping an Optional value
0   libswiftCore.dylib            0x00000001a6d4c1f8 $ss17_assertionFailure_:file:line:flags:Ss + 248
1   Kasa                          0x0000000102a5c1a4 $s4Kasa14CartViewModelC5totalSdvg + 120
2   SwiftUI                       0x00000001b2f1e9a0 0x1b2e00000 + 1174944`;

export const JS_FRAMES = `TypeError: undefined is not an object (evaluating 'user.profile.name')
    at render (http://localhost:8081/index.bundle?platform=ios:118734:41)
    at App (http://localhost:8081/index.bundle?platform=ios:22045:10)`;

export const JSC_FRAMES = `TypeError: null is not an object
render@http://localhost:8081/index.bundle:1234:56
App@http://localhost:8081/index.bundle:22:10`;

export const NATIVE_TOMBSTONE = `*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
signal 6 (SIGABRT), code -1 (SI_QUEUE), fault addr --------
      #00 pc 000000000004f0f4  /apex/com.android.runtime/lib64/bionic/libc.so (abort+164)
      #01 pc 00000000000a2c3c  /data/app/com.mykynk.mahalle/lib/arm64/libnative.so`;

/** One fixture per interesting case, all on realistic devices/apps. */
export const FX = {
  androidCrash: entry({ level: 'fatal', tag: 'AndroidRuntime', process: 'com.mykynk.mahalle', pid: 5120, kind: 'crash', message: JAVA_CRASH }),
  anr: entry({
    level: 'error',
    tag: 'ActivityManager',
    process: 'system_server',
    pid: 1043,
    kind: 'anr',
    message: 'ANR in com.mykynk.mahalle (com.mykynk.mahalle/.ui.MainActivity)\nPID: 5120\nReason: Input dispatching timed out',
  }),
  iosFault: entry({
    deviceId: 'demo:2',
    level: 'error',
    tag: 'com.apple.network',
    process: 'Runner',
    pid: 811,
    message: 'nw_connection_copy_connected_local_endpoint_block_invoke [C3] Connection has no local endpoint',
  }),
  flutterBox: entry({
    level: 'error',
    tag: 'flutter',
    process: 'com.mykynk.pati',
    pid: 4123,
    kind: 'flutter-error',
    message: FLUTTER_BOX,
    error: { message: 'A RenderFlex overflowed by 38 pixels on the right.' },
  }),
  dartCrashSdk: entry({
    source: 'app',
    appId: 'app:1',
    level: 'fatal',
    tag: 'zone',
    kind: 'crash',
    message: 'Unhandled exception: Null check operator used on a null value',
    error: { type: '_TypeError', message: 'Null check operator used on a null value', stack: DART_STACK },
  }),
  jsonLine: entry({
    source: 'app',
    appId: 'app:1',
    level: 'debug',
    tag: 'api',
    message: 'Response 200 {"items":[{"id":40,"name":"Pamuk","city":"İstanbul"}],"next":"eyJvIjo0MH0"}',
  }),
  dataLine: entry({ source: 'app', appId: 'app:2', level: 'info', tag: 'auth', message: 'Kullanıcı giriş yaptı', data: { userId: 4821 } }),
  networkRow: entry({ source: 'app', appId: 'app:1', level: 'info', tag: 'network', kind: 'network', netId: 'app:1:17', message: 'GET https://api.pati.app/v1/pets?page=2' }),
  marker: entry({ deviceId: '', source: 'system', level: 'info', tag: 'durbun', kind: 'marker', code: 'marker', params: { label: 'Ödeme testi', n: 1 }, message: 'Ödeme testi' }),
  event: entry({ source: 'app', appId: 'app:1', level: 'info', tag: 'event', kind: 'event', message: 'purchase', data: { amount: 49.9 } }),
  chatty: entry({ level: 'info', tag: 'chatty', process: 'system_server', pid: 1043, message: 'uid=1000(system) Binder:1043_5 expire 3 lines', ts: NOW - 10 * 60_000 }),
  okhttp: entry({ level: 'warn', tag: 'OkHttp', process: 'com.mykynk.mahalle', pid: 5120, message: '<-- HTTP FAILED: java.net.SocketException: Connection reset' }),
  dioError: entry({ source: 'app', appId: 'app:1', level: 'error', tag: 'dio', message: 'DioException [connection error]: connection reset by peer' }),
  deviceLinePati: entry({ level: 'debug', tag: 'flutter', process: 'com.mykynk.pati', pid: 4123, message: 'Pet loaded in 123ms' }),
  deviceLinePatiSub: entry({ level: 'info', tag: 'FirebaseMessaging', process: 'com.mykynk.pati:remote', pid: 4200, message: 'Token refreshed' }),
  deviceLineRunner: entry({ deviceId: 'demo:2', level: 'info', tag: 'Runner', process: 'Runner', message: 'flutter: Sepet güncellendi' }),
  deviceLineRunnerOtherDevice: entry({ deviceId: 'demo:3', level: 'info', tag: 'Runner', process: 'Runner', message: 'unrelated Runner app on another device' }),
  kasaLine: entry({ deviceId: 'demo:2', source: 'device', appId: 'app:4', level: 'info', tag: 'Kasa', process: 'Kasa', pid: 812, message: 'Kasa açıldı' }),
  processStarted: entry({ source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'process.started', params: { process: 'com.mykynk.pati', pid: 4123 }, message: 'Process started: com.mykynk.pati (pid 4123)' }),
  verbose: entry({ level: 'verbose', tag: 'ViewRootImpl', process: 'com.mykynk.pati', pid: 4123, message: 'Relayout returned: old=(0,0,1080,2400) new=(0,0,1080,2400)' }),
  old: entry({ level: 'warn', tag: 'Choreographer', process: 'com.mykynk.pati', pid: 4123, message: 'Skipped 48 frames! The application may be doing too much work on its main thread.', ts: NOW - 2 * 3_600_000 }),
};

export const ALL: LogEntry[] = Object.values(FX);
