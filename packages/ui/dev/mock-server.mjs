#!/usr/bin/env node
/**
 * Dürbün UI dev mock — a stand-in for the real server so the UI can be built and judged without
 * hardware. Node + `ws` only.
 *
 *   node packages/ui/dev/mock-server.mjs [--port 9799] [--empty] [--rate 30]
 *   DURBUN_SERVER=http://127.0.0.1:9799 npx vite --port 5179     (from packages/ui)
 *
 * WS /ui: hello → snapshot (3 devices, 3 apps + an older session, device apps, mocks, drivers) → ~2000
 * history logs → live batches (logs, network, metrics, device apps, occasional device/app changes). Every
 * command gets {ok: true} with plausible data. REST: /api/health, /api/doctor, /api/network/:id (+ bodies),
 * /api/network/search, /api/export, /api/import, /api/har, /api/upload, /api/files/crash/:udid/:name.
 * Phase 3 (SPEC §10): apps without the SDK (`snapshot.deviceApps`: a Play build, a Firebase build, an APK
 * installed by hand, a TestFlight build next to an Xcode build — both "Runner" — on a USB iPhone), exact
 * log origins, dropbox / .ips crash records (one marked `duplicateOf`, one with a downloadable .ips),
 * device readers (frame stats without data on the Pixel, dropbox refused on the Galaxy) and SDK layers.
 * `--empty` starts with no devices (onboarding); `demo.set {enabled:true}` then fills everything.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argValue('--port', process.env.MOCK_PORT ?? 9799));
const RATE = Number(argValue('--rate', 30)); // average log lines per second
let empty = args.includes('--empty');

/* ───────────── deterministic randomness ───────────── */
let seed = 1337;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p) => rnd() < p;

/* ───────────── state ───────────── */
const startedAt = Date.now();
let settings = {
  maxLogEntries: 200000,
  maxNetworkEntries: 5000,
  maxBodyBytes: 1048576,
  maxBodyStoreMB: 256,
  captureBodies: true,
  logcatTail: 2000,
  iosSimLogScope: 'apps',
  iosSimLogLevel: 'info',
  iosDeviceLogScope: 'apps',
  autoAttachVmService: true,
  watchedApps: [],
  allowLan: false,
  metricsIntervalMs: 1000,
};
const server = () => ({
  name: 'durbun',
  version: '0.1.0',
  protocol: 1,
  ports: { http: PORT, sdk: 9751 },
  startedAt,
  demo: !empty,
  lan: settings.allowLan,
  hostAddresses: ['192.168.1.20', '10.0.0.7'],
  dataDir: '/Users/dev/.durbun',
  platform: 'darwin',
});

const ANDROID_ACTIONS = ['screenshot', 'open-url', 'list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-clear-data', 'app-uninstall', 'app-install', 'logs-clear-buffer', 'logs-restart', 'appearance', 'font-scale', 'animations', 'input-text', 'key-event', 'screen-record', 'screen-record-stop'];
const SIM_ACTIONS = ['screenshot', 'open-url', 'list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-clear-data', 'app-uninstall', 'app-install', 'appearance', 'font-scale', 'push-notification', 'location', 'status-bar', 'logs-restart', 'screen-record', 'screen-record-stop'];

function baseDevices() {
  return [
    {
      id: 'android:R5CT20XK9QM',
      platform: 'android',
      kind: 'physical',
      name: 'Pixel 8',
      model: 'Pixel 8',
      manufacturer: 'Google',
      osVersion: '15',
      apiLevel: 35,
      serial: 'R5CT20XK9QM',
      connection: 'usb',
      state: 'online',
      battery: { level: 82, charging: true },
      screen: { width: 1080, height: 2400, density: 420 },
      logs: { status: 'streaming', via: 'logcat' },
      actions: ANDROID_ACTIONS,
      readers: {
        crashReports: { status: 'ok', lastOk: Date.now() },
        frameStats: { status: 'unavailable', code: 'reader.frameStats.noData', detail: 'Neither gfxinfo nor SurfaceFlinger gave frames for com.mykynk.kumbara' },
      },
      firstSeen: startedAt - 600_000,
      lastSeen: Date.now(),
    },
    {
      id: 'ios-sim:7C1F2B9E-41A3-4D7E-9C2B-1F00D3A4B5C6',
      platform: 'ios',
      kind: 'simulator',
      name: 'iPhone 16 Pro',
      model: 'iPhone17,1',
      manufacturer: 'Apple',
      osVersion: '18.2',
      serial: '7C1F2B9E-41A3-4D7E-9C2B-1F00D3A4B5C6',
      connection: 'local',
      state: 'online',
      screen: { width: 1206, height: 2622, density: 3 },
      logs: { status: 'streaming', via: 'simctl log stream' },
      actions: SIM_ACTIONS,
      readers: { crashReports: { status: 'ok', lastOk: Date.now() }, frameStats: { status: 'unsupported', code: 'reader.frameStats.unsupported' } },
      firstSeen: startedAt - 400_000,
      lastSeen: Date.now(),
    },
    {
      id: IPHONE,
      platform: 'ios',
      kind: 'physical',
      name: 'Ayşe’nin iPhone’u',
      model: 'iPhone14,5',
      manufacturer: 'Apple',
      osVersion: '18.1',
      serial: IPHONE_UDID,
      connection: 'usb',
      state: 'online',
      battery: { level: 64, charging: false },
      logs: { status: 'streaming', via: 'idevicesyslog' },
      actions: ['screenshot', 'list-apps', 'app-launch', 'app-stop'],
      readers: {
        crashReports: { status: 'ok', lastOk: Date.now() },
        frameStats: { status: 'unsupported', code: 'reader.frameStats.unsupported', detail: 'iOS does not give the frame timing of an app to the Mac' },
      },
      firstSeen: startedAt - 300_000,
      lastSeen: Date.now(),
    },
  ];
}

const PIXEL = 'android:R5CT20XK9QM';
const SIM = 'ios-sim:7C1F2B9E-41A3-4D7E-9C2B-1F00D3A4B5C6';
const IPHONE_UDID = '00008110-001A2B3C4D5E6F70';
const IPHONE = `ios:${IPHONE_UDID}`;
/** The .ips copy the server keeps for the TestFlight crash (served by /api/files/crash/…). */
const IPS_NAME = 'Runner-2026-11-02-213004.ips';
const IPS_URL = `/api/files/crash/${encodeURIComponent(IPHONE_UDID)}/${encodeURIComponent(IPS_NAME)}`;
const FLUTTER_ACTIONS = [
  { id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', group: 'flutter', value: false },
  { id: 'flutter.repaintRainbow', kind: 'toggle', label: 'Repaint rainbow', group: 'flutter', value: false },
  { id: 'flutter.slowAnimations', kind: 'toggle', label: 'Slow animations', group: 'flutter', value: false },
  { id: 'flutter.brightness', kind: 'select', label: 'Brightness', group: 'flutter', value: 'system', options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
  { id: 'flutter.dumpWidgetTree', kind: 'button', label: 'Dump widget tree', group: 'flutter' },
];

function baseApps() {
  const caps = ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'];
  return [
    {
      id: 'app:1',
      sessionKey: 's-pati-old',
      deviceId: PIXEL,
      sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' },
      app: { name: 'Pati', id: 'com.mykynk.pati', version: '1.4.1', build: '41', pid: 11873, processName: 'com.mykynk.pati', debug: true },
      transport: 'adb-reverse',
      connected: false,
      connectedAt: startedAt - 540_000,
      disconnectedAt: startedAt - 300_000,
      capabilities: caps,
      actions: FLUTTER_ACTIONS,
      stats: { logs: 812, requests: 64, errors: 3 },
    },
    {
      id: 'app:2',
      sessionKey: 's-pati',
      deviceId: PIXEL,
      sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter', layers: ['dart', 'android'] },
      app: { name: 'Pati', id: 'com.mykynk.pati', version: '1.4.2', build: '42', pid: 12345, processName: 'com.mykynk.pati', debug: true },
      transport: 'adb-reverse',
      connected: true,
      connectedAt: startedAt - 280_000,
      capabilities: caps,
      actions: FLUTTER_ACTIONS,
      stats: { logs: 0, requests: 0, errors: 0 },
    },
    {
      id: 'app:3',
      sessionKey: 's-kasa',
      deviceId: PIXEL,
      sdk: { name: 'durbun-android', version: '0.1.0', platform: 'android' },
      app: { name: 'Kasa', id: 'com.mykynk.kasa', version: '2.0.1', build: '201', pid: 13002, processName: 'com.mykynk.kasa', debug: true },
      transport: 'adb-reverse',
      connected: true,
      connectedAt: startedAt - 200_000,
      capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'crash'],
      actions: [],
      stats: { logs: 0, requests: 0, errors: 0 },
    },
    {
      id: 'app:4',
      sessionKey: 's-pati-ios',
      deviceId: SIM,
      sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter', layers: ['dart', 'ios'] },
      app: { name: 'Pati', id: 'com.mykynk.pati', version: '1.4.2', build: '42', pid: 48211, processName: 'Runner', debug: true },
      transport: 'tcp',
      connected: true,
      connectedAt: startedAt - 150_000,
      capabilities: caps,
      actions: FLUTTER_ACTIONS,
      stats: { logs: 0, requests: 0, errors: 0 },
    },
  ];
}

/** Apps the devices report (SPEC §10.2), with or without the SDK; SDK apps join their sessions by bundle id. */
function baseDeviceApps() {
  const da = (deviceId, id, p) => ({ key: `${deviceId}|${id}`, deviceId, id, pids: [], running: false, lastActivity: Date.now(), ...p });
  const DAY = 86_400_000;
  return [
    da(PIXEL, 'com.mykynk.pati', { name: 'Pati', version: '1.4.2', build: '42', buildType: 'debug', install: { source: 'adb', installer: 'com.android.shell', lastUpdate: startedAt - 35 * 60_000 }, pids: [12345], running: true }),
    da(PIXEL, 'com.mykynk.kasa', { name: 'Kasa', version: '2.0.1', build: '201', buildType: 'debug', install: { source: 'adb' }, pids: [13002], running: true }),
    da(PIXEL, 'com.mykynk.kumbara', {
      name: 'Kumbara',
      version: '3.1.0',
      build: '412',
      buildType: 'release',
      install: { source: 'play', installer: 'com.android.vending', firstInstall: startedAt - 40 * DAY, lastUpdate: startedAt - 3 * DAY },
      pids: [14210, 14388],
      running: true,
      crashReports: 2,
    }),
    da(PIXEL, 'com.mykynk.pati.qa', { name: 'Pati QA', version: '1.5.0', build: '57', buildType: 'release', install: { source: 'firebase', installer: 'dev.firebase.appdistribution' }, lastActivity: Date.now() - 6 * 60_000 }),
    da(PIXEL, 'com.mykynk.mahalle', { name: 'Mahalle', version: '0.9.0', build: '90', buildType: 'release', install: { source: 'other-store', installer: 'com.google.android.packageinstaller' }, lastActivity: Date.now() - 11 * 60_000 }),
    da(SIM, 'com.mykynk.pati', { name: 'Pati', version: '1.4.2', build: '42', buildType: 'debug', install: { source: 'simulator' }, processName: 'Runner', pids: [48211], running: true }),
    // Two Flutter apps on one iPhone, both "Runner": a TestFlight build and an Xcode build.
    da(IPHONE, 'com.mykynk.kumbara', { name: 'Kumbara', version: '3.1.0', build: '412', buildType: 'release', install: { source: 'store-or-testflight' }, processName: 'Runner', pids: [811], running: true, crashReports: 1 }),
    da(IPHONE, 'com.mykynk.pati', { name: 'Pati', version: '1.5.0', build: '58', buildType: 'debug', install: { source: 'xcode' }, processName: 'Runner', lastActivity: Date.now() - 9 * 60_000 }),
  ];
}

let devices = empty ? [] : baseDevices();
let apps = empty ? [] : baseApps();
let deviceApps = empty ? [] : baseDeviceApps();
let mocks = [
  { id: 'm1', enabled: true, name: 'Ödeme hatası', method: 'POST', url: '/v1/payments', match: 'contains', action: { type: 'respond', status: 502, headers: [['Content-Type', 'application/json']], body: '{"error":"gateway"}' }, createdAt: startedAt - 90_000 },
  { id: 'm2', enabled: false, name: 'Yavaş akış', method: 'GET', url: 'https://api.pati.app/v1/feed*', match: 'glob', action: { type: 'delay', delayMs: 2500 }, createdAt: startedAt - 60_000 },
];
const drivers = () => [
  { id: 'android', available: true, active: true, detail: 'adb 1.0.41 (35.0.2)' },
  { id: 'ios-sim', available: true, active: true, detail: 'Xcode 26.1' },
  { id: 'ios-device', available: false, active: false, detail: 'idevicesyslog not found', code: 'logs.idevicesyslogMissing' },
  { id: 'flutter-vm', available: true, active: true },
  { id: 'demo', available: true, active: !empty },
];

let nextLogId = 1;
let logs = [];
const network = new Map(); // id → NetworkDetail
let netSeq = 1;
const processes = new Map();

/* ───────────── log generators ───────────── */
const APP_TAGS = ['auth', 'cart', 'api', 'router', 'push', 'db', 'analytics', 'payments'];
const SYSTEM_NOISE = [
  ['chatty', 'uid=10234(com.mykynk.pati) RenderThread identical 4 lines', 'info'],
  ['OpenGLRenderer', 'Davey! duration=742ms; Flags=0, FrameTimelineVsyncId=4581221, IntendedVsync=2213791001, Vsync=2213791001', 'info'],
  ['ViewRootImpl@a1b2c3[MainActivity]', 'Relayout returned: old=(0,0,1080,2400) new=(0,0,1080,2400) req=(1080,2400)0 dur=7 res=0x0 s={true 0x7a0e8c2000} ch=false seqId=0', 'debug'],
  ['InputMethodManager', 'startInputInner - Id : 0', 'debug'],
  ['BLASTBufferQueue', '[VRI[MainActivity]#0](f:0,a:1) acquireNextBufferLocked size=1080x2400 mFrameNumber=1 applyTransaction=true', 'debug'],
  ['SurfaceFlinger', 'Display 0 HWC layers: 3', 'verbose'],
  ['ActivityManager', 'Displayed com.mykynk.pati/.MainActivity: +412ms', 'info'],
  ['Choreographer', 'Skipped 34 frames!  The application may be doing too much work on its main thread.', 'info'],
  ['ProfileInstaller', 'Installing profile for com.mykynk.pati', 'debug'],
  ['WindowManager', 'Changing focus from Window{3a1 u0 NotificationShade} to Window{9f2 u0 com.mykynk.pati/com.mykynk.pati.MainActivity}', 'info'],
  ['GoogleApiManager', 'Failed to get service from broker.  java.lang.SecurityException: Unknown calling package name \'com.google.android.gms\'.', 'warn'],
  ['TrafficStats', 'tagSocket(108) with statsTag=0xffffffff, statsUid=-1', 'debug'],
  ['ConnectivityService', 'NetworkAgentInfo [WIFI () - 104] validation passed', 'info'],
  ['BluetoothAdapter', 'getBondedDevices', 'debug'],
];
const IOS_NOISE = [
  ['com.apple.UIKit', 'Sending UIEvent type: 0; subtype: 0; to windows: 1', 'debug'],
  ['com.apple.runningboard', 'Acquiring assertion targeting [app<application.com.mykynk.pati>:48211]', 'info'],
  ['com.apple.CFNetwork', 'Task <8F1C2A33-7B1E-4C55-9A0B-1F3E6D2C9A10>.<4> finished with error [-1001] Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."', 'error'],
  ['com.apple.network', 'nw_connection_copy_connected_local_endpoint_block_invoke [C3] Connection has no local endpoint', 'warn'],
  ['com.apple.coreanimation', 'CA_DEBUG_TRANSACTIONS=1 may help debug this', 'debug'],
];
const FLUTTER_LINES = [
  ['[router] push /pets/42', 'info'],
  ['[auth] access token refreshed (expires in 3600s)', 'info'],
  ['[cart] item added: {"sku":"MAMA-2KG","qty":2,"price":349.9}', 'debug'],
  ['[api] GET /v1/pets?page=2 → 200 (124 ms)', 'debug'],
  ['Kullanıcı ana sayfayı açtı', 'info'],
  ['[db] migration v12 → v13 completed in 48 ms', 'info'],
  ['[push] FCM token: dJ8xQ2kT7… (truncated)', 'debug'],
  ['Image cache size: 38.4 MB (412 entries)', 'verbose'],
];
const DART_STACK = `Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:686:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:837:19)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:497:9)
#3      PetRepository.watchPets (package:pati/data/pet_repository.dart:58:22)
#4      PetListCubit.load (package:pati/features/pets/pet_list_cubit.dart:31:10)
#5      _PetListPageState.initState (package:pati/features/pets/pet_list_page.dart:44:9)
#6      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5842:55)
#7      ComponentElement.mount (package:flutter/src/widgets/framework.dart:5682:5)`;
const FLUTTER_ERROR_BOX = `══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════════════════════════════════════════════
The following assertion was thrown during layout:
A RenderFlex overflowed by 23 pixels on the right.

The relevant error-causing widget was:
  Row Row:file:///Users/dev/pati/lib/features/pets/pet_card.dart:37:16

The overflowing RenderFlex has an orientation of Axis.horizontal.
═══════════════════════════════════════════════════════════════════════════════════════════════════`;
const JAVA_CRASH = `FATAL EXCEPTION: main
Process: com.mykynk.kasa, PID: 13002
java.lang.IllegalStateException: Fragment CheckoutFragment{8f1a2b} not attached to a context.
	at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)
	at com.mykynk.kasa.checkout.CheckoutFragment.onPaymentResult(CheckoutFragment.kt:118)
	at com.mykynk.kasa.checkout.CheckoutViewModel$pay$1.invokeSuspend(CheckoutViewModel.kt:77)
	at kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:33)
	at android.os.Handler.handleCallback(Handler.java:959)
	at android.os.Looper.loop(Looper.java:232)
	at android.app.ActivityThread.main(ActivityThread.java:8592)`;

/** Exact origin of a line (SPEC §10.2) when the generator did not set one. */
function originOf(e) {
  if (e.source === 'system') return 'durbun';
  if (e.source === 'app') return 'sdk';
  return e.deviceId === SIM ? 'simctl-log' : e.deviceId === IPHONE ? 'idevicesyslog' : 'logcat';
}

function logEntry(base) {
  const e = { id: nextLogId++, ts: base.ts ?? Date.now(), ...base };
  if (!e.origin) e.origin = originOf(e);
  return e;
}

/** Device lines of the apps without the SDK: Kumbara (Play) on the Pixel, Kumbara (TestFlight) on the iPhone. */
function genDeviceOnlyLog(ts) {
  if (chance(0.5)) {
    const pid = pick([14210, 14210, 14388]);
    const [tag, message, level] = pick([
      ['flutter', 'Kumbara: sepet güncellendi (3 ürün)', 'info'],
      ['flutter', 'Kumbara: hedef ilerlemesi %42', 'info'],
      ['ActivityTaskManager', 'Displayed com.mykynk.kumbara/.MainActivity: +412ms', 'info'],
      ['KumbaraWidget', 'Widget refreshed (2 goals)', 'debug'],
      ['FirebaseMessaging', 'Token refreshed', 'debug'],
    ]);
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level, tag, message, pid, tid: pid, process: pid === 14388 ? 'com.mykynk.kumbara:widget' : 'com.mykynk.kumbara' });
  }
  const [tag, message, level] = pick([
    ['flutter', 'Kumbara: hedef kaydedildi', 'info'],
    ['Runner', 'nw_connection_copy_connected_local_endpoint_block_invoke [C3] Connection has no local endpoint', 'debug'],
    ['UIKitCore', 'Snapshotting a view that has not been rendered', 'warn'],
  ]);
  return logEntry({ ts, deviceId: IPHONE, source: 'device', level, tag, message, pid: 811, process: 'Runner', subsystem: tag });
}

function genLog(ts) {
  if (chance(0.08)) return genDeviceOnlyLog(ts);
  const r = rnd();
  if (r < 0.34) {
    const [tag, message, level] = pick(SYSTEM_NOISE);
    const pid = pick([1203, 1873, 2210, 12345]);
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level, tag, message, pid, tid: pid + int(0, 40), process: pid === 12345 ? 'com.mykynk.pati' : pick(['system_server', 'surfaceflinger', 'com.android.systemui']), appId: pid === 12345 ? 'app:2' : undefined });
  }
  if (r < 0.46) {
    const [tag, message, level] = pick(IOS_NOISE);
    return logEntry({ ts, deviceId: SIM, source: 'device', level, tag, message, pid: 48211, process: pick(['Runner', 'SpringBoard', 'backboardd']), subsystem: tag });
  }
  if (r < 0.62) {
    const [message, level] = pick(FLUTTER_LINES);
    const ios = chance(0.4);
    return logEntry({ ts, deviceId: ios ? SIM : PIXEL, source: 'device', level, tag: 'flutter', message, pid: ios ? 48211 : 12345, process: ios ? 'Runner' : 'com.mykynk.pati', appId: ios ? 'app:4' : 'app:2' });
  }
  if (r < 0.86) {
    const appId = pick(['app:2', 'app:2', 'app:3', 'app:4']);
    const tag = pick(APP_TAGS);
    const level = pick(['debug', 'info', 'info', 'info', 'warn', 'verbose']);
    const msgs = {
      auth: ['Kullanıcı giriş yaptı', 'Oturum yenilendi', 'Biyometrik doğrulama iptal edildi'],
      cart: ['Sepete ürün eklendi', 'Kupon uygulandı: PATI10', 'Sepet senkronize edildi'],
      api: ['Retrying request (attempt 2/3)', 'Cache hit for /v1/pets', 'Rate limit remaining: 412'],
      router: ['→ /pets/42', '← /home', 'Deep link handled: pati://pets/42'],
      push: ['Notification received while in foreground', 'Permission status: granted'],
      db: ['Query took 18 ms', 'Write batch committed (24 rows)'],
      analytics: ['screen_view Home', 'event add_to_cart'],
      payments: ['3DS challenge started', 'Payment intent created'],
    };
    const data = chance(0.45) ? { userId: int(1, 9999), screen: pick(['Home', 'PetDetail', 'Cart', 'Checkout']), items: [{ sku: 'MAMA-2KG', qty: 2 }, { sku: 'TASMA-M', qty: 1 }], durationMs: int(8, 900) } : undefined;
    const a = apps.find((x) => x.id === appId);
    return logEntry({ ts, deviceId: a?.deviceId ?? PIXEL, appId, source: 'app', level, tag, message: pick(msgs[tag]), data, tid: 1 });
  }
  if (r < 0.9) {
    const appId = pick(['app:2', 'app:4']);
    return logEntry({ ts, deviceId: appId === 'app:4' ? SIM : PIXEL, appId, source: 'app', level: 'info', tag: 'event', kind: 'event', message: pick(['purchase', 'add_to_cart', 'login', 'share_pet']), data: { amount: 49.9, currency: 'TRY', items: 2 } });
  }
  if (r < 0.93) {
    return logEntry({ ts, deviceId: PIXEL, appId: 'app:2', source: 'app', level: 'error', tag: 'pets', message: 'Pet list failed to load', error: { type: 'StateError', message: 'Bad state: Stream has already been listened to.', stack: DART_STACK } });
  }
  if (r < 0.95) {
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level: 'warn', tag: 'flutter', message: pick(['Another exception was thrown: A RenderFlex overflowed by 23 pixels on the right.', 'setState() called after dispose(): _PetCardState#3c2a1(lifecycle state: defunct)']), pid: 12345, process: 'com.mykynk.pati', appId: 'app:2' });
  }
  if (r < 0.962) {
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level: 'error', tag: 'flutter', kind: 'flutter-error', message: FLUTTER_ERROR_BOX, pid: 12345, process: 'com.mykynk.pati', appId: 'app:2' });
  }
  if (r < 0.964) {
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level: 'fatal', tag: 'AndroidRuntime', kind: 'crash', message: JAVA_CRASH, pid: 13002, process: 'com.mykynk.kasa', appId: 'app:3' });
  }
  if (r < 0.98) {
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level: 'debug', tag: 'okhttp.OkHttpClient', message: `<-- 200 https://api.kasa.app/v2/balance (${int(40, 400)}ms, 1.2kB body)`, pid: 13002, process: 'com.mykynk.kasa', appId: 'app:3' });
  }
  return logEntry({ ts, deviceId: PIXEL, source: 'device', level: 'info', tag: 'System.out', message: `{"event":"sync","ok":true,"changed":${int(0, 12)},"took_ms":${int(20, 400)}}`, pid: 13002, process: 'com.mykynk.kasa', appId: 'app:3' });
}

/* ───────────── network generators ───────────── */
const ENDPOINTS = [
  { method: 'GET', url: 'https://api.pati.app/v1/pets?page=2&limit=20', status: 200, ct: 'application/json', body: () => JSON.stringify({ page: 2, total: 148, items: Array.from({ length: 20 }, (_, i) => ({ id: 20 + i, name: pick(['Karabaş', 'Pamuk', 'Boncuk', 'Duman', 'Zeytin']), species: pick(['dog', 'cat']), ageMonths: int(2, 120), vaccinated: chance(0.8), owner: { id: int(1, 900), city: pick(['İstanbul', 'Ankara', 'İzmir']) } })) }) },
  { method: 'GET', url: 'https://api.pati.app/v1/pets/42', status: 200, ct: 'application/json', body: () => JSON.stringify({ id: 42, name: 'Karabaş', tags: ['friendly', 'trained'], photos: ['https://cdn.pati.app/p/42/1.jpg'], health: { weightKg: 18.4, lastVisit: '2026-10-21' } }) },
  { method: 'POST', url: 'https://api.pati.app/v1/auth/refresh', status: 200, ct: 'application/json', req: '{"refreshToken":"rt_9f…"}', body: () => '{"accessToken":"eyJhbGciOi…","expiresIn":3600}' },
  { method: 'POST', url: 'https://api.pati.app/graphql', status: 200, ct: 'application/json', req: '{"operationName":"PetFeed","query":"query PetFeed($first:Int){ feed(first:$first){ id title } }","variables":{"first":10}}', graphql: { operationName: 'PetFeed', operationType: 'query' }, body: () => '{"data":{"feed":[{"id":"1","title":"Parkta ilk gün"}]}}' },
  { method: 'GET', url: 'https://cdn.pati.app/p/42/1.jpg?w=640', status: 200, ct: 'image/jpeg', body: null, size: 84_211 },
  { method: 'PUT', url: 'https://api.pati.app/v1/profile', status: 204, ct: 'application/json', req: '{"displayName":"Yusuf","city":"İstanbul"}', body: () => '' },
  { method: 'DELETE', url: 'https://api.pati.app/v1/cart/items/77', status: 404, ct: 'application/json', body: () => '{"error":"not_found","message":"Cart item 77 does not exist"}' },
  { method: 'GET', url: 'https://api.kasa.app/v2/balance', status: 500, ct: 'application/json', body: () => '{"error":"internal","traceId":"a1b2c3d4"}' },
  { method: 'PATCH', url: 'https://api.kasa.app/v2/settings', status: 200, ct: 'application/json', req: '{"notifications":false}', body: () => '{"ok":true}' },
  { method: 'GET', url: 'https://api.pati.app/v1/feed?cursor=abc', status: 0, ct: 'application/json', fail: 'SocketException: Connection timed out (OS Error: Connection timed out, errno = 110), address = api.pati.app, port = 443' },
  { method: 'POST', url: 'https://api.pati.app/v1/payments', status: 502, ct: 'application/json', mocked: true, body: () => '{"error":"gateway"}' },
];

function makeRequest(appId) {
  const ep = pick(ENDPOINTS);
  const app = apps.find((a) => a.id === appId);
  const u = new URL(ep.url);
  const id = `${appId}:${netSeq++}`;
  const start = Date.now();
  const entry = {
    id,
    appId,
    deviceId: app?.deviceId ?? PIXEL,
    source: app?.sdk.platform === 'android' ? 'okhttp' : 'dart:io',
    method: ep.method,
    url: ep.url,
    host: u.host,
    path: u.pathname + u.search,
    startTs: start,
    state: 'pending',
    requestHeaders: [
      ['Accept', 'application/json'],
      ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9…'],
      ['User-Agent', app?.sdk.platform === 'android' ? 'okhttp/4.12.0' : 'Dart/3.10 (dart:io)'],
      ...(ep.req ? [['Content-Type', 'application/json']] : []),
    ],
    requestBodySize: ep.req ? ep.req.length : 0,
    requestContentType: ep.req ? 'application/json' : undefined,
    hasRequestBody: Boolean(ep.req),
    hasResponseBody: false,
    graphql: ep.graphql,
  };
  const detail = { ...entry, requestBody: ep.req ? { encoding: 'utf8', data: ep.req, size: ep.req.length } : undefined };
  network.set(id, detail);
  const duration = ep.fail ? 10_000 + int(0, 200) : chance(0.08) ? int(2100, 3800) : int(35, 650);
  setTimeout(() => {
    const cur = network.get(id);
    if (!cur) return;
    const end = cur.startTs + duration;
    if (ep.fail) {
      Object.assign(cur, { state: 'failed', error: ep.fail, endTs: end, duration });
    } else {
      const body = ep.body ? ep.body() : null;
      Object.assign(cur, {
        state: 'complete',
        status: ep.status,
        statusText: ep.status === 200 ? 'OK' : ep.status === 204 ? 'No Content' : ep.status === 404 ? 'Not Found' : ep.status === 500 ? 'Internal Server Error' : ep.status === 502 ? 'Bad Gateway' : '',
        endTs: end,
        duration,
        responseHeaders: [
          ['Content-Type', ep.ct],
          ['Cache-Control', 'no-cache'],
          ['X-Request-Id', `req_${int(100000, 999999)}`],
        ],
        responseContentType: ep.ct,
        responseBodySize: body !== null ? body.length : (ep.size ?? 0),
        hasResponseBody: body !== null ? body.length > 0 : Boolean(ep.size),
        responseBody: body !== null ? { encoding: 'utf8', data: body, size: body.length } : undefined,
        protocol: 'h2',
        remoteAddress: '104.18.32.7:443',
        timings: { dns: int(0, 20), connect: int(5, 40), tls: int(10, 60), send: 1, wait: Math.max(1, duration - 60), receive: int(1, 20) },
        mocked: ep.mocked || undefined,
        mockRuleId: ep.mocked ? 'm1' : undefined,
      });
    }
    queue.network.push(strip(cur));
  }, Math.min(duration, 4000));
  return entry;
}

function strip(detail) {
  const { requestBody: _a, responseBody: _b, ...entry } = detail;
  return entry;
}

/* ───────────── crash records (dropbox, .ips) ───────────── */
const KUMBARA_WIDGET_STACK = `java.lang.NullPointerException: Attempt to invoke virtual method 'int java.util.List.size()' on a null object reference
	at com.mykynk.kumbara.widget.GoalsWidget.onUpdate(GoalsWidget.kt:58)
	at android.appwidget.AppWidgetProvider.onReceive(AppWidgetProvider.java:66)
	at android.app.ActivityThread.handleReceiver(ActivityThread.java:4759)`;
const KUMBARA_WIDGET_NPE = `Process: com.mykynk.kumbara:widget
PID: 9921
Flags: 0x38c83e44
Package: com.mykynk.kumbara v412 (3.1.0)
Foreground: No

${KUMBARA_WIDGET_STACK}`;
const KUMBARA_CRASH = `FATAL EXCEPTION: main
Process: com.mykynk.kumbara, PID: 14210
java.lang.IllegalStateException: Channel is unrecoverably broken and will be disposed!
	at com.mykynk.kumbara.MainActivity.onPause(MainActivity.kt:88)
	at android.app.Activity.performPause(Activity.java:8689)`;

/** A live logcat crash of the Play build and the device's dropbox copy of it (hidden: `duplicateOf`). */
function kumbaraCrash(ts) {
  const live = logEntry({ ts, deviceId: PIXEL, source: 'device', origin: 'logcat', level: 'fatal', tag: 'AndroidRuntime', kind: 'crash', message: KUMBARA_CRASH, pid: 14210, process: 'com.mykynk.kumbara' });
  const copy = logEntry({
    ts: ts + 900,
    deviceId: PIXEL,
    source: 'device',
    origin: 'dropbox',
    level: 'fatal',
    kind: 'crash',
    tag: 'data_app_crash',
    process: 'com.mykynk.kumbara',
    pid: 14210,
    message: KUMBARA_CRASH.replace('FATAL EXCEPTION: main\n', ''),
    error: { type: 'java.lang.IllegalStateException', message: 'Channel is unrecoverably broken and will be disposed!' },
    data: { origin: 'dropbox', dropboxTag: 'data_app_crash', package: 'com.mykynk.kumbara', process: 'com.mykynk.kumbara', pid: 14210, reportTs: ts, previousLaunch: false, version: '3.1.0', build: '412', duplicateOf: live.id },
  });
  return [live, copy];
}

/** The TestFlight build on the iPhone crashed: the .ips report copied from the device (unsymbolicated). */
function kumbaraIpsCrash(ts) {
  return logEntry({
    ts,
    deviceId: IPHONE,
    source: 'device',
    origin: 'crash-report',
    level: 'fatal',
    kind: 'crash',
    tag: 'crash-report',
    process: 'Runner',
    pid: 811,
    message: 'Kumbara 3.1.0 (412) crashed: EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x0000000000000010',
    error: {
      type: 'EXC_BAD_ACCESS',
      message: 'SIGSEGV · KERN_INVALID_ADDRESS at 0x0000000000000010',
      stack: 'Thread 0 Crashed:\n0   Runner      0x0000000102f1c3a4 Runner + 115620\n1   Flutter     0x00000001052a8c10 Flutter + 3820560\n2   Flutter     0x00000001052a1b88 Flutter + 3791752\n3   UIKitCore   0x000000018b1e2a54 UIKitCore + 1993300',
    },
    data: { origin: 'crash-report', bundleId: 'com.mykynk.kumbara', reportTs: ts, previousLaunch: false, symbolicated: false, version: '3.1.0', build: '412', exceptionType: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', bugType: '309', reportUrl: IPS_URL },
  });
}

/** A minimal two-part .ips (JSON header line + JSON body) for the download button. */
function ipsFile() {
  const header = { app_name: 'Runner', timestamp: '2026-11-02 21:30:04.00 +0300', app_version: '3.1.0', build_version: '412', bundleID: 'com.mykynk.kumbara', bug_type: '309', os_version: 'iPhone OS 18.1 (22B83)', name: 'Runner' };
  const body = { procName: 'Runner', pid: 811, exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS at 0x0000000000000010' }, faultingThread: 0, threads: [{ triggered: true, frames: [{ imageOffset: 115620, imageIndex: 0 }, { imageOffset: 3820560, imageIndex: 1 }] }], usedImages: [{ name: 'Runner' }, { name: 'Flutter' }] };
  return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}\n`;
}

/* ───────────── history ───────────── */
function seedHistory() {
  logs = [];
  nextLogId = 1;
  if (empty) return;
  const base = Date.now() - 10 * 60_000;
  logs.push(logEntry({ ts: base, deviceId: PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'device.connected', params: { device: 'Pixel 8', deviceId: PIXEL, platform: 'android', kind: 'physical', connection: 'usb', osVersion: '15' }, message: 'Device connected: Pixel 8 (Android 15)' }));
  logs.push(logEntry({ ts: base + 50, deviceId: PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'logs.streamStarted', params: { via: 'logcat' }, message: 'Device log stream started (logcat)' }));
  // A widget crash from this morning, read from the device's dropbox when it connected (arrives right after the connect line).
  logs.push(
    logEntry({
      ts: base - 3 * 3_600_000,
      deviceId: PIXEL,
      source: 'device',
      origin: 'dropbox',
      level: 'fatal',
      kind: 'crash',
      tag: 'data_app_crash',
      process: 'com.mykynk.kumbara:widget',
      message: KUMBARA_WIDGET_NPE,
      error: { type: 'java.lang.NullPointerException', message: "Attempt to invoke virtual method 'int java.util.List.size()' on a null object reference", stack: KUMBARA_WIDGET_STACK },
      data: { origin: 'dropbox', dropboxTag: 'data_app_crash', package: 'com.mykynk.kumbara', process: 'com.mykynk.kumbara:widget', pid: 9921, reportTs: base - 3 * 3_600_000, previousLaunch: true, version: '3.1.0', build: '412', foreground: false },
    }),
  );
  logs.push(logEntry({ ts: base + 900, deviceId: SIM, source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'device.connected', params: { device: 'iPhone 16 Pro', deviceId: SIM, platform: 'ios', kind: 'simulator', connection: 'local', osVersion: '18.2' }, message: 'Device connected: iPhone 16 Pro (iOS 18.2)' }));
  logs.push(logEntry({ ts: base + 2000, deviceId: PIXEL, appId: 'app:1', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'app.connected', params: { app: 'Pati', bundleId: 'com.mykynk.pati', version: '1.4.1', sdk: 'flutter', transport: 'adb-reverse', device: 'Pixel 8' }, message: 'Pati 1.4.1 connected (flutter SDK via adb-reverse)' }));
  for (let i = 0; i < 2000; i++) {
    const ts = base + 3000 + i * 270 + int(0, 200);
    logs.push(genLog(ts));
    if (i === 900) {
      logs.push(logEntry({ ts, deviceId: PIXEL, appId: 'app:1', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'app.disconnected', params: { app: 'Pati', bundleId: 'com.mykynk.pati', version: '1.4.1', sdk: 'flutter', transport: 'adb-reverse', device: 'Pixel 8', failedRequests: 1 }, message: 'Pati disconnected (1 pending request failed)' }));
      logs.push(logEntry({ ts: ts + 10, deviceId: PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'process.died', params: { process: 'com.mykynk.pati', pid: 11873 }, message: 'Process died: com.mykynk.pati (pid 11873)' }));
      logs.push(logEntry({ ts: ts + 1500, deviceId: PIXEL, appId: 'app:2', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'app.connected', params: { app: 'Pati', bundleId: 'com.mykynk.pati', version: '1.4.2', sdk: 'flutter', transport: 'adb-reverse', device: 'Pixel 8' }, message: 'Pati 1.4.2 connected (flutter SDK via adb-reverse)' }));
    }
    if (i === 1500) logs.push(logEntry({ ts, deviceId: PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'marker', code: 'marker', params: { label: 'Ödeme akışı testi', n: 1 }, message: 'Ödeme akışı testi' }));
    if (i === 1200) logs.push(...kumbaraCrash(ts));
    if (i === 1700) logs.push(kumbaraIpsCrash(ts));
  }
  for (let i = 0; i < 60; i++) {
    const r = makeRequest(pick(['app:2', 'app:3', 'app:4']));
    const d = network.get(r.id);
    d.startTs = Date.now() - int(5_000, 500_000);
  }
}

/* ───────────── broadcasting ───────────── */
const clients = new Set();
const queue = { logs: [], network: [], devices: [], apps: [], metrics: [], processes: [], removedDevices: [], deviceApps: [], removedDeviceApps: [] };

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  for (const ws of clients) send(ws, msg);
}
function pushLogs(entries) {
  for (const e of entries) {
    logs.push(e);
    queue.logs.push(e);
  }
  if (logs.length > settings.maxLogEntries) logs.splice(0, logs.length - settings.maxLogEntries);
}

function snapshot() {
  return {
    type: 'snapshot',
    devices,
    apps,
    network: [...network.values()].map(strip),
    mocks,
    drivers: drivers(),
    processes: [...processes.values()],
    metrics: [],
    deviceApps,
    logCount: logs.length,
  };
}

function flush() {
  const msg = { type: 'batch' };
  let any = false;
  for (const k of Object.keys(queue)) {
    if (queue[k].length) {
      msg[k] = queue[k];
      queue[k] = [];
      any = true;
    }
  }
  if (any) broadcast(msg);
}

/* ───────────── live simulation ───────────── */
let tick = 0;
function simulate() {
  tick++;
  if (empty) return;
  const burst = chance(0.03);
  const n = burst ? int(30, 80) : Math.max(0, Math.round((RATE / 10) * (0.4 + rnd() * 1.2)));
  const now = Date.now();
  const batch = [];
  for (let i = 0; i < n; i++) batch.push(genLog(now - int(0, 90)));
  // network: ~1.5 req/s
  if (chance(0.15)) {
    const appId = pick(['app:2', 'app:2', 'app:3', 'app:4']);
    const req = makeRequest(appId);
    queue.network.push(req);
    batch.push(logEntry({ ts: now, deviceId: req.deviceId, appId, source: 'app', level: 'info', tag: 'network', kind: 'network', netId: req.id, message: `${req.method} ${req.url}` }));
  }
  pushLogs(batch);
  // metrics every second
  if (tick % 10 === 0) {
    for (const a of apps.filter((x) => x.connected)) {
      queue.metrics.push({
        ts: now,
        deviceId: a.deviceId,
        appId: a.id,
        source: 'sdk',
        cpu: Math.round((8 + rnd() * 35 + (burst ? 30 : 0)) * 10) / 10,
        memoryMB: Math.round(190 + Math.sin(tick / 40) * 20 + rnd() * 8),
        heapMB: Math.round(62 + rnd() * 18),
        fps: chance(0.1) ? int(38, 52) : int(57, 60),
        jankyFrames: chance(0.15) ? int(1, 6) : 0,
        frameBuildMs: Math.round(rnd() * 9 * 10) / 10,
        frameRasterMs: Math.round(rnd() * 7 * 10) / 10,
      });
    }
  }
  // Activity of the apps without the SDK (lastActivity only: the UI coalesces these), now and then a crash.
  if (tick % 20 === 0) {
    for (const d of deviceApps) {
      if (!d.running) continue;
      d.lastActivity = now;
      queue.deviceApps.push(d);
    }
  }
  if (tick % 1200 === 600) {
    const crash = chance(0.5) ? kumbaraCrash(now) : [kumbaraIpsCrash(now)];
    pushLogs(crash);
    const da = deviceApps.find((d) => d.deviceId === crash[0].deviceId && d.id === 'com.mykynk.kumbara');
    if (da) {
      da.crashReports = (da.crashReports ?? 0) + 1;
      queue.deviceApps.push(da);
    }
  }
  // battery drift
  if (tick % 300 === 0) {
    const d = devices.find((x) => x.id === PIXEL);
    if (d) {
      d.battery = { level: Math.max(5, (d.battery?.level ?? 80) - 1), charging: true };
      d.lastSeen = now;
      queue.devices.push(d);
    }
  }
  // an unauthorized phone shows up, then gets authorized
  if (tick === 250 && !devices.some((d) => d.id === 'android:RF8N30ABCD')) {
    const galaxy = {
      id: 'android:RF8N30ABCD',
      platform: 'android',
      kind: 'physical',
      name: 'Galaxy S23',
      model: 'SM-S911B',
      manufacturer: 'samsung',
      connection: 'usb',
      state: 'unauthorized',
      stateCode: 'device.unauthorized',
      stateDetail: 'Accept the USB debugging prompt on the device',
      logs: { status: 'stopped' },
      actions: [],
      firstSeen: now,
      lastSeen: now,
    };
    devices.push(galaxy);
    queue.devices.push(galaxy);
    broadcast({ type: 'notice', level: 'warn', code: 'device.unauthorized', message: 'Accept the USB debugging prompt on Galaxy S23', deviceId: galaxy.id });
  }
  if (tick === 650) {
    const g = devices.find((d) => d.id === 'android:RF8N30ABCD');
    if (g) {
      Object.assign(g, {
        state: 'online',
        stateCode: undefined,
        stateDetail: undefined,
        osVersion: '14',
        apiLevel: 34,
        logs: { status: 'streaming', via: 'logcat' },
        actions: ANDROID_ACTIONS,
        // Some OEM builds refuse `dumpsys dropbox` to the shell user.
        readers: { crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'dumpsys dropbox: Permission Denial: can\'t access dropbox from pid=8812, uid=2000' }, frameStats: { status: 'ok' } },
        lastSeen: now,
      });
      const store = { key: `${g.id}|com.mykynk.kumbara`, deviceId: g.id, id: 'com.mykynk.kumbara', name: 'Kumbara', version: '3.0.4', build: '398', buildType: 'release', install: { source: 'other-store', installer: 'com.sec.android.app.samsungapps' }, pids: [7120], running: true, lastActivity: now };
      deviceApps.push(store);
      queue.deviceApps.push(store);
      queue.devices.push(g);
      pushLogs([logEntry({ ts: now, deviceId: g.id, source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'device.connected', params: { device: 'Galaxy S23', deviceId: g.id, platform: 'android', kind: 'physical', connection: 'usb', osVersion: '14' }, message: 'Device connected: Galaxy S23 (Android 14)' })]);
    }
  }
  // Kasa disconnects / reconnects occasionally
  if (tick % 900 === 450) {
    const k = apps.find((a) => a.id === 'app:3');
    if (k) {
      k.connected = !k.connected;
      if (!k.connected) k.disconnectedAt = now;
      else k.connectedAt = now;
      queue.apps.push(k);
      pushLogs([
        logEntry({ ts: now, deviceId: PIXEL, appId: 'app:3', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: k.connected ? 'app.reconnected' : 'app.disconnected', params: { app: 'Kasa', bundleId: 'com.example.kasa', version: '3.1.0', sdk: 'react-native', transport: 'websocket', device: 'Pixel 8', ...(k.connected ? {} : { failedRequests: 0 }) }, message: `Kasa ${k.connected ? 'reconnected (websocket)' : 'disconnected'}` }),
      ]);
    }
  }
}

function enableDemo(on) {
  empty = !on;
  if (on) {
    devices = baseDevices();
    apps = baseApps();
    deviceApps = baseDeviceApps();
  } else {
    devices = [];
    apps = [];
    deviceApps = [];
    network.clear();
  }
  seedHistory();
  for (const ws of clients) syncClient(ws);
}

/* ───────────── screen recordings ───────────── */
/** deviceId → running recording: the replies waiting for its file (screen-record, then screen-record-stop). */
const recordings = new Map();

function endRecording(deviceId) {
  const rec = recordings.get(deviceId);
  if (!rec) return;
  recordings.delete(deviceId);
  clearTimeout(rec.timer);
  const d = devices.find((x) => x.id === deviceId);
  if (d) {
    delete d.recording;
    d.lastSeen = Date.now();
    queue.devices.push(d);
  }
  const durationSec = Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000));
  for (const reply of rec.replies) reply({ url: '/api/files/recording.mov', file: '/tmp/recording.mov', durationSec, endedBy: rec.endedBy });
}

/** Like the server: records until screen-record-stop or the platform limit, then "copies" the file for 1.5 s. */
function screenRecord(command, reply) {
  const { deviceId } = command;
  if (command.action === 'screen-record-stop') {
    const rec = recordings.get(deviceId);
    if (!rec) return reply(undefined, false, 'No screen recording is running on this device', 'action.recording.notRunning');
    rec.replies.push(reply);
    if (rec.endedBy) return;
    rec.endedBy = 'stop';
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => endRecording(deviceId), 1500);
    return;
  }
  if (recordings.has(deviceId)) return reply(undefined, false, 'A screen recording is already running on this device', 'action.recording.busy');
  const d = devices.find((x) => x.id === deviceId);
  const limitSec = d?.platform === 'android' ? 180 : 600;
  const rec = { startedAt: Date.now(), replies: [reply], endedBy: undefined, timer: undefined };
  rec.timer = setTimeout(() => {
    rec.endedBy = 'limit';
    rec.timer = setTimeout(() => endRecording(deviceId), 1500);
  }, limitSec * 1000);
  recordings.set(deviceId, rec);
  if (d) {
    d.recording = { startedAt: rec.startedAt, limitSec };
    queue.devices.push(d);
  }
}

/* ───────────── commands ───────────── */
function handleCommand(ws, { requestId, command }) {
  const reply = (data, ok = true, error, code) => send(ws, { type: 'reply', requestId, ok, data, error, code });
  const now = Date.now();
  switch (command?.name) {
    case 'clear': {
      const { target, deviceId, appId } = command;
      const match = (e) => (!deviceId || e.deviceId === deviceId) && (!appId || e.appId === appId);
      if (target === 'logs' || target === 'all') logs = logs.filter((e) => !match(e));
      if (target === 'network' || target === 'all') for (const [id, e] of network) if (match(e)) network.delete(id);
      broadcast({ type: 'cleared', target, deviceId, appId });
      return reply(null);
    }
    case 'marker.add': {
      const label = command.label || 'Marker';
      const entry = logEntry({ ts: now, deviceId: command.deviceId ?? PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'marker', code: 'marker', params: { label: command.label ?? '', n: nextLogId }, message: label });
      pushLogs([entry]);
      return reply(entry);
    }
    case 'mocks.set':
      mocks = Array.isArray(command.rules) ? command.rules : mocks;
      broadcast({ type: 'mocks', rules: mocks });
      return reply(mocks);
    case 'settings.update':
      settings = { ...settings, ...(command.patch ?? {}) };
      broadcast({ type: 'settings', settings });
      if ('allowLan' in (command.patch ?? {})) for (const c of clients) send(c, { type: 'hello', server: server(), settings });
      return reply(settings);
    case 'demo.set':
      reply({ enabled: Boolean(command.enabled) });
      enableDemo(Boolean(command.enabled));
      return;
    case 'device.action':
      if (command.action === 'screenshot') return reply({ url: '/api/files/shot.png', file: '/tmp/shot.png', width: 1080, height: 2400 });
      if (command.action === 'screen-record' || command.action === 'screen-record-stop') return screenRecord(command, reply);
      if (command.action === 'list-apps') return reply([{ id: 'com.mykynk.pati', name: 'Pati', version: '1.4.2', debuggable: true }, { id: 'com.mykynk.kasa', name: 'Kasa', version: '2.0.1' }]);
      return reply(null);
    case 'app.action':
      return reply(null);
    case 'vm.attach':
      if (!/ws:|http:|listening/.test(command.input ?? '')) return reply(undefined, false, 'No VM service URL found in the input', 'vm.attachFailed');
      return reply({ appId: 'app:2' });
    case 'vm.detach':
    case 'metrics.watch':
      return reply(null);
    case 'net.replay': {
      const src = network.get(command.id);
      if (!src) return reply(undefined, false, 'Unknown request', 'net.unknown');
      const id = `replay:${netSeq++}`;
      const entry = { ...strip(src), id, appId: undefined, deviceId: 'desktop', source: 'replay', startTs: now, endTs: now + 120, duration: 120 };
      network.set(id, { ...src, ...entry });
      queue.network.push(entry);
      return reply(entry);
    }
    case 'doctor.run':
      return reply(doctorChecks());
    default:
      return reply(undefined, false, `Unknown command ${command?.name}`, 'command.unknown');
  }
}

function doctorChecks() {
  return [
    // As inside Dürbün.app (the server runs in Electron): worded from the code.
    { id: 'node', label: 'Node.js', status: 'ok', version: process.version, detail: `Embedded in Dürbün.app (Electron 45.1.0, Node ${process.versions.node})`, code: 'doctor.node.embedded', params: { electron: '45.1.0', node: process.versions.node } },
    { id: 'adb', label: 'adb', status: 'ok', version: '1.0.41', path: '/Users/dev/Library/Android/sdk/platform-tools/adb' },
    { id: 'xcrun', label: 'Xcode command line tools', status: 'ok', version: 'Xcode 26.1', path: '/usr/bin/xcrun' },
    { id: 'idevicesyslog', label: 'idevicesyslog', status: 'missing', detail: 'Needed for logs of physical iPhones. Flutter’s bundled copy was not found either.', fix: 'brew install libimobiledevice' },
    { id: 'port.http', label: `Port ${PORT}`, status: 'ok' },
    { id: 'port.sdk', label: 'Port 9751', status: 'warn', detail: 'Another process is listening on 9751; simulators may not reach Dürbün.', fix: 'lsof -nP -iTCP:9751 -sTCP:LISTEN' },
  ];
}

/* ───────────── HTTP ───────────── */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, name: 'durbun', version: '0.1.0' });
    if (p === '/api/doctor') return setTimeout(() => json(res, 200, doctorChecks()), 350);
    if (p === '/api/network/search' && req.method === 'POST') {
      const { text = '', ids } = JSON.parse((await readBody(req)).toString() || '{}');
      const q = String(text).toLowerCase();
      const out = [...network.values()]
        .filter((d) => (!ids || ids.includes(d.id)) && (d.url.toLowerCase().includes(q) || (d.responseBody?.data ?? '').toLowerCase().includes(q)))
        .map((d) => d.id);
      return json(res, 200, { ids: out });
    }
    const body = /^\/api\/network\/(.+)\/body\/(request|response)$/.exec(p);
    if (body) {
      const d = network.get(decodeURIComponent(body[1]));
      const b = body[2] === 'request' ? d?.requestBody : d?.responseBody;
      if (!d || !b) return json(res, 404, { error: 'No body' });
      res.writeHead(200, { 'Content-Type': (body[2] === 'request' ? d.requestContentType : d.responseContentType) ?? 'application/octet-stream' });
      return res.end(b.encoding === 'base64' ? Buffer.from(b.data, 'base64') : b.data);
    }
    const detail = /^\/api\/network\/(.+)$/.exec(p);
    if (detail && req.method === 'GET') {
      const d = network.get(decodeURIComponent(detail[1]));
      return d ? json(res, 200, d) : json(res, 404, { error: 'Unknown network entry' });
    }
    if (p === '/api/export') {
      // Same scoping as the server: ?deviceId= (one device), + &appId= (one session) or &bundleId= (one app the device reports).
      const deviceId = url.searchParams.get('deviceId') || undefined;
      const appId = url.searchParams.get('appId') || undefined;
      const bundleId = (deviceId && url.searchParams.get('bundleId')) || undefined;
      const da = bundleId ? deviceApps.find((d) => d.deviceId === deviceId && d.id === bundleId) : undefined;
      const appIds = new Set(apps.filter((a) => (!deviceId || a.deviceId === deviceId) && (!appId || a.id === appId) && (!bundleId || a.app.id === bundleId)).map((a) => a.id));
      const pkgOf = (e) => e.data?.package ?? e.data?.bundleId;
      const mine = (e) =>
        e.appId !== undefined ? appIds.has(e.appId) : !bundleId || (da?.pids ?? []).includes(e.pid) || e.process === bundleId || (da?.processName && e.process === da.processName) || pkgOf(e) === bundleId;
      const inScope = (e) => (!deviceId || e.deviceId === deviceId) && (!appId || e.appId === appId) && mine(e);
      const exp = {
        format: 'durbun-session',
        version: 1,
        exportedAt: Date.now(),
        server: { version: '0.1.0' },
        devices: deviceId ? devices.filter((d) => d.id === deviceId) : devices,
        apps: apps.filter((a) => appIds.has(a.id)),
        logs: logs.filter(inScope).slice(-5000),
        network: [...network.values()].filter((n) => (!deviceId || n.deviceId === deviceId) && (!appId && !bundleId ? true : appIds.has(n.appId))),
        deviceApps: deviceApps.filter((d) => (!deviceId || d.deviceId === deviceId) && (!bundleId || d.id === bundleId)),
      };
      const date = new Date().toISOString().slice(0, 10);
      return json(res, 200, exp, { 'Content-Disposition': `attachment; filename="durbun-${date}.durbun.json"` });
    }
    if (p === '/api/import' && req.method === 'POST') {
      const raw = (await readBody(req)).toString();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (data?.format !== 'durbun-session') return json(res, 400, { error: 'Not a Dürbün session export', code: 'import.invalid' });
      const id = `import:${netSeq++}`;
      const dev = { ...(data.devices?.[0] ?? baseDevices()[0]), id, name: `📁 ${data.devices?.[0]?.name ?? 'Session'}`, state: 'disconnected', logs: { status: 'stopped' }, actions: [], firstSeen: Date.now(), lastSeen: Date.now() };
      devices.push(dev);
      queue.devices.push(dev);
      return json(res, 200, { deviceIds: [id] });
    }
    const ips = /^\/api\/files\/crash\/([^/]+)\/([^/]+\.ips)$/.exec(p);
    if (ips && req.method === 'GET') {
      if (decodeURIComponent(ips[1]) !== IPHONE_UDID || decodeURIComponent(ips[2]) !== IPS_NAME) return json(res, 404, { error: 'Unknown file', code: 'file.unknown' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${IPS_NAME}"` });
      return res.end(ipsFile());
    }
    if (p === '/api/har' && req.method === 'POST') {
      return json(res, 200, { log: { version: '1.2', creator: { name: 'Dürbün', version: '0.1.0' }, entries: [] } }, { 'Content-Disposition': 'attachment; filename="durbun.har"' });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      await readBody(req);
      return json(res, 200, { file: `/tmp/durbun/${url.searchParams.get('name') ?? 'upload.bin'}` });
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  if (p !== '/ui') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

function syncClient(ws) {
  send(ws, { type: 'hello', server: server(), settings });
  send(ws, snapshot());
  if (logs.length === 0) send(ws, { type: 'history', logs: [], done: true });
  for (let i = 0; i < logs.length; i += 5000) send(ws, { type: 'history', logs: logs.slice(i, i + 5000), done: i + 5000 >= logs.length });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  syncClient(ws);
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.type === 'command') handleCommand(ws, msg);
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => clients.delete(ws));
});

seedHistory();
const simTimer = setInterval(simulate, 100);
const flushTimer = setInterval(flush, 100);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[durbun-mock] http://127.0.0.1:${PORT}  (WS /ui, REST /api)  ${empty ? 'empty mode' : `~${RATE} lines/s`}`);
});

function shutdown() {
  clearInterval(simTimer);
  clearInterval(flushTimer);
  for (const ws of clients) ws.terminate();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
