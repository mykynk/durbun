#!/usr/bin/env node
/**
 * Dürbün UI dev mock — a stand-in for the real server so the UI can be built and judged without
 * hardware. Node + `ws` only.
 *
 *   node packages/ui/dev/mock-server.mjs [--port 9799] [--empty] [--no-flows] [--no-media] [--sample-video <.mp4>] [--rate 30]
 *   DURBUN_SERVER=http://127.0.0.1:9799 npx vite --port 5179     (from packages/ui)
 *
 * REST /api/android/wireless[/pair|/connect]: pairing over Wi-Fi (code 123456 works; see dev/mock-wireless.mjs).
 * WS /ui: hello → snapshot (4 devices, 4 apps + an older session, device apps, mocks, drivers) → ~2000
 * history logs → live batches (logs, network, metrics, device apps, occasional device/app changes). Every
 * command gets {ok: true} with plausible data. REST: /api/health, /api/doctor, /api/network/:id (+ bodies),
 * /api/network/search, /api/export, /api/import, /api/har, /api/bug-report, /api/upload, /api/files/crash/:udid/:name,
 * /api/slack (+ /send: printed to stdout, never posted), /api/media (mock-media.mjs: the media library, seeded unless
 * `--no-media`; screenshots and recordings taken here are added with their log marker).
 * SPEC §10: apps without the SDK (`snapshot.deviceApps`: a Play build, a Firebase build, an APK
 * installed by hand, a TestFlight build next to an Xcode build — both "Runner" — on a USB iPhone), exact
 * log origins, dropbox / .ips crash records (one marked `duplicateOf`, one with a downloadable .ips),
 * device readers (frame stats without data on the Pixel, dropbox refused on the Galaxy) and SDK layers.
 * Session recordings (mock-recordings.mjs): /api/recordings and WS /ui?view=<id> (a frozen copy of the data, imported
 * devices, no live batches); `--recordings empty|paused|off` for the empty list, the paused and the off states.
 * `--empty` starts with no devices (onboarding); `demo.set {enabled:true}` then fills everything.
 * `--no-flows` starts the Flows tab empty (its welcome page with the starter flows).
 * Stream entries (SPEC §6.1.1): Pati's vet chat over a WebSocket (open, growing, 2 000+ messages with a gap after
 * the first 100, a binary presence frame, ping / pong, a cut history payload), a socket closed with 1001, one that
 * broke, a clinic queue over SSE (named events, ids, retry; ends now and then and reconnects), an open socket with
 * no messages yet, and two plain 101s without `stream`, as the server keeps a handshake it opens no stream for: Kasa
 * on iOS (no `streams` capability) and Kasa on Android (captures streams, but its socket was opened without
 * DurbunWebSocketFactory: `noStream`, with the SDK's `noWebSocketFactory` line). `captureStreams` off does the same
 * for new connections. GET /api/network/:id/messages pages them.
 * Launch reports (`durbun.launch`): a cold start when Kasa (Android) connects, a prewarmed one from Kasa on iOS
 * (Jane's iPhone). Metrics: frame times for Flutter and native Android only; native Android drops `fps` and the
 * frame times while its screen is idle.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { flowSummaries, handleFlowsApi } from './mock-flows.mjs';
import { createMockMedia, mediaClock } from './mock-media.mjs';
import { appDataArchive, appDataReply } from './mock-app-data.mjs';
import { createMockWireless } from './mock-wireless.mjs';
import { createMockRules } from './mock-rules.mjs';
import { createMockRecordings } from './mock-recordings.mjs';

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
  captureStreams: true,
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
  version: '0.3.2',
  protocol: 1,
  ports: { http: PORT, sdk: 9751 },
  startedAt,
  demo: !empty,
  lan: settings.allowLan,
  hostAddresses: ['192.168.1.20', '10.0.0.7'],
  dataDir: '/Users/dev/.durbun',
  platform: 'darwin',
});

const ANDROID_ACTIONS = ['screenshot', 'open-url', 'list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-clear-data', 'app-uninstall', 'app-install', 'logs-clear-buffer', 'logs-restart', 'appearance', 'font-scale', 'animations', 'input-text', 'key-event', 'screen-record', 'screen-record-stop', 'app-permission', 'app-settings', 'app-locale', 'airplane-mode', 'wifi', 'mobile-data', 'rotation', 'dont-keep-activities', 'bug-report', 'bug-report-cancel', 'app-data'];
const SIM_ACTIONS = ['screenshot', 'open-url', 'list-apps', 'app-launch', 'app-stop', 'app-restart', 'app-clear-data', 'app-uninstall', 'app-install', 'appearance', 'font-scale', 'push-notification', 'location', 'status-bar', 'logs-restart', 'screen-record', 'screen-record-stop', 'app-permission', 'keychain-reset', 'app-data'];

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
      hardwareSerial: 'R5CT20XK9QM',
      connection: 'usb',
      // Wireless debugging is on too: USB in use, Wi-Fi on standby (DeviceInfo.connections).
      connections: ['usb', 'wifi'],
      state: 'online',
      // Settings Dürbün changed earlier (the server keeps them per action, app-scoped ones per app and permission).
      settingOverrides: [
        { action: 'animations', previous: '1', current: '0', since: startedAt - 1_200_000 },
        { action: 'mobile-data', previous: 'on', current: 'off', since: startedAt - 900_000 },
        { action: 'app-permission', appId: 'com.mykynk.pati', key: 'android.permission.CAMERA', previous: 'granted', current: 'revoked', since: startedAt - 600_000 },
      ],
      // A work profile: app actions take a userId.
      users: [
        { id: 0, name: 'Owner', kind: 'main', running: true, current: true },
        { id: 10, name: 'Work profile', kind: 'work', running: true },
      ],
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
      name: 'Jane’s iPhone',
      model: 'iPhone14,5',
      manufacturer: 'Apple',
      osVersion: '18.1',
      serial: IPHONE_UDID,
      connection: 'usb',
      state: 'online',
      battery: { level: 64, charging: false },
      logs: { status: 'streaming', via: 'idevicesyslog' },
      actions: ['screenshot', 'list-apps', 'app-launch', 'app-stop'],
      // Why the other iPhone actions are missing (the server says it per action).
      unavailableActions: [
        { action: 'open-url', code: 'action.developerModeOff' },
        { action: 'screen-record', code: 'action.toolTooOld', params: { tool: 'devicectl', detail: 'a newer Xcode (devicectl screen recording)' } },
        { action: 'screen-record-stop', code: 'action.toolTooOld', params: { tool: 'devicectl', detail: 'a newer Xcode (devicectl screen recording)' } },
        { action: 'app-install', code: 'action.developerModeOff' },
        { action: 'app-uninstall', code: 'action.developerModeOff' },
        { action: 'app-data', code: 'action.appData.iphoneUnsupported' },
      ],
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
  const caps = ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands', 'streams'];
  return [
    {
      id: 'app:1',
      sessionKey: 's-pati-old',
      deviceId: PIXEL,
      sdk: { name: 'durbun', version: '0.3.2', platform: 'flutter' },
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
      // Declares the GraphQL operation matcher; Pati on the simulator and Kasa run older SDKs that do not.
      sdk: { name: 'durbun', version: '0.3.2', platform: 'flutter', layers: ['dart', 'android'], mockMatchers: ['graphql'] },
      app: { name: 'Pati', id: 'com.mykynk.pati', version: '1.4.2', build: '42', pid: 12345, processName: 'com.mykynk.pati', debug: true },
      transport: 'adb-reverse',
      connected: true,
      connectedAt: startedAt - 280_000,
      capabilities: caps,
      actions: FLUTTER_ACTIONS,
      stats: { logs: 0, requests: 0, errors: 0 },
      sdkProtocol: 1,
      // The phone's clock runs 47 s behind the Mac (Mac minus device, ms).
      clockOffsetMs: 47_260,
      clockOffsetAccuracyMs: 180,
    },
    {
      id: 'app:3',
      sessionKey: 's-kasa',
      deviceId: PIXEL,
      sdk: { name: 'durbun-android', version: '0.4.0', platform: 'android' },
      app: { name: 'Kasa', id: 'com.mykynk.kasa', version: '2.0.1', build: '201', pid: 13002, processName: 'com.mykynk.kasa', debug: true },
      transport: 'adb-reverse',
      connected: true,
      connectedAt: startedAt - 200_000,
      // Captures streams, but its balance socket is opened with OkHttpClient.newWebSocket (no hook: `noStream`).
      capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'streams'],
      actions: [],
      stats: { logs: 0, requests: 0, errors: 0 },
      // A newer SDK build than this Dürbün (protocol 1): the server reports what to update (the app.sdkNewer line).
      sdkProtocol: 2,
      protocolMismatch: 'sdk-newer',
      clockOffsetMs: 320,
      clockOffsetAccuracyMs: 40,
    },
    {
      // Kasa's native iOS build (Swift SDK): reports its launch (prewarmed here), no frame times.
      id: 'app:5',
      sessionKey: 's-kasa-ios',
      deviceId: IPHONE,
      sdk: { name: 'durbun-ios', version: '0.4.0', platform: 'ios' },
      app: { name: 'Kasa', id: 'com.mykynk.kasa', version: '2.0.1', build: '201', pid: 902, processName: 'Kasa', debug: true },
      transport: 'usbmux',
      connected: true,
      connectedAt: startedAt - 100_000,
      capabilities: ['logs', 'network', 'metrics', 'events', 'crash'],
      actions: [],
      stats: { logs: 0, requests: 0, errors: 0 },
    },
    {
      id: 'app:4',
      sessionKey: 's-pati-ios',
      deviceId: SIM,
      sdk: { name: 'durbun', version: '0.3.2', platform: 'flutter', layers: ['dart', 'ios'] },
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
    da(IPHONE, 'com.mykynk.kasa', { name: 'Kasa', version: '2.0.1', build: '201', buildType: 'debug', install: { source: 'xcode' }, processName: 'Kasa', pids: [902], running: true }),
    da(IPHONE, 'com.mykynk.pati', { name: 'Pati', version: '1.5.0', build: '58', buildType: 'debug', install: { source: 'xcode' }, processName: 'Runner', lastActivity: Date.now() - 9 * 60_000 }),
  ];
}

let devices = empty ? [] : baseDevices();
let apps = empty ? [] : baseApps();
let deviceApps = empty ? [] : baseDeviceApps();
/**
 * The rule list, validated and normalized like the server's (mock-rules.mjs); its revision is the server's
 * `mocksRevision`: a save from an older list is refused.
 */
const mockRules = createMockRules([
  { id: 'm1', enabled: true, name: 'Payment error', method: 'POST', url: '/v1/payments', match: 'contains', action: { type: 'respond', status: 502, headers: [['Content-Type', 'application/json']], body: '{"error":"gateway"}' }, createdAt: startedAt - 90_000 },
  { id: 'm2', enabled: false, name: 'Slow feed', method: 'GET', url: 'https://api.pati.app/v1/feed*', match: 'glob', action: { type: 'delay', delayMs: 2500 }, createdAt: startedAt - 60_000 },
  // Two rules on one GraphQL address, one per operation: not a conflict.
  { id: 'm3', enabled: true, name: 'Empty feed', method: 'POST', url: 'https://api.pati.app/graphql', match: 'exact', when: { graphql: { operationName: 'PetFeed', operationType: 'query' } }, action: { type: 'respond', status: 200, headers: [['Content-Type', 'application/json']], body: '{"data":{"feed":[]}}' }, createdAt: startedAt - 45_000 },
  { id: 'm4', enabled: true, name: 'Like fails', method: 'POST', url: 'https://api.pati.app/graphql', match: 'exact', when: { graphql: { operationName: 'LikeStory' } }, action: { type: 'respond', status: 200, headers: [['Content-Type', 'application/json']], body: '{"errors":[{"message":"Too many likes"}]}' }, createdAt: startedAt - 30_000 },
]);
/**
 * Requests each rule answered since this server started (server hub/mockHits.ts): counted once per request when it
 * ends mocked; a rule deleted from the list loses its count; clearing requests keeps them.
 */
const mockHits = new Map(); // ruleId → { count, lastTs, byApp: Map<appId, n> }
const mockHitIds = new Set();
let mockHitsChanged = false;
function countMockHit(e) {
  if (!e.mocked || !e.mockRuleId || e.state === 'pending' || mockHitIds.has(e.id)) return;
  mockHitIds.add(e.id);
  const c = mockHits.get(e.mockRuleId) ?? { count: 0, lastTs: 0, byApp: new Map() };
  mockHits.set(e.mockRuleId, c);
  c.count++;
  c.lastTs = Math.max(c.lastTs, e.endTs ?? e.startTs);
  if (e.appId) c.byApp.set(e.appId, (c.byApp.get(e.appId) ?? 0) + 1);
  mockHitsChanged = true;
}
function mockHitsWire() {
  const out = {};
  for (const [id, c] of mockHits) out[id] = { count: c.count, lastTs: c.lastTs, ...(c.byApp.size ? { byApp: Object.fromEntries(c.byApp) } : {}) };
  return out;
}

// As the real drivers report themselves: an English detail plus code + params the UI words.
const drivers = () => [
  { id: 'android', available: true, active: true, detail: 'adb 1.0.41 · 2 devices online', code: 'driver.android.online', params: { adb: 'adb 1.0.41', count: 2 } },
  { id: 'ios-sim', available: true, active: true, detail: '1 booted simulator', code: 'driver.iosSim.booted', params: { count: 1 } },
  { id: 'ios-device', available: true, active: true, detail: '1 device · idevicesyslog was not found — install libimobiledevice (brew install libimobiledevice) or Flutter', code: 'logs.idevicesyslogMissing', params: { count: 1 } },
  { id: 'flutter-vm', available: true, active: true, detail: '1 app attached through the Dart VM service', code: 'driver.vm.attached', params: { count: 1 } },
  empty
    ? { id: 'demo', available: true, active: false, detail: 'Demo mode is off', code: 'demo.inactive' }
    : { id: 'demo', available: true, active: true, detail: 'Generating demo data for 3 virtual devices', code: 'demo.active' },
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
  ['User opened the home page', 'info'],
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

const ADDRESS_ONLY_STACK = `*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
pid: 12345, tid: 12371, name 1.ui
os: android arch: arm64 comp: yes sim: no
build_id: '6c3e1a9f0b2d4e8c7a1f3b5d9e0c2a4f'
isolate_dso_base: 7a5e1c8000, vm_dso_base: 7a5e1c8000
isolate_instructions: 7a5e2a1000, vm_instructions: 7a5e1f6000
    #00 abs 0000007a5e3d33f3 virt 00000000002793f3 _kDartIsolateSnapshotInstructions+0x1c13f3
    #01 abs 0000007a5e3d2b18 virt 0000000000278b18 _kDartIsolateSnapshotInstructions+0x1c0b18
    #02 abs 0000007a5e41c07c virt 00000000002c207c _kDartIsolateSnapshotInstructions+0x20a07c`;

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
      ['flutter', 'Kumbara: savings updated (3 goals)', 'info'],
      ['flutter', 'Kumbara: goal progress 42%', 'info'],
      ['ActivityTaskManager', 'Displayed com.mykynk.kumbara/.MainActivity: +412ms', 'info'],
      ['KumbaraWidget', 'Widget refreshed (2 goals)', 'debug'],
      ['FirebaseMessaging', 'Token refreshed', 'debug'],
    ]);
    // system_server's "Displayed" line: the server moves it to the app and adds `data.startup` (android/logcat.ts).
    if (tag === 'ActivityTaskManager') return logEntry({ ts, deviceId: PIXEL, source: 'device', level, tag, message, pid: 14210, process: 'com.mykynk.kumbara', data: { startup: { app: 'com.mykynk.kumbara', activity: '.MainActivity', kind: 'displayed', ms: 412 }, reporterPid: 1203 } });
    return logEntry({ ts, deviceId: PIXEL, source: 'device', level, tag, message, pid, tid: pid, process: pid === 14388 ? 'com.mykynk.kumbara:widget' : 'com.mykynk.kumbara' });
  }
  const [tag, message, level] = pick([
    ['flutter', 'Kumbara: goal saved', 'info'],
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
      auth: ['User signed in', 'Session refreshed', 'Biometric authentication cancelled'],
      cart: ['Item added to cart', 'Coupon applied: PATI10', 'Cart synced'],
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
  if (r < 0.875) {
    // Screen changes (navigator observer / trackNavigation) and Flutter lifecycle lines, as the SDKs send them.
    const appId = pick(['app:2', 'app:4']);
    const deviceId = appId === 'app:4' ? SIM : PIXEL;
    if (chance(0.25)) return logEntry({ ts, deviceId, appId, source: 'app', level: 'info', tag: 'lifecycle', message: `AppLifecycleState.${pick(['paused', 'resumed', 'inactive', 'hidden'])}` });
    const to = pick(['Home', 'PetDetail', 'Cart', 'Checkout', 'Profile']);
    const from = pick(['Home', 'PetDetail', 'Cart']);
    return logEntry({ ts, deviceId, appId, source: 'app', level: 'info', tag: 'event', kind: 'event', message: 'navigation', data: from === to ? { to } : { from, to } });
  }
  if (r < 0.9) {
    const appId = pick(['app:2', 'app:4']);
    return logEntry({ ts, deviceId: appId === 'app:4' ? SIM : PIXEL, appId, source: 'app', level: 'info', tag: 'event', kind: 'event', message: pick(['purchase', 'add_to_cart', 'login', 'share_pet']), data: { amount: 49.9, currency: 'USD', items: 2 } });
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
  { method: 'POST', url: 'https://api.pati.app/graphql', status: 200, ct: 'application/json', req: '{"operationName":"PetFeed","query":"query PetFeed($first:Int){ feed(first:$first){ id title } }","variables":{"first":10}}', graphql: { operationName: 'PetFeed', operationType: 'query' }, mockRuleId: 'm3', mockApps: ['app:2'], mockBody: () => '{"data":{"feed":[]}}', body: () => '{"data":{"feed":[{"id":"1","title":"First day at the park"}]}}' },
  // Same URL, other operations: one rule per operation (mock matching v2). LikeStory is answered by rule m4, but only
  // in the Pixel's Pati session: the only one whose SDK declared the GraphQL matcher (`sdk.mockMatchers`).
  { method: 'POST', url: 'https://api.pati.app/graphql', status: 200, ct: 'application/json', req: '{"operationName":"PetStories","query":"query PetStories($petId:ID!){ stories(petId:$petId){ id text likes } }","variables":{"petId":"42"}}', graphql: { operationName: 'PetStories', operationType: 'query' }, body: () => '{"data":{"stories":[{"id":"s7","text":"Found a stick","likes":12}]}}' },
  { method: 'POST', url: 'https://api.pati.app/graphql', status: 200, ct: 'application/json', req: '{"query":"mutation LikeStory($id:ID!){ likeStory(id:$id){ id likes } }","variables":{"id":"s7"}}', graphql: { operationName: 'LikeStory', operationType: 'mutation' }, mockRuleId: 'm4', mockApps: ['app:2'], mockBody: () => '{"errors":[{"message":"Too many likes"}]}', body: () => '{"data":{"likeStory":{"id":"s7","likes":13}}}' },
  { method: 'GET', url: 'https://cdn.pati.app/p/42/1.jpg?w=640', status: 200, ct: 'image/jpeg', body: null, size: 84_211 },
  { method: 'PUT', url: 'https://api.pati.app/v1/profile', status: 204, ct: 'application/json', req: '{"displayName":"Jane","city":"İstanbul"}', body: () => '' },
  { method: 'DELETE', url: 'https://api.pati.app/v1/cart/items/77', status: 404, ct: 'application/json', body: () => '{"error":"not_found","message":"Cart item 77 does not exist"}' },
  { method: 'GET', url: 'https://api.kasa.app/v2/balance', status: 500, ct: 'application/json', body: () => '{"error":"internal","traceId":"a1b2c3d4"}' },
  { method: 'PATCH', url: 'https://api.kasa.app/v2/settings', status: 200, ct: 'application/json', req: '{"notifications":false}', body: () => '{"ok":true}' },
  { method: 'GET', url: 'https://api.pati.app/v1/feed?cursor=abc', status: 0, ct: 'application/json', fail: 'SocketException: Connection timed out (OS Error: Connection timed out, errno = 110), address = api.pati.app, port = 443' },
  { method: 'POST', url: 'https://api.pati.app/v1/payments', status: 502, ct: 'application/json', mocked: true, body: () => '{"error":"gateway"}' },
];

/** A decodable (unsigned, fake) access token: about one request in six carries one that had already expired. */
let jwtSeq = 0;
function mockJwt(start) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sec = Math.floor(start / 1000);
  const expired = ++jwtSeq % 6 === 0;
  const claims = { sub: 'user_4821', iss: 'https://auth.pati.app', aud: 'pati-mobile', scope: 'pets:read pets:write', iat: sec - (expired ? 3900 : 600), exp: sec + (expired ? -300 : 3000) };
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.bW9jay1zaWduYXR1cmU`;
}

function makeRequest(appId) {
  const ep = pick(ENDPOINTS);
  const app = apps.find((a) => a.id === appId);
  const u = new URL(ep.url);
  const id = `${appId}:${netSeq++}`;
  const start = Date.now();
  const mockedBy = ep.mocked ? 'm1' : ep.mockRuleId && (!ep.mockApps || ep.mockApps.includes(appId)) ? ep.mockRuleId : undefined;
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
      ['Authorization', `Bearer ${mockJwt(start)}`],
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
      const body = mockedBy && ep.mockBody ? ep.mockBody() : ep.body ? ep.body() : null;
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
        mocked: mockedBy ? true : undefined,
        mockRuleId: mockedBy,
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
    if (i === 1470) logs.push(...kasaConnected(ts));
    if (i === 1840) logs.push(...kasaIosConnected(ts));
    if (i === 1500) logs.push(logEntry({ ts, deviceId: PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'marker', code: 'marker', params: { label: 'Payment flow test', n: 1 }, message: 'Payment flow test' }));
    if (i === 1200) logs.push(...kumbaraCrash(ts));
    if (i === 1700) logs.push(kumbaraIpsCrash(ts));
    if (i === 1850) logs.push(...showcaseLines(ts));
  }
  showcaseRequests();
  streamMsgs.clear();
  seedStreams();
  seedMetrics();
  for (let i = 0; i < 60; i++) {
    const r = makeRequest(pick(['app:2', 'app:3', 'app:4']));
    const d = network.get(r.id);
    d.startTs = Date.now() - int(5_000, 500_000);
  }
}

/** Kasa (Kotlin SDK) connects after a cold start: its `durbun.launch` event follows the connect line (Android LaunchTimer). */
function kasaConnected(ts, ms = 1243) {
  const k = { app: 'Kasa', bundleId: 'com.mykynk.kasa', version: '2.0.1', sdk: 'android', transport: 'adb-reverse', device: 'Pixel 8' };
  return [
    logEntry({ ts, deviceId: PIXEL, appId: 'app:3', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'app.connected', params: k, message: 'Kasa 2.0.1 connected (android SDK via adb-reverse)' }),
    logEntry({ ts: ts + 20, deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'info', tag: 'event', kind: 'event', message: 'durbun.launch', data: { kind: 'cold', ms, to: 'firstFrame', from: 'launchRequest', screen: 'MainActivity' } }),
    // Android SDK, once per process: a socket opened without its factory (handshake only, net.response.noStream).
    logEntry({ ts: ts + 2_400, deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'info', tag: 'durbun', kind: 'text',
      message: 'A WebSocket was opened with OkHttpClient.newWebSocket, so Dürbün sees its handshake but not its messages. Open sockets through DurbunWebSocketFactory to capture them.',
      data: { reason: 'noWebSocketFactory' } }),
  ];
}

/** Kasa's iOS build (Swift SDK) on Jane's iPhone: iOS prewarmed the process, so the launch has no time (LaunchTiming). */
function kasaIosConnected(ts) {
  const k = { app: 'Kasa', bundleId: 'com.mykynk.kasa', version: '2.0.1', sdk: 'ios', transport: 'usbmux', device: 'Jane’s iPhone' };
  return [
    logEntry({ ts, deviceId: IPHONE, appId: 'app:5', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'app.connected', params: k, message: 'Kasa 2.0.1 connected (ios SDK via usbmux)' }),
    logEntry({ ts: ts + 15, deviceId: IPHONE, appId: 'app:5', source: 'app', level: 'info', tag: 'event', kind: 'event', message: 'durbun.launch', data: { kind: 'prewarmed', to: 'firstFrame', screen: 'BalanceViewController' } }),
  ];
}

/**
 * One of each line the newer servers and SDKs send, with their real shapes, so each row style can be seen:
 * an Android low-memory kill (android/logcat.ts), earlier-launch reports (Android ExitReports.kt, iOS
 * SystemDiagnostics.swift), and the SDK diagnostics system lines (server sdk/diagnostics.ts, sdk/layer.ts).
 */
function showcaseLines(ts) {
  const pati = { app: 'Pati', bundleId: 'com.mykynk.pati' };
  const at = (n) => ts + n * 40;
  return [
    logEntry({ ts: at(0), deviceId: PIXEL, appId: 'app:2', source: 'device', level: 'error', tag: 'lowmemorykiller', pid: 12345, process: 'com.mykynk.pati',
      message: "Kill 'com.mykynk.pati' (12345), uid 10234, oom_score_adj 0 to free 182340kB rss, 2048kB swap; reason: low watermark is breached",
      data: { termination: 'low-memory', reporterPid: 512, process: 'com.mykynk.pati', pid: 12345, adj: 0, visible: true, freedKb: 182340, reason: 'low watermark is breached' } }),
    logEntry({ ts: at(1), deviceId: PIXEL, source: 'device', level: 'info', tag: 'ActivityTaskManager', pid: 12345, process: 'com.mykynk.pati',
      message: 'Fully drawn com.mykynk.pati/.MainActivity: +1s240ms (total +1s610ms)',
      data: { startup: { app: 'com.mykynk.pati', activity: '.MainActivity', kind: 'fully-drawn', ms: 1240, totalMs: 1610 }, reporterPid: 1203 } }),
    // Kasa (Kotlin SDK): how its earlier launches ended (ApplicationExitInfo).
    logEntry({ ts: at(2), deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'warn', tag: 'app-exit', kind: 'text',
      message: 'Previous launch was ended by Android in the foreground to free memory (low memory killer).',
      data: { previousLaunch: true, exitReason: 'lowMemory', exitedAt: ts - 3_600_000, pid: 12011, processName: 'com.mykynk.kasa', importance: 'foreground', pssMB: 312.4, rssMB: 388.1 } }),
    logEntry({ ts: at(3), deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'fatal', tag: 'crash', kind: 'crash',
      message: 'Previous launch ended: App Not Responding (ANR). The main thread was blocked, so Android closed the app.',
      error: { type: 'ANR', message: 'Input dispatching timed out (Waiting to send non-key event because the touched window has not finished processing certain input events)', stack: '"main" prio=5 tid=1 Blocked\n  at com.mykynk.kasa.sync.SyncRepository.load(SyncRepository.kt:88)\n  - waiting to lock <0x0a1b2c3d> held by thread 14\n  at com.mykynk.kasa.ui.BalanceViewModel.refresh(BalanceViewModel.kt:41)' },
      data: { previousLaunch: true, exitReason: 'anr', exitedAt: ts - 2_400_000, pid: 12088, processName: 'com.mykynk.kasa', importance: 'foreground', description: 'Input dispatching timed out' } }),
    // Pati on iOS (MetricKit): a hang and a slow launch of earlier launches.
    logEntry({ ts: at(4), deviceId: SIM, appId: 'app:4', source: 'app', level: 'warn', tag: 'app-diagnostics', kind: 'text',
      message: 'The main thread hung for 2.4 s in an earlier launch (reported by iOS).',
      data: { previousLaunch: true, source: 'MetricKit', diagnostic: 'hang', appVersion: '1.4.2', appBuild: '42', osVersion: 'iPhone OS 18.2', durationSeconds: 2.4 } }),
    logEntry({ ts: at(5), deviceId: SIM, appId: 'app:4', source: 'app', level: 'warn', tag: 'app-diagnostics', kind: 'text',
      message: 'An earlier launch took 3.1 s to start (reported by iOS).',
      data: { previousLaunch: true, source: 'MetricKit', diagnostic: 'slowLaunch', appVersion: '1.4.2', appBuild: '42', osVersion: 'iPhone OS 18.2', durationSeconds: 3.1 } }),
    // SDK diagnostics (system lines with codes).
    logEntry({ ts: at(6), deviceId: PIXEL, appId: 'app:2', source: 'system', level: 'warn', tag: 'durbun', code: 'app.messageTooLarge',
      params: { ...pati, type: 'net.response', count: 1, bytes: 23_489_331, limit: 16_777_216 },
      message: 'Dürbün dropped a 22.4 MB "net.response" message from Pati: it is over the 16 MB message limit' }),
    logEntry({ ts: at(7), deviceId: PIXEL, appId: 'app:2', source: 'system', level: 'warn', tag: 'durbun', code: 'app.messageInvalid',
      params: { ...pati, type: 'metrics', count: 3 },
      message: 'Dürbün dropped an unreadable "metrics" message from Pati: required fields are missing or have the wrong type (3 messages since the last note)' }),
    logEntry({ ts: at(8), deviceId: PIXEL, appId: 'app:3', source: 'system', level: 'warn', tag: 'durbun', code: 'app.messageUnknown',
      params: { app: 'Kasa', bundleId: 'com.mykynk.kasa', type: 'trace.span', count: 12 },
      message: 'Dürbün does not know the "trace.span" messages Kasa sends and skipped them: its SDK is newer than this Dürbün; update Dürbün (12 messages since the last note)' }),
    logEntry({ ts: at(9), deviceId: PIXEL, appId: 'app:3', source: 'system', level: 'warn', tag: 'durbun', code: 'app.sdkNewer',
      params: { app: 'Kasa', bundleId: 'com.mykynk.kasa', sdk: 'durbun-android', sdkVersion: '0.4.0', protocol: 2, serverProtocol: 1, minProtocol: 1 },
      message: 'Kasa uses durbun-android 0.4.0 (protocol 2), newer than this Dürbün understands (protocol 1): some data may be missing. Update Dürbün.' }),
    logEntry({ ts: at(10), deviceId: SIM, appId: 'app:4', source: 'system', level: 'warn', tag: 'durbun', code: 'app.sdkOlder',
      params: { ...pati, sdk: 'durbun', sdkVersion: '0.0.9', protocol: 0, serverProtocol: 1, minProtocol: 1 },
      message: 'Pati uses durbun 0.0.9 (protocol 0), older than this Dürbün supports (protocol 1 or later): some data may be missing. Update the Dürbün SDK in the app.' }),
    logEntry({ ts: at(11), deviceId: PIXEL, appId: 'app:2', source: 'system', level: 'warn', tag: 'durbun', code: 'app.clockBehind',
      params: { ...pati, device: 'Pixel 8', seconds: 42, offsetMs: 42_310, accuracyMs: 180 },
      message: 'The clock of Pixel 8 is about 42 s behind the Mac (measured while Pati was connected, ±0.2 s). Times of its log lines are shown as the device reports them.' }),
    logEntry({ ts: at(12), deviceId: SIM, appId: 'app:4', source: 'system', level: 'warn', tag: 'durbun', code: 'app.clockAhead',
      params: { ...pati, device: 'iPhone 16 Pro', seconds: 8, offsetMs: -8_120, accuracyMs: 40 },
      message: 'The clock of iPhone 16 Pro is about 8 s ahead of the Mac (measured while Pati was connected, ±0.1 s). Times of its log lines are shown as the device reports them.' }),
    // Flutter SDK, a --split-debug-info build: the Dart stack has addresses only; data.symbolize is the command (error_hooks.dart).
    logEntry({ ts: at(15), deviceId: PIXEL, appId: 'app:2', source: 'app', level: 'fatal', tag: 'flutter', kind: 'crash',
      message: 'Unhandled exception: Bad state: No element',
      error: { type: 'StateError', message: 'Bad state: No element', stack: ADDRESS_ONLY_STACK },
      data: { source: 'zone', symbolize: 'flutter symbolize -i stack.txt -d <split-debug-info folder>/app.android-arm64.symbols' } }),
    // Android SDK: no OkHttp client had DurbunInterceptor 30 s after start (DurbunCore.kt), worded by the desktop from data.reason.
    logEntry({ ts: at(14), deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'info', tag: 'durbun', kind: 'text',
      message: 'No OkHttp client in this app has DurbunInterceptor yet, so its HTTP calls do not show up in Dürbün. Add .addInterceptor(DurbunInterceptor()) to every OkHttpClient.Builder, including the ones Retrofit, Coil, Glide or Ktor use. HttpURLConnection, Cronet and WebView traffic is not captured.',
      data: { reason: 'noInterceptor', afterMs: 30_000 } }),
    logEntry({ ts: at(13), deviceId: PIXEL, appId: 'app:3', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'app.deviceFound',
      params: { app: 'Kasa', bundleId: 'com.mykynk.kasa', device: 'Pixel 8', deviceId: PIXEL, from: 'net:192.168.1.24' },
      message: 'Kasa (connected over the network) runs on Pixel 8: its session now shows under this device' }),
  ];
}

/**
 * Requests for the newer network states: a response and a request too large for Dürbün (hub/index.ts
 * markTooLarge), and a request to a test server with a self-signed certificate (replay offers to resend unverified).
 */
function showcaseRequests() {
  const now = Date.now() - 90_000;
  const base = (id, appId, method, url, extra) => {
    const u = new URL(url);
    const e = { id, appId, deviceId: PIXEL, source: appId === 'app:3' ? 'okhttp' : 'dart:io', method, url, host: u.host, path: u.pathname + u.search, startTs: now, requestHeaders: [['Accept', 'application/json']], hasRequestBody: false, hasResponseBody: false, ...extra };
    network.set(id, e);
  };
  base(`app:2:${netSeq++}`, 'app:2', 'GET', 'https://cdn.pati.app/export/all-photos.zip', {
    state: 'failed', status: 200, endTs: now + 4_200, duration: 4_200,
    error: 'Dürbün could not receive this response: its message (22.4 MB) is over the 16 MB limit. The app itself got the response.',
    tooLarge: { part: 'response', bytes: 23_489_331, limit: 16_777_216 },
  });
  base(`app:2:${netSeq++}`, 'app:2', 'POST', 'https://api.pati.app/v1/pets/42/video', {
    requestHeaders: [], state: 'complete', status: 201, statusText: 'Created', endTs: now + 6_100, duration: 6_100,
    tooLarge: { part: 'request', bytes: 41_943_040, limit: 16_777_216 },
  });
  // A respond mock the Android SDK could not apply (DurbunInterceptor added as a network interceptor, OkHttpCapture.kt):
  // the real response is kept and one line per rule says why, with the request's id.
  const skippedSeq = netSeq++;
  base(`app:3:${skippedSeq}`, 'app:3', 'POST', 'https://api.pati.app/v1/payments', {
    state: 'complete', status: 200, statusText: 'OK', endTs: now + 310, duration: 310, responseContentType: 'application/json', responseBodySize: 16,
  });
  logs.push(logEntry({ ts: now + 312, deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'warn', tag: 'durbun', kind: 'text',
    message: 'Mock "Payment error" was not applied to POST https://api.pati.app/v1/payments: this client has DurbunInterceptor as a network interceptor, which cannot answer a call without the network. Add it with addInterceptor(...) for respond mocks (delay and fail mocks work in both places).',
    data: { mockRuleId: 'm1', requestId: String(skippedSeq), reason: 'networkInterceptor' } }));
  base(`app:3:${netSeq++}`, 'app:3', 'GET', 'https://qa.internal.example/v2/health', {
    state: 'failed', endTs: now + 140, duration: 140, error: 'Trust anchor for certification path not found (self-signed certificate)',
  });
}

/* ───────────── stream entries: WebSocket messages, SSE events (SPEC §6.1.1) ───────────── */
// Same limits as the server (hub/streams.ts): the first STREAM_HEAD_KEPT of a connection are kept longest, then the
// newest up to MAX_STREAM_MESSAGES; every message removed counts into stream.dropped (a gap in seq).
const STREAM_HEAD_KEPT = 100;
const MAX_STREAM_MESSAGES = 2000;
const STREAM_MESSAGE_CAP = 64 * 1024;
const STREAM_APP_GONE = 'The app disconnected';
const streamMsgs = new Map(); // entry id → StreamMessage[] (held, seq order)
const streamDirty = new Set(); // entry ids whose counts changed since the last flush
const unhooked = new Set(); // handshakes the SDK sent with `noStream` (it has no hook on that socket)

function streamInfo(kind, openTs) {
  return { kind, state: 'open', openTs, count: 0, in: 0, out: 0, control: 0, bytesIn: 0, bytesOut: 0, dropped: 0, lastSeq: 0 };
}

/** A payload as the SDK sends it: none while body capture is off, cut at min(maxBodyBytes, 64 KiB). */
function streamBody(payload) {
  if (payload === undefined) return { size: 0 };
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = bytes.length;
  if (!settings.captureBodies) return { size };
  const cap = Math.min(settings.maxBodyBytes, STREAM_MESSAGE_CAP);
  if (typeof payload === 'string') {
    const data = payload.length > cap ? payload.slice(0, cap) : payload;
    return { size, body: data === payload ? { encoding: 'utf8', data, size } : { encoding: 'utf8', data, size, truncated: true } };
  }
  const kept = bytes.subarray(0, cap);
  return { size, body: { encoding: 'base64', data: kept.toString('base64'), size, ...(kept.length < size ? { truncated: true } : {}) } };
}

/** The app sends stream messages (`streams` capability) and its config asks for them (`captureStreams`). */
function streamsAsked(app) {
  return !!app?.capabilities.includes('streams') && settings.captureStreams !== false;
}

/**
 * Opens a connection: its handshake request and response (101 / SSE headers). Like the server (SPEC §6.1.1), the
 * entry gets its `stream` only when `streamsAsked`; otherwise it is a plain 101 / event-stream response, and a stream
 * appears with a first message.
 */
function openStream({ appId, kind, url, startTs, headers = [], source, noHook = false }) {
  const app = apps.find((a) => a.id === appId);
  const u = new URL(url);
  const id = `${appId}:${netSeq++}`;
  const ws = kind === 'websocket';
  const handshake = int(90, 260);
  const entry = {
    id,
    appId,
    deviceId: app?.deviceId ?? PIXEL,
    source: source ?? (app?.sdk.platform === 'android' ? 'okhttp' : 'dart:io'),
    method: 'GET',
    url,
    host: u.host,
    path: u.pathname + u.search,
    startTs,
    endTs: startTs + handshake,
    duration: handshake,
    state: 'complete',
    status: ws ? 101 : 200,
    statusText: ws ? 'Switching Protocols' : 'OK',
    requestHeaders: ws
      ? [['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Protocol', 'pati-chat.v2'], ...headers]
      : [['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache'], ...headers],
    responseHeaders: ws
      ? [['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Accept', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='], ['Sec-WebSocket-Protocol', 'pati-chat.v2']]
      : [['Content-Type', 'text/event-stream; charset=utf-8'], ['Cache-Control', 'no-cache'], ['X-Accel-Buffering', 'no']],
    responseContentType: ws ? undefined : 'text/event-stream; charset=utf-8',
    protocol: ws ? 'http/1.1' : 'h2',
    hasRequestBody: false,
    hasResponseBody: false,
  };
  // `noHook`: the SDK saw the handshake but has no hook on the socket (net.response.noStream): plain, no messages ever.
  if (noHook) unhooked.add(id);
  else if (streamsAsked(app)) {
    entry.stream = streamInfo(kind, startTs + handshake);
    streamMsgs.set(id, []);
  }
  network.set(id, entry);
  streamDirty.add(id);
  return entry;
}

/** One message (the server numbers it): counts, limits, close frames. `payload`: string (text) or Buffer (binary). */
function streamMessage(id, { ts, dir = 'in', type, payload, closeCode, closeReason, event, eventId, retry }) {
  const entry = network.get(id);
  if (!entry) return;
  if (!entry.stream) {
    if (unhooked.has(id)) return;
    // Capture was turned on after the handshake: the stream starts with this message (server hub/network.ts).
    if (!streamsAsked(apps.find((a) => a.id === entry.appId))) return;
    entry.stream = streamInfo(entry.status === 101 ? 'websocket' : 'sse', entry.endTs);
    streamMsgs.set(id, []);
  }
  const info = { ...entry.stream };
  const part = streamBody(payload);
  const m = { seq: info.lastSeq + 1, ts, dir, type, size: part.size };
  if (part.body) m.body = part.body;
  if (closeCode !== undefined) m.closeCode = closeCode;
  if (closeReason) m.closeReason = closeReason;
  if (event) m.event = event;
  if (eventId !== undefined) m.eventId = eventId;
  if (retry !== undefined) m.retry = retry;
  info.lastSeq = m.seq;
  info.lastTs = ts;
  info.count++;
  if (dir === 'in') {
    info.in++;
    info.bytesIn += m.size;
  } else {
    info.out++;
    info.bytesOut += m.size;
  }
  if (type === 'ping' || type === 'pong') info.control++;
  if (type === 'close' && info.state === 'open') Object.assign(info, { state: 'closed', closedTs: ts, closedBy: dir, ...(closeCode !== undefined ? { closeCode } : {}), ...(closeReason ? { closeReason } : {}) });
  const held = streamMsgs.get(id);
  held.push(m);
  while (held.length > MAX_STREAM_MESSAGES) {
    held.splice(STREAM_HEAD_KEPT, 1);
    info.dropped++;
  }
  entry.stream = info;
  streamDirty.add(id);
}

function endStream(id, patch) {
  const entry = network.get(id);
  if (!entry?.stream || entry.stream.state !== 'open') return;
  entry.stream = { ...entry.stream, ...patch };
  streamDirty.add(id);
}

/** The app left: its open streams fail (server STREAM_APP_GONE). */
function endStreamsOf(appId, ts) {
  for (const e of network.values()) if (e.appId === appId && e.stream?.state === 'open') endStream(e.id, { state: 'failed', closedTs: ts, error: STREAM_APP_GONE });
}

const VET_LINES = ['Merhaba, Pamuk bugün nasıl?', 'Aşı randevusu yarın 10:30’da.', 'İlacını günde iki kez, yemekten sonra verin.', 'Fotoğrafı aldım, yara iyileşiyor görünüyor 👍', 'Kontrol için cuma uygun mu?', 'Tahlil sonuçları normal çıktı.'];
const OWNER_LINES = ['Teşekkürler!', 'Biraz halsiz, iştahı az', 'Cuma olur', 'Mamasını değiştirmeli miyiz?', 'Tamam, öyle yapıyorum'];
// Presence as MessagePack: {"user": 1042, "online": true}.
const PRESENCE = Buffer.from([0x82, 0xa4, 0x75, 0x73, 0x65, 0x72, 0xcd, 0x04, 0x12, 0xa6, 0x6f, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0xc3]);
let chatId = '';
let chatPingAt = 0;

/** One step of the vet chat at `ts` (history and live use the same mix). */
function chatStep(id, ts) {
  const roll = rnd();
  if (roll < 0.28) {
    streamMessage(id, { ts, dir: 'in', type: 'text', payload: JSON.stringify({ type: 'typing', room: 'vet-1042', from: 'vet', on: true }) });
    streamMessage(id, { ts: ts + int(60, 240), dir: 'in', type: 'text', payload: JSON.stringify({ type: 'message', room: 'vet-1042', from: 'vet', id: `m${int(10_000, 99_999)}`, text: pick(VET_LINES), sentAt: new Date(ts).toISOString() }) });
  } else if (roll < 0.45) streamMessage(id, { ts, dir: 'out', type: 'text', payload: JSON.stringify({ type: 'message', room: 'vet-1042', text: pick(OWNER_LINES), clientId: `c${int(1000, 9999)}` }) });
  else if (roll < 0.58) streamMessage(id, { ts, dir: 'out', type: 'text', payload: JSON.stringify({ type: 'read', room: 'vet-1042', upTo: 'latest' }) });
  else if (roll < 0.7) streamMessage(id, { ts, dir: 'in', type: 'binary', payload: PRESENCE });
  else if (roll < 0.82) streamMessage(id, { ts, dir: 'in', type: 'text', payload: JSON.stringify({ type: 'appointment.status', appointmentId: 5521, status: pick(['confirmed', 'waiting', 'in_room']), etaMin: int(2, 20) }) });
  else {
    streamMessage(id, { ts, dir: 'out', type: 'ping' });
    streamMessage(id, { ts: ts + int(30, 90), dir: 'in', type: 'pong' });
  }
}

let queueId = '';
let queueEventId = 0;
let queuePosition = 5;
let queueLeft = 12;

function queueEvent(id, ts) {
  if (chance(0.25)) {
    streamMessage(id, { ts, type: 'event', payload: JSON.stringify({ type: 'notice', text: 'Dr. Ayşe Demir 5 dakika gecikiyor' }), eventId: String(++queueEventId) });
    return;
  }
  if (queuePosition > 1 && chance(0.6)) queuePosition--;
  else if (queuePosition <= 1) queuePosition = int(4, 7);
  streamMessage(id, { ts, type: 'event', event: 'queue', payload: JSON.stringify({ position: queuePosition, etaMin: queuePosition * 6 }), eventId: String(++queueEventId) });
  if (queuePosition === 1) streamMessage(id, { ts: ts + 5, type: 'event', event: 'called', payload: JSON.stringify({ room: 'Muayene 2', pet: 'Pamuk' }), eventId: String(++queueEventId) });
}

function openQueue(startTs) {
  const headers = queueEventId > 0 ? [['Last-Event-ID', String(queueEventId)]] : [];
  const e = openStream({ appId: 'app:4', kind: 'sse', url: 'https://api.pati.app/v1/clinic/queue/stream?clinic=12', startTs, headers });
  queueId = e.id;
  queueLeft = int(10, 14);
  streamMessage(e.id, { ts: (e.stream?.openTs ?? e.endTs) + 5, type: 'event', event: 'queue', payload: JSON.stringify({ position: queuePosition, etaMin: queuePosition * 6 }), eventId: String(++queueEventId), retry: 5000 });
}

function seedStreams() {
  const now = Date.now();
  // 1. Pati's vet chat: open for 9 minutes, 2 000+ messages (a gap after the first 100), still growing.
  const chat = openStream({ appId: 'app:2', kind: 'websocket', url: 'wss://chat.pati.app/v2/socket?room=vet-1042', startTs: now - 9 * 60_000, headers: [['Authorization', `Bearer ${mockJwt(now)}`]] });
  chatId = chat.id;
  let ts = chat.stream.openTs + 20;
  streamMessage(chatId, { ts, dir: 'out', type: 'text', payload: JSON.stringify({ type: 'auth', token: mockJwt(now), device: 'android', app: '1.4.2' }) });
  streamMessage(chatId, { ts: (ts += 60), dir: 'in', type: 'text', payload: JSON.stringify({ type: 'auth.ok', userId: 48_213, unread: 2 }) });
  streamMessage(chatId, { ts: (ts += 120), dir: 'out', type: 'text', payload: JSON.stringify({ type: 'subscribe', rooms: ['vet-1042', 'appointments'] }) });
  streamMessage(chatId, { ts: (ts += 90), dir: 'in', type: 'text', payload: JSON.stringify({ type: 'subscribed', rooms: ['vet-1042', 'appointments'] }) });
  // The room's history: bigger than one payload keeps (cut at 64 KiB, the full size stays).
  const history = { type: 'history', room: 'vet-1042', messages: Array.from({ length: 900 }, (_, i) => ({ id: `m${10_000 + i}`, from: i % 3 ? 'vet' : 'owner', text: i % 3 ? pick(VET_LINES) : pick(OWNER_LINES), sentAt: new Date(now - 86_400_000 + i * 60_000).toISOString(), attachments: [] })) };
  streamMessage(chatId, { ts: (ts += 200), dir: 'in', type: 'text', payload: JSON.stringify(history) });
  const span = now - 4_000 - ts;
  for (let i = 0; i < 1700; i++) chatStep(chatId, ts + Math.round(((i + 1) * span) / 1700));
  chatPingAt = now;
  // 2. An earlier chat socket the server restarted: close 1001 from the server, the app answers.
  const old = openStream({ appId: 'app:2', kind: 'websocket', url: 'wss://chat.pati.app/v2/socket?room=vet-1042', startTs: now - 16 * 60_000 });
  ts = old.stream.openTs + 15;
  streamMessage(old.id, { ts, dir: 'out', type: 'text', payload: JSON.stringify({ type: 'auth', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ODIxMyJ9.c2ln', device: 'android', app: '1.4.2' }) });
  streamMessage(old.id, { ts: (ts += 70), dir: 'in', type: 'text', payload: JSON.stringify({ type: 'auth.ok', userId: 48_213, unread: 0 }) });
  for (let i = 0; i < 34; i++) chatStep(old.id, (ts += int(3_000, 9_000)));
  streamMessage(old.id, { ts: (ts += 2_000), dir: 'in', type: 'close', closeCode: 1001, closeReason: 'Server restarting' });
  streamMessage(old.id, { ts: ts + 12, dir: 'out', type: 'close', closeCode: 1001 });
  // 3. The iPhone simulator's live feed that broke (the network went away).
  const feed = openStream({ appId: 'app:4', kind: 'websocket', url: 'wss://live.pati.app/v1/feed', startTs: now - 7 * 60_000 });
  ts = feed.stream.openTs + 30;
  streamMessage(feed.id, { ts, dir: 'out', type: 'text', payload: JSON.stringify({ type: 'subscribe', topics: ['feed.nearby', 'feed.friends'] }) });
  for (let i = 0; i < 11; i++) streamMessage(feed.id, { ts: (ts += int(4_000, 12_000)), dir: 'in', type: 'text', payload: JSON.stringify({ type: 'post', id: 9000 + i, author: pick(['Boncuk', 'Duman', 'Zeytin']), likes: int(0, 40) }) });
  endStream(feed.id, { state: 'failed', closedTs: ts + 3_000, error: 'The network connection was lost. (NSURLErrorDomain -1005)' });
  // 4. The clinic queue over SSE (named events, ids, retry); it ends now and then and reconnects with Last-Event-ID.
  openQueue(now - 5 * 60_000);
  ts = network.get(queueId).stream.openTs + 10;
  for (let i = 0; i < 9; i++) queueEvent(queueId, (ts += int(4_000, 9_000)));
  // 5. A notifications socket open with nothing sent yet.
  openStream({ appId: 'app:4', kind: 'websocket', url: 'wss://push.pati.app/v1/live', startTs: now - 60_000 });
  // 6. Kasa's balance socket (Android): its SDK captures streams but the socket was opened without
  //    DurbunWebSocketFactory, so the server keeps it a plain 101 (the SDK's noWebSocketFactory line is in Logs).
  openStream({ appId: 'app:3', kind: 'websocket', url: 'wss://rt.kasa.app/v2/balance', startTs: now - 3 * 60_000, noHook: true });
  // 7. Kasa on iOS: its SDK has no `streams` capability, so the handshake stays a plain 101.
  openStream({ appId: 'app:5', kind: 'websocket', url: 'wss://rt.kasa.app/v2/balance', startTs: now - 90_000, source: 'URLSession' });
}

/** Live: the chat grows, pings now and then; the queue gets events, ends and reconnects. */
function simulateStreams(now) {
  if (!settings.captureStreams) return;
  if (chatId && tick % 20 === 0 && chance(0.6)) chatStep(chatId, now);
  if (chatId && now - chatPingAt > 15_000) {
    chatPingAt = now;
    streamMessage(chatId, { ts: now, dir: 'out', type: 'ping' });
    streamMessage(chatId, { ts: now + int(30, 90), dir: 'in', type: 'pong' });
  }
  if (queueId && tick % 60 === 30) {
    if (--queueLeft <= 0) {
      endStream(queueId, { state: 'closed', closedTs: now });
      openQueue(now + int(1_000, 2_500));
    } else queueEvent(queueId, now);
  }
}

/** GET /api/network/:id/messages?after=<seq>&limit=<n> (StreamMessagesPage). */
function streamPage(id, after, limit) {
  const entry = network.get(id);
  if (!entry) return null;
  const held = streamMsgs.get(id) ?? [];
  const out = [];
  let more = false;
  for (const m of held) {
    if (m.seq <= after) continue;
    if (out.length >= limit) {
      more = true;
      break;
    }
    out.push(m);
  }
  return entry.stream ? { messages: out, stream: entry.stream, more } : { messages: out, more };
}

/* ───────────── a device screenshot (Device → Take screenshot) ───────────── */
let shotPng = null;
/** A small phone-shaped PNG (the mock keeps no real screenshots). */
function screenshotPng() {
  if (shotPng) return shotPng;
  const w = 270;
  const h = 585;
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let rgb = [246, 244, 239]; // background
      if (y < 28) rgb = [30, 30, 36]; // status bar
      else if (y < 84) rgb = [106, 91, 236]; // app bar
      else {
        const card = Math.floor((y - 100) / 92);
        const inCard = y >= 100 && (y - 100) % 92 < 78 && x >= 14 && x < w - 14 && card < 5;
        if (inCard) rgb = (y - 100) % 92 < 22 && x < 120 ? [210, 206, 245] : [255, 255, 255];
      }
      if (y > h - 60 && y < h - 54 && x > 95 && x < 175) rgb = [60, 60, 70]; // home indicator
      raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  shotPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return shotPng;
}

/* ───────────── metrics history (a reloaded window gets its charts back) ───────────── */
const METRICS_KEPT = 600 * 5; // ~10 minutes of five connected apps
const metricsHistory = [];
/**
 * One metrics sample. Frame times only where the SDK measures them: Flutter (build / raster) and native Android
 * (FrameMetrics: UI thread / RenderThread). Native Android counts only drawn frames: while its screen is idle
 * (about a third of the time here) the sample has no `fps`, janky frames or frame times. iOS: no frame times.
 */
function metricSample(a, ts, burst = false) {
  const platform = a.sdk.platform;
  const sample = {
    ts,
    deviceId: a.deviceId,
    appId: a.id,
    source: 'sdk',
    cpu: Math.round((8 + rnd() * 35 + (burst ? 30 : 0)) * 10) / 10,
    memoryMB: Math.round(190 + Math.sin(ts / 4000) * 20 + rnd() * 8),
    heapMB: Math.round(62 + rnd() * 18),
  };
  const drawing = platform !== 'android' || Math.floor(ts / 9_000) % 3 !== 0;
  if (!drawing) return sample;
  sample.fps = chance(0.1) ? int(38, 52) : int(57, 60);
  sample.jankyFrames = chance(0.15) ? int(1, 6) : 0;
  if (platform === 'flutter' || platform === 'dart-vm') {
    sample.frameBuildMs = Math.round(rnd() * 9 * 10) / 10;
    sample.frameRasterMs = Math.round(rnd() * 7 * 10) / 10;
  } else if (platform === 'android') {
    sample.frameBuildMs = Math.round((2 + rnd() * 6 + (chance(0.08) ? 12 : 0)) * 10) / 10;
    sample.frameRasterMs = Math.round((1.5 + rnd() * 4.5) * 10) / 10;
  }
  return sample;
}
function keepMetric(sample) {
  metricsHistory.push(sample);
  if (metricsHistory.length > METRICS_KEPT) metricsHistory.splice(0, metricsHistory.length - METRICS_KEPT);
}
function seedMetrics() {
  metricsHistory.length = 0;
  if (empty) return;
  const now = Date.now();
  for (let ts = now - 5 * 60_000; ts < now; ts += 1000) for (const a of apps.filter((x) => x.connected)) keepMetric(metricSample(a, ts));
}

/* ───────────── broadcasting ───────────── */
const clients = new Set();
const queue = { logs: [], network: [], devices: [], apps: [], metrics: [], processes: [], removedDevices: [], deviceApps: [], removedDeviceApps: [] };

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
/** Windows showing a session recording (ws → recording id): only server-wide messages reach them. */
const viewClients = new Map();
const SERVER_WIDE = new Set(['settings', 'mocks', 'flows', 'flowRun', 'drivers', 'notice']);
function broadcast(msg) {
  for (const ws of clients) send(ws, msg);
  if (SERVER_WIDE.has(msg.type)) for (const ws of viewClients.keys()) send(ws, msg);
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
    mocks: mockRules.rules,
    mocksRevision: mockRules.revision,
    mockHits: mockHitsWire(),
    drivers: drivers(),
    processes: [...processes.values()],
    metrics: metricsHistory,
    deviceApps,
    logCount: logs.length,
    flows: flowSummaries(),
    flowRuns: [],
  };
}

function flush() {
  const msg = { type: 'batch' };
  let any = false;
  for (const id of streamDirty) {
    const e = network.get(id);
    if (e) queue.network.push(strip(e));
  }
  streamDirty.clear();
  for (const e of queue.network) countMockHit(e);
  if (mockHitsChanged) {
    // The whole map, only when a count changed (it replaces the previous one).
    msg.mockHits = mockHitsWire();
    mockHitsChanged = false;
    any = true;
  }
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
  simulateStreams(now);
  // metrics every second (kept for the next snapshot, so a reloaded window has its charts)
  if (tick % 10 === 0) {
    for (const a of apps.filter((x) => x.connected)) {
      const sample = metricSample(a, now, burst);
      keepMetric(sample);
      queue.metrics.push(sample);
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
        actions: ANDROID_ACTIONS.filter((a) => a !== 'wifi' && a !== 'airplane-mode'),
        // Unplugged after the prompt: it carries on over wireless debugging (adb-tls-connect serial).
        connection: 'wifi',
        connections: ['wifi'],
        serial: 'adb-RF8N30ABCD-x7Kp2a._adb-tls-connect._tcp',
        hardwareSerial: 'RF8N30ABCD',
        unavailableActions: [
          { action: 'wifi', code: 'action.wouldDisconnect', params: { connection: 'wifi' } },
          { action: 'airplane-mode', code: 'action.wouldDisconnect', params: { connection: 'wifi' } },
        ],
        // A device report someone started from another window, still collecting.
        bugReport: { startedAt: now - 40_000, progress: 12 },
        // Some OEM builds refuse `dumpsys dropbox` to the shell user.
        readers: { crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'dumpsys dropbox: Permission Denial: can\'t access dropbox from pid=8812, uid=2000' }, frameStats: { status: 'ok' } },
        lastSeen: now,
      });
      const store = { key: `${g.id}|com.mykynk.kumbara`, deviceId: g.id, id: 'com.mykynk.kumbara', name: 'Kumbara', version: '3.0.4', build: '398', buildType: 'release', install: { source: 'other-store', installer: 'com.sec.android.app.samsungapps' }, pids: [7120], running: true, lastActivity: now };
      deviceApps.push(store);
      queue.deviceApps.push(store);
      queue.devices.push(g);
      pushLogs([logEntry({ ts: now, deviceId: g.id, source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: 'device.connected', params: { device: 'Galaxy S23', deviceId: g.id, platform: 'android', kind: 'physical', connection: 'wifi', osVersion: '14' }, message: 'Device connected: Galaxy S23 (Android 14)' })]);
    }
  }
  // the Galaxy's device report (started elsewhere) creeps towards 100 %
  if (tick > 650 && tick % 10 === 0) {
    const g = devices.find((d) => d.id === 'android:RF8N30ABCD');
    if (g?.bugReport && !bugReports.has(g.id)) {
      const progress = Math.min(100, (g.bugReport.progress ?? 0) + 1);
      if (progress >= 100) delete g.bugReport;
      else g.bugReport = { ...g.bugReport, progress };
      queue.devices.push(g);
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
      // Same params as the real server (hub/lifecycle.ts appParams): the session's own app, SDK platform and transport.
      const params = { app: k.app.name, bundleId: k.app.id, version: k.app.version ?? '', sdk: k.sdk.platform, transport: k.transport, device: 'Pixel 8' };
      pushLogs([
        logEntry({ ts: now, deviceId: PIXEL, appId: 'app:3', source: 'system', level: 'info', tag: 'durbun', kind: 'lifecycle', code: k.connected ? 'app.reconnected' : 'app.disconnected', params: k.connected ? params : { ...params, failedRequests: 0 }, message: k.connected ? `Kasa reconnected (${k.transport})` : 'Kasa disconnected' }),
      ]);
      // An app that leaves ends its open streams (server hub/network.ts endStreams); back, it opens its socket again.
      if (!k.connected) endStreamsOf('app:3', now);
      else {
        pushLogs([logEntry({ ts: now + 20, deviceId: PIXEL, appId: 'app:3', source: 'app', level: 'info', tag: 'event', kind: 'event', message: 'durbun.launch', data: { kind: 'cold', ms: int(980, 1600), to: 'firstFrame', from: 'launchRequest', screen: 'MainActivity' } })]);
        openStream({ appId: 'app:3', kind: 'websocket', url: 'wss://rt.kasa.app/v2/balance', startTs: now, noHook: true });
      }
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
    streamMsgs.clear();
    chatId = '';
    queueId = '';
  }
  seedHistory();
  for (const ws of clients) syncClient(ws);
}

/* ───────────── media library (like server http/media.ts) ───────────── */
const media = createMockMedia({ png: screenshotPng, sampleVideo: argValue('--sample-video'), devices: baseDevices() });
const wireless = createMockWireless();
const recs = createMockRecordings({
  mode: argValue('--recordings', 'seeded'),
  liveDevices: () => devices.filter((d) => !d.id.startsWith('import:')).map((d) => ({ id: d.id, name: d.name, platform: d.platform })),
  liveCounts: () => ({ logs: logs.length, requests: network.size, errors: logs.reduce((n, l) => n + (l.level === 'error' || l.level === 'fatal' ? 1 : 0), 0), crashes: 0 }),
});

/* ── an opened recording: a frozen copy of the data at that moment, its devices imported (read-only) ── */
const frozen = new Map();
function viewData(id) {
  const opened = recs.view(id);
  if (!opened) return undefined;
  let v = frozen.get(id);
  if (v) return v;
  const r = opened.recording;
  const label = `recording ${new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ')}`;
  const ids = new Map(devices.filter((d) => !d.id.startsWith('import:')).map((d, i) => [d.id, `import:${900 + frozen.size * 10 + i}`]));
  const dev = (x) => ids.get(x) ?? x;
  const shift = Date.now() - r.lastWriteAt;
  v = {
    opened,
    devices: devices
      .filter((d) => ids.has(d.id))
      .map((d) => ({ ...d, id: dev(d.id), state: 'disconnected', stateCode: 'device.imported', stateDetail: `Imported from ${label}`, logs: { status: 'stopped' }, actions: [], lastSeen: d.lastSeen - shift })),
    apps: apps.map((a) => ({ ...a, deviceId: dev(a.deviceId), connected: false })),
    deviceApps: deviceApps.map((d) => ({ ...d, deviceId: dev(d.deviceId) })),
    logs: logs.slice(-4000).map((e) => ({ ...e, deviceId: dev(e.deviceId), ts: e.ts - shift })),
    network: new Map([...network.values()].map((n) => [n.id, { ...n, deviceId: dev(n.deviceId), ts: n.ts - shift, ...(n.endTs ? { endTs: n.endTs - shift } : {}) }])),
  };
  frozen.set(id, v);
  return v;
}
function viewSnapshot(v) {
  return { type: 'snapshot', devices: v.devices, apps: v.apps, network: [...v.network.values()].map(strip), mocks: mockRules.rules, mocksRevision: mockRules.revision, drivers: drivers(), processes: [], metrics: [], deviceApps: v.deviceApps, logCount: v.logs.length, flows: flowSummaries(), flowRuns: [] };
}
function viewExport(v, mask) {
  const exp = { format: 'durbun-session', version: 1, exportedAt: Date.now(), server: { version: '0.3.2' }, devices: v.devices, apps: v.apps, logs: v.logs, network: [...v.network.values()], deviceApps: v.deviceApps };
  if (mask) {
    exp.network = exp.network.map(maskDetail);
    exp.masked = true;
  }
  return exp;
}
/** REST a `view=<id>` sends to the opened recording (the server's VIEW_PATHS). */
const VIEW_PATHS = /^\/api\/(?:network(?:\/.*)?|har|export|bug-report)\/?$/;
if (!args.includes('--no-media')) media.seed();

/** Keep a screenshot / recording and put its marker on the device's log timeline (as the server does for a window). */
function keepMedia(deviceId, kind, extra) {
  const d = devices.find((x) => x.id === deviceId) ?? { id: deviceId, name: deviceId, platform: 'android' };
  const params = kind === 'screenshot' ? { device: d.name } : { device: d.name, duration: mediaClock(extra.durationSec ?? 0) };
  const message = kind === 'screenshot' ? `Screenshot · ${d.name}` : `Screen recording · ${d.name} · ${params.duration}`;
  const entry = logEntry({ ts: Date.now(), deviceId, source: 'system', level: 'info', tag: 'durbun', kind: 'marker', code: `media.${kind}`, params, message });
  const item = media.add(d, kind, { ...extra, logId: entry.id });
  entry.data = { media: { id: item.id, kind } };
  pushLogs([entry]);
  return item;
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
  const item = keepMedia(deviceId, 'recording', { ts: rec.startedAt, durationSec });
  for (const reply of rec.replies) reply({ url: '/api/files/recording.mov', file: '/tmp/recording.mov', durationSec, endedBy: rec.endedBy, media: item });
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

/* ───────────── tester actions (like android/deviceSettings.ts, android/bugReport.ts, ios/simActions.ts) ───────────── */
const bugReports = new Map();
const SETTING_ACTIONS = new Set(['airplane-mode', 'wifi', 'mobile-data', 'rotation', 'dont-keep-activities', 'app-permission', 'app-locale']);
const ROTATION_VALUES = ['auto', 'portrait', 'landscape', 'reverse-portrait', 'reverse-landscape'];
/** What the phone had before Dürbün touched it (the server reads it with `settings get` / `dumpsys package`). */
const DEVICE_DEFAULTS = { 'airplane-mode': 'off', wifi: 'on', 'mobile-data': 'on', rotation: 'auto', 'dont-keep-activities': '0', 'app-permission': 'granted', 'app-locale': 'system' };

function changeDevice(d) {
  d.lastSeen = Date.now();
  queue.devices.push(d);
}

/** A setting change with the server's override bookkeeping: per action, app-scoped ones per app and permission. */
function changeSetting(d, command, reply) {
  const { action } = command;
  const p = command.params ?? {};
  const scope = action === 'app-permission' ? { appId: p.appId, key: p.permission } : action === 'app-locale' ? { appId: p.appId } : {};
  if ((action === 'app-permission' || action === 'app-locale') && (typeof p.appId !== 'string' || !p.appId)) return reply(undefined, false, 'A valid package name (appId) is required', 'action.invalidParams', { param: 'appId', expected: 'appId' });
  if (action === 'app-permission' && !/^[A-Za-z][\w.]*\.[A-Z_0-9]+$/.test(p.permission ?? '')) return reply(undefined, false, 'permission must be a permission name such as android.permission.CAMERA', 'action.invalidParams', { param: 'permission', expected: 'permission' });
  const overrides = (d.settingOverrides ??= []);
  const same = (o) => o.action === action && (o.appId ?? '') === (scope.appId ?? '') && (o.key ?? '') === (scope.key ?? '');
  const kept = overrides.find(same);
  if (p.restore === true) {
    if (!kept) return reply(null, true, undefined, 'action.nothingToRestore');
    d.settingOverrides = overrides.filter((o) => o !== kept);
    changeDevice(d);
    return reply({ previous: kept.current, current: kept.previous }, true, undefined, 'action.settingRestored');
  }
  let value;
  if (action === 'rotation') {
    if (!ROTATION_VALUES.includes(p.orientation)) return reply(undefined, false, 'orientation must be auto, portrait, landscape, reverse-portrait or reverse-landscape', 'action.invalidParams', { param: 'orientation', expected: 'oneOf', options: 'auto, portrait, landscape, reverse-portrait, reverse-landscape' });
    value = p.orientation;
  } else if (action === 'app-permission') {
    if (typeof p.grant !== 'boolean') return reply(undefined, false, 'grant (boolean) is required', 'action.invalidParams', { param: 'grant', expected: 'boolean' });
    // Two of the refusals adb gives, so their texts can be seen.
    if (p.permission === 'android.permission.BODY_SENSORS') return reply(undefined, false, `${p.appId} does not ask for ${p.permission}`, 'action.permissionNotRequested');
    if (!p.permission.startsWith('android.permission.')) return reply(undefined, false, `Android does not know the permission ${p.permission}`, 'action.permissionUnknown');
    value = p.grant ? 'granted' : 'revoked';
  } else if (action === 'app-locale') {
    if (typeof p.locale !== 'string' || !p.locale) return reply(undefined, false, 'locale must be a language tag such as tr-TR, or "system"', 'action.invalidParams', { param: 'locale', expected: 'locale' });
    value = p.locale;
  } else {
    if (typeof p.enabled !== 'boolean') return reply(undefined, false, 'enabled (boolean) is required', 'action.invalidParams', { param: 'enabled', expected: 'boolean' });
    value = action === 'dont-keep-activities' ? (p.enabled ? '1' : '0') : p.enabled ? 'on' : 'off';
  }
  const before = kept?.previous ?? DEVICE_DEFAULTS[action];
  d.settingOverrides = overrides.filter((o) => o !== kept);
  if (before !== value) d.settingOverrides.push({ action, ...(scope.appId ? { appId: scope.appId } : {}), ...(scope.key ? { key: scope.key } : {}), previous: before, current: value, since: kept?.since ?? Date.now() });
  changeDevice(d);
  return reply(null);
}

/** `adb bugreport` like the server: progress on the device record, the zip at the end; cancel kills it. */
function bugReport(d, command, reply) {
  if (command.action === 'bug-report-cancel') {
    const run = bugReports.get(d.id);
    if (run) {
      clearInterval(run.timer);
      bugReports.delete(d.id);
      delete d.bugReport;
      changeDevice(d);
      run.reply(undefined, false, 'The device report was cancelled', 'action.bugReport.cancelled');
      return reply(null, true, undefined, 'action.bugReport.cancelled');
    }
    // One started from another window (the Galaxy's): there is no waiter here.
    if (d.bugReport) {
      delete d.bugReport;
      changeDevice(d);
      return reply(null, true, undefined, 'action.bugReport.cancelled');
    }
    return reply(undefined, false, 'No device report is being collected', 'action.bugReport.notRunning');
  }
  if (bugReports.has(d.id) || d.bugReport) return reply(undefined, false, 'A device report is already being collected on this phone', 'action.bugReport.busy');
  const startedAt = Date.now();
  d.bugReport = { startedAt };
  changeDevice(d);
  const run = { reply, timer: undefined };
  run.timer = setInterval(() => {
    const progress = Math.min(100, (d.bugReport?.progress ?? 0) + 7);
    if (progress < 100) {
      d.bugReport = { startedAt, progress };
      return changeDevice(d);
    }
    clearInterval(run.timer);
    bugReports.delete(d.id);
    delete d.bugReport;
    changeDevice(d);
    const file = `/tmp/durbun/bugreport-${(d.model ?? 'phone').replace(/\s+/g, '-')}-${new Date(startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
    reply({ url: '/api/files/bugreport.zip', file, bytes: 18_400_000, durationSec: Math.round((Date.now() - startedAt) / 1000) }, true, undefined, 'action.bugReport.saved');
  }, 1500);
  bugReports.set(d.id, run);
}

/**
 * `app-data` like the drivers: a few seconds of copying, then the .tar.gz. "com.mykynk.kumbara" is not a debug build
 * (run-as refuses it); an app id containing "empty" has no data.
 */
const appDataRuns = new Set();
function appData(d, command, reply) {
  const appId = command.params?.appId;
  if (typeof appId !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.\-:]*$/.test(appId)) return reply(undefined, false, 'A valid package name (appId) is required', 'action.invalidParams', { param: 'appId', expected: 'appId' });
  if (appDataRuns.has(d.id)) return reply(undefined, false, "This device's app data is already being copied", 'action.appData.busy');
  appDataRuns.add(d.id);
  const startedAt = Date.now();
  setTimeout(() => {
    appDataRuns.delete(d.id);
    if (d.platform === 'android' && appId === 'com.mykynk.kumbara') return reply(undefined, false, `${appId} is not debuggable (not a debug build)`, 'action.appData.notDebuggable', { appId });
    if (/empty/.test(appId)) return reply(undefined, false, `${appId} has no data to copy`, 'action.appData.empty');
    reply(appDataReply(d, appId, startedAt), true, undefined, 'action.appData.saved');
  }, d.platform === 'android' ? 4200 : 1800);
}

/** Install with the server's refusal over an installed copy: a file named "*other-sig*" was signed with another key. */
function installApp(command, reply) {
  const p = command.params ?? {};
  const file = typeof p.file === 'string' ? p.file : '';
  const packageId = 'com.mykynk.pati';
  if (!file) return reply(undefined, false, 'file is required', 'action.invalidParams', { param: 'file', expected: 'absolutePath', kinds: '.apk, .aab, .apks, .app, .ipa' });
  if (/other-sig/i.test(file)) {
    if (p.replace === true) return reply({ packageId }, true, undefined, 'action.install.replaced');
    return reply({ packageId, replaceable: true }, false, `Install failed: INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ${packageId} signatures do not match newer version; ignoring!. Uninstalling ${packageId} first lets it install; that deletes its data.`, 'action.install.signatureMismatch');
  }
  if (/older/i.test(file)) {
    if (p.replace === true) return reply({ packageId }, true, undefined, 'action.install.replaced');
    return reply({ packageId, replaceable: true }, false, `Install failed: INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 41 is older than current 42. Uninstalling ${packageId} first lets it install; that deletes its data.`, 'action.install.downgrade');
  }
  return reply(null);
}

function testerAction(command, reply) {
  const d = devices.find((x) => x.id === command.deviceId);
  if (!d) return reply(undefined, false, `${command.deviceId} is not online`, 'action.deviceOffline');
  const blocked = d.unavailableActions?.find((u) => u.action === command.action);
  // As the drivers do: the reason's params go both as data and as params.
  if (blocked) return reply(blocked.params, false, `"${command.action}" is not available for ${d.name}`, blocked.code, blocked.params);
  const p = command.params ?? {};
  if (d.users && p.userId !== undefined && !d.users.some((u) => u.id === p.userId)) return reply(undefined, false, 'userId is not a user of this phone', 'action.invalidParams', { param: 'userId', expected: 'user' });
  if (command.action === 'app-install') return installApp(command, reply);
  if (command.action === 'bug-report' || command.action === 'bug-report-cancel') return bugReport(d, command, reply);
  if (command.action === 'app-data') return appData(d, command, reply);
  if (d.platform === 'ios' && command.action === 'app-permission') {
    if (typeof p.appId !== 'string' || !p.appId) return reply(undefined, false, 'A bundle id (appId) is required', 'action.invalidParams', { param: 'appId', expected: 'appId' });
    if (p.restore === true) return reply(null, true, undefined, 'action.permissionReset');
    if (typeof p.grant !== 'boolean') return reply(undefined, false, 'grant (boolean) is required', 'action.invalidParams', { param: 'grant', expected: 'boolean' });
    return reply(null);
  }
  if (SETTING_ACTIONS.has(command.action)) return changeSetting(d, command, reply);
  // keychain-reset, app-settings and the rest succeed without data.
  return reply(null);
}

/* ───────────── commands ───────────── */
function handleCommand(ws, { requestId, command }) {
  const reply = (data, ok = true, error, code, params) => send(ws, { type: 'reply', requestId, ok, data, error, code, ...(params ? { params } : {}) });
  const now = Date.now();
  switch (command?.name) {
    case 'clear': {
      const { target, deviceId, appId } = command;
      const match = (e) => (!deviceId || e.deviceId === deviceId) && (!appId || e.appId === appId);
      if (target === 'logs' || target === 'all') logs = logs.filter((e) => !match(e));
      if (target === 'network' || target === 'all') {
        for (const [id, e] of network) {
          if (!match(e)) continue;
          network.delete(id);
          streamMsgs.delete(id);
        }
      }
      broadcast({ type: 'cleared', target, deviceId, appId });
      return reply(null);
    }
    case 'marker.add': {
      const label = command.label || 'Marker';
      const entry = logEntry({ ts: now, deviceId: command.deviceId ?? PIXEL, source: 'system', level: 'info', tag: 'durbun', kind: 'marker', code: 'marker', params: { label: command.label ?? '', n: nextLogId }, message: label });
      pushLogs([entry]);
      return reply(entry);
    }
    case 'mocks.set': {
      // Another window saved since this list was loaded: refused with the current list (server http/commands.ts).
      // Each rule validated and normalized; one bad rule refuses the list (config.invalid).
      const r = mockRules.set(command);
      if (!r.ok) return reply(r.data, false, r.error, r.code);
      const ids = new Set(mockRules.rules.map((x) => x.id));
      for (const id of [...mockHits.keys()]) {
        if (ids.has(id)) continue;
        mockHits.delete(id);
        mockHitsChanged = true;
      }
      broadcast({ type: 'mocks', rules: mockRules.rules, revision: mockRules.revision });
      return reply(mockRules.rules);
    }
    case 'settings.update':
      settings = { ...settings, ...(command.patch ?? {}) };
      recs.applySettings(command.patch ?? {});
      broadcast({ type: 'settings', settings });
      if ('allowLan' in (command.patch ?? {})) for (const c of clients) send(c, { type: 'hello', server: server(), settings });
      return reply(settings);
    case 'demo.set':
      reply({ enabled: Boolean(command.enabled) });
      enableDemo(Boolean(command.enabled));
      return;
    case 'device.action':
      if (command.action === 'screenshot') return reply({ url: `/api/files/shot.png?t=${now}`, file: '/tmp/shot.png', width: 270, height: 585, media: keepMedia(command.deviceId, 'screenshot', { ts: now }) });
      if (command.action === 'screen-record' || command.action === 'screen-record-stop') return screenRecord(command, reply);
      if (command.action === 'list-apps') return reply([{ id: 'com.mykynk.pati', name: 'Pati', version: '1.4.2', debuggable: true }, { id: 'com.mykynk.kasa', name: 'Kasa', version: '2.0.1' }, { id: 'com.mykynk.kumbara', name: 'Kumbara', version: '3.1.0', debuggable: false }]);
      return testerAction(command, reply);
    case 'app.action':
      return reply(null);
    case 'vm.attach':
      // The real attach throws a plain error here, so the reply carries `command.failed` and the English message.
      if (!/ws:|http:|listening/.test(command.input ?? '')) return reply(undefined, false, 'No Dart VM service URL found. Paste the URL printed by `flutter run` ("A Dart VM Service … is available at: http://127.0.0.1:…/…=/"), a DevTools link, or the whole output.', 'command.failed');
      return reply({ appId: 'app:2' });
    case 'vm.detach':
    case 'metrics.watch':
      return reply(null);
    case 'net.replay': {
      const src = network.get(command.id);
      if (!src) return reply(undefined, false, 'Unknown request', 'net.unknown');
      const id = `replay:${netSeq++}`;
      // A self-signed test server: refused unless resent without verifying (server http/replay.ts warnings → notices).
      if (/^https:\/\/qa\.internal\./.test(src.url)) {
        const skip = command.overrides?.skipTlsVerify === true;
        const entry = skip
          ? { ...strip(src), id, appId: undefined, deviceId: 'desktop', source: 'replay', startTs: now, endTs: now + 90, duration: 90, state: 'complete', status: 200, statusText: 'OK', error: undefined, responseContentType: 'application/json', responseBodySize: 15, hasResponseBody: true }
          : { ...strip(src), id, appId: undefined, deviceId: 'desktop', source: 'replay', startTs: now, endTs: now + 60, duration: 60, state: 'failed', status: undefined, error: 'self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)' };
        network.set(id, { ...entry, ...(skip ? { responseBody: { encoding: 'utf8', data: '{"status":"ok"}', size: 15 } } : {}) });
        queue.network.push(entry);
        send(ws, skip
          ? { type: 'notice', level: 'warn', code: 'replay.tlsUnverified', message: 'Sent without verifying the server certificate' }
          : { type: 'notice', level: 'warn', code: 'replay.tlsRejected', message: 'The server certificate was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT); resend without verifying only to a test server you trust' });
        return reply(entry);
      }
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
    { id: 'adb', label: 'Android Debug Bridge (adb)', status: 'ok', version: '1.0.41', path: '/Users/dev/Library/Android/sdk/platform-tools/adb', detail: 'from ~/Library/Android/sdk', code: 'doctor.tool.from', params: { source: 'sdk' } },
    { id: 'simctl', label: 'Xcode simctl (iOS simulators)', status: 'ok', version: 'Xcode 26.1', path: '/Applications/Xcode.app/Contents/Developer', detail: '1 booted simulator(s)', code: 'doctor.simctl.booted', params: { count: 1 } },
    { id: 'usbmuxd', label: 'usbmuxd (iOS USB connection)', status: 'ok', path: '/var/run/usbmuxd', detail: '1 device(s) attached', code: 'doctor.usbmuxd.attached', params: { count: 1 } },
    // Same ids, labels and English details as the real checks (server doctor.ts + platform/ios/deviceDriver.ts):
    // the UI words them from these patterns and codes.
    { id: 'idevicesyslog', label: 'idevicesyslog (iOS device logs)', status: 'missing', detail: 'idevicesyslog was not found — install libimobiledevice (brew install libimobiledevice) or Flutter', code: 'doctor.idevicesyslog.missing', fix: 'brew install libimobiledevice', docsUrl: 'https://libimobiledevice.org' },
    { id: 'devicectl', label: 'Xcode devicectl (iOS device actions)', status: 'ok', version: '477.29', detail: 'screenshot: yes · screen recording: no', code: 'doctor.devicectl.caps', params: { screenshot: 'yes', screenRecord: 'no' } },
    { id: 'idevicescreenshot', label: 'idevicescreenshot (iOS screenshots, fallback)', status: 'ok', detail: 'not needed (devicectl captures screenshots)', code: 'doctor.idevicescreenshot.notNeeded' },
    { id: 'idevicecrashreport', label: 'idevicecrashreport (iOS crash reports, fallback)', status: 'ok', detail: 'not found (optional: used for iPhones devicectl cannot read, such as iOS 16 or Developer Mode off)', code: 'doctor.tool.optionalNotFound', fix: 'brew install libimobiledevice' },
    { id: 'ideviceinstaller', label: 'ideviceinstaller (installed iOS apps, fallback)', status: 'ok', detail: 'not found (optional: used for iPhones devicectl cannot read, such as iOS 16 or Developer Mode off)', code: 'doctor.tool.optionalNotFound', fix: 'brew install ideviceinstaller' },
    { id: 'port-http', label: `HTTP port ${PORT}`, status: 'ok', path: `127.0.0.1:${PORT}`, detail: `Listening on 127.0.0.1:${PORT}`, code: 'doctor.port.listening', params: { addr: `127.0.0.1:${PORT}` } },
    { id: 'port-sdk', label: 'SDK port 9751', status: 'warn', path: '0.0.0.0:9751', detail: 'Port 9751 is used by another program', code: 'doctor.port.inUse', params: { port: 9751 }, fix: 'lsof -nP -iTCP:9751 -sTCP:LISTEN' },
  ];
}

/* ───────────── HTTP ───────────── */
/* ── export masking: same contract as the server (packages/protocol/src/secrets.ts, a shorter copy) ── */
const MASK = '••••';
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token', 'x-session-token', 'x-csrf-token', 'x-xsrf-token']);
const SECRET_WORDS = new Set(['password', 'passwd', 'pass', 'pwd', 'passcode', 'passphrase', 'secret', 'token', 'otp', 'pin', 'auth', 'authorization', 'session', 'sessionid', 'sid', 'cookie', 'signature', 'sig', 'credential', 'credentials', 'jwt', 'apikey', 'appcheck']);
const KEY_PREFIXES = new Set(['api', 'access', 'private', 'secret', 'subscription', 'client', 'app', 'master']);
function isSecretName(name) {
  if (SECRET_HEADERS.has(name.toLowerCase())) return true;
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 1 && words[0] === 'key') return true;
  return words.some((w, i) => SECRET_WORDS.has(w) || (w === 'key' && i > 0 && KEY_PREFIXES.has(words[i - 1])));
}
function maskHeader([n, v]) {
  const l = n.toLowerCase();
  if (l.startsWith('access-control-') || !isSecretName(l)) return [n, v];
  if (l === 'cookie') return [n, v.split(';').map((p) => p.trim()).filter(Boolean).map((p) => (p.indexOf('=') > 0 ? `${p.slice(0, p.indexOf('='))}=${MASK}` : MASK)).join('; ')];
  if (l === 'authorization' || l === 'proxy-authorization') {
    const m = /^(\S+)\s+\S/.exec(v);
    return [n, m ? `${m[1]} ${MASK}` : MASK];
  }
  return [n, MASK];
}
const maskQuery = (qs) => qs.split('&').map((p) => { const eq = p.indexOf('='); return eq > 0 && eq < p.length - 1 && isSecretName(p.slice(0, eq)) ? `${p.slice(0, eq)}=${MASK}` : p; }).join('&');
const maskUrl = (u) => { const q = u.indexOf('?'); return q < 0 ? u : u.slice(0, q + 1) + maskQuery(u.slice(q + 1)); };
const maskText = (text) => text.replace(/"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g, (m, k, sep) => (isSecretName(k) ? `"${k}"${sep}"${MASK}"` : m));
const maskBody = (b) => (b && b.encoding === 'utf8' ? { ...b, data: maskText(b.data) } : b);
function maskDetail(d) {
  return { ...d, url: maskUrl(d.url), path: maskUrl(d.path ?? ''), requestHeaders: (d.requestHeaders ?? []).map(maskHeader), responseHeaders: d.responseHeaders?.map(maskHeader), requestBody: maskBody(d.requestBody), responseBody: maskBody(d.responseBody) };
}
/** A zip of [name, Buffer] pairs, stored without compression (POST /api/bug-report). */
function storedZip(entries) {
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const sum = crc(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(entry, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** `mask` of GET /api/export: only "0" / "false" / "no" / "off" export raw. */
const maskParam =(v) => !['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());
function harOf(details) {
  const pairs = (list) => (list ?? []).map(([name, value]) => ({ name, value }));
  return details.map((d) => ({
    startedDateTime: new Date(d.startTs).toISOString(),
    time: d.duration ?? 0,
    request: { method: d.method, url: d.url, httpVersion: 'HTTP/1.1', headers: pairs(d.requestHeaders), queryString: [], cookies: [], headersSize: -1, bodySize: -1, ...(d.requestBody?.encoding === 'utf8' ? { postData: { mimeType: d.requestContentType ?? '', text: d.requestBody.data } } : {}) },
    response: { status: d.status ?? 0, statusText: d.statusText ?? '', httpVersion: 'HTTP/1.1', headers: pairs(d.responseHeaders), cookies: [], content: { size: -1, mimeType: d.responseContentType ?? '', ...(d.responseBody?.encoding === 'utf8' ? { text: d.responseBody.data } : {}) }, redirectURL: '', headersSize: -1, bodySize: -1 },
    cache: {},
    timings: { send: 0, wait: d.duration ?? 0, receive: 0 },
  }));
}

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

/** Send to Slack state (the webhook itself is never kept: the mock only prints). */
const slack = { hint: undefined, sender: undefined, uploads: false, channel: undefined };

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (recs.handle(req, res, p, url.searchParams, { exportOf: (r, mask) => (viewData(r.id) ? viewExport(viewData(r.id), mask) : undefined), onDeleted: dropView })) return;
    const viewId = url.searchParams.get('view');
    const view = viewId && VIEW_PATHS.test(p) ? viewData(viewId) : undefined;
    if (viewId && VIEW_PATHS.test(p) && !view) return json(res, 404, { error: 'This recording is not open', code: 'recorder.notOpen' });
    const netOf = (id) => (view ? view.network.get(id) : network.get(id));
    if (view && p === '/api/export') {
      const date = new Date(view.opened.recording.startedAt).toISOString().slice(0, 10);
      return json(res, 200, viewExport(view, maskParam(url.searchParams.get('mask'))), { 'Content-Disposition': `attachment; filename="durbun-${date}.durbun.json"` });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, name: 'durbun', version: '0.3.2' });
    if (p === '/api/doctor') return setTimeout(() => json(res, 200, doctorChecks()), 350);
    if (p === '/api/network/search' && req.method === 'POST') {
      const { text = '', ids } = JSON.parse((await readBody(req)).toString() || '{}');
      const q = String(text).toLowerCase();
      const out = [...network.values()]
        .filter((d) => (!ids || ids.includes(d.id)) && (d.url.toLowerCase().includes(q) || (d.responseBody?.data ?? '').toLowerCase().includes(q) || (streamMsgs.get(d.id) ?? []).some((m) => (m.body?.encoding === 'utf8' && m.body.data.toLowerCase().includes(q)) || (m.closeReason ?? '').toLowerCase().includes(q) || (m.event ?? '').toLowerCase().includes(q))))
        .map((d) => d.id);
      return json(res, 200, { ids: out });
    }
    const body = /^\/api\/network\/(.+)\/body\/(request|response)$/.exec(p);
    if (body) {
      const d = netOf(decodeURIComponent(body[1]));
      const b = body[2] === 'request' ? d?.requestBody : d?.responseBody;
      if (!d || !b) return json(res, 404, { error: 'No body' });
      res.writeHead(200, { 'Content-Type': (body[2] === 'request' ? d.requestContentType : d.responseContentType) ?? 'application/octet-stream' });
      return res.end(b.encoding === 'base64' ? Buffer.from(b.data, 'base64') : b.data);
    }
    const messages = /^\/api\/network\/(.+)\/messages$/.exec(p);
    if (messages && req.method === 'GET') {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
      const limit = Math.min(2000, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? 500)) || 500));
      const page = streamPage(decodeURIComponent(messages[1]), after, limit);
      return page ? setTimeout(() => json(res, 200, page), 120) : json(res, 404, { error: 'Unknown network entry', code: 'api.notFound' });
    }
    const detail = /^\/api\/network\/(.+)$/.exec(p);
    if (detail && req.method === 'GET') {
      const d = netOf(decodeURIComponent(detail[1]));
      return d ? json(res, 200, d) : json(res, 404, { error: 'Unknown network entry', code: 'net.unknown' });
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
        server: { version: '0.3.2' },
        devices: deviceId ? devices.filter((d) => d.id === deviceId) : devices,
        apps: apps.filter((a) => appIds.has(a.id)),
        logs: logs.filter(inScope).slice(-5000),
        network: [...network.values()].filter((n) => (!deviceId || n.deviceId === deviceId) && (!appId && !bundleId ? true : appIds.has(n.appId))).map((n) => (streamMsgs.get(n.id)?.length ? { ...n, streamMessages: streamMsgs.get(n.id) } : n)),
        deviceApps: deviceApps.filter((d) => (!deviceId || d.deviceId === deviceId) && (!bundleId || d.id === bundleId)),
      };
      // Masked by default (the last member of the file says so); `mask=0` exports the raw values.
      if (maskParam(url.searchParams.get('mask'))) {
        exp.network = exp.network.map((d) => ({ ...maskDetail(d), ...(d.streamMessages ? { streamMessages: d.streamMessages.map((m) => (m.body ? { ...m, body: maskBody(m.body) } : m)) } : {}) }));
        exp.logs = exp.logs.map((e) => (e.kind === 'network' ? { ...e, message: e.message.replace(/\S+:\/\/\S+/g, maskUrl) } : e));
        exp.masked = true;
      }
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
      // Its requests: ids `import:<n>:<id>`, no app session; stream entries keep their messages (history, not live).
      for (const n of Array.isArray(data.network) ? data.network : []) {
        if (!n || typeof n.id !== 'string') continue;
        const { streamMessages, ...rest } = n;
        const e = { ...rest, id: `${id}:${n.id}`, deviceId: id, appId: undefined };
        network.set(e.id, e);
        if (e.stream) streamMsgs.set(e.id, Array.isArray(streamMessages) ? streamMessages : []);
        queue.network.push(strip(e));
      }
      return json(res, 200, { deviceIds: [id] });
    }
    if (media.handle(req, res, p, url)) return;
    if (await wireless.handle(req, res, p)) return;
    if (p === '/api/files/app-data.tar.gz' && req.method === 'GET') {
      const appId = url.searchParams.get('app') || 'com.mykynk.pati';
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="app-data-${appId.replace(/[^A-Za-z0-9._-]/g, '-')}.tar.gz"` });
      return res.end(appDataArchive(appId));
    }
    if (p === '/api/files/shot.png' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(screenshotPng());
    }
    const ips = /^\/api\/files\/crash\/([^/]+)\/([^/]+\.ips)$/.exec(p);
    if (ips && req.method === 'GET') {
      if (decodeURIComponent(ips[1]) !== IPHONE_UDID || decodeURIComponent(ips[2]) !== IPS_NAME) return json(res, 404, { error: 'Unknown file', code: 'file.unknown' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${IPS_NAME}"` });
      return res.end(ipsFile());
    }
    if (p === '/api/har' && req.method === 'POST') {
      // { ids?, mask? }: masked unless mask is false; a masked HAR says so in log._durbun.masked.
      const { ids, mask } = JSON.parse((await readBody(req)).toString() || '{}');
      if (mask !== undefined && mask !== null && typeof mask !== 'boolean') return json(res, 400, { error: 'mask must be true or false', code: 'har.invalid' });
      const masked = mask !== false;
      const picked = [...network.values()].filter((d) => !Array.isArray(ids) || ids.includes(d.id));
      const log = { version: '1.2', creator: { name: 'Dürbün', version: '0.3.2' }, entries: harOf(masked ? picked.map(maskDetail) : picked) };
      if (masked) log._durbun = { masked: true };
      return json(res, 200, { log }, { 'Content-Disposition': 'attachment; filename="durbun.har"' });
    }
    if (p === '/api/bug-report' && req.method === 'POST') {
      // A stored (uncompressed) zip of the report and its lines; the mock keeps no files, so the screenshot and the
      // crash report are named as skipped. The real archive is checked against the real server (serverContract).
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (typeof body.report !== 'string' || !body.report.trim()) return json(res, 400, { error: 'report must be a non-empty string', code: 'bugReport.invalid' });
      const files = [['report.md', body.report], ...(body.logs ? [['logs.txt', body.logs]] : [])];
      const skipped = [...(body.screenshot ? ['screenshot'] : []), ...(body.crashReport ? ['crashReport'] : [])];
      const zip = storedZip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${body.name || 'durbun-bug'}.zip"`,
        ...(skipped.length ? { 'X-Durbun-Skipped': skipped.join(',') } : {}),
      });
      return res.end(zip);
    }
    if (p === '/api/slack') {
      if (req.method === 'PUT') {
        const patch = JSON.parse((await readBody(req)).toString() || '{}');
        if ('webhookUrl' in patch) {
          if (patch.webhookUrl && !String(patch.webhookUrl).startsWith('https://')) {
            return json(res, 400, { error: 'The webhook URL must start with https://', code: 'slack.invalidUrl' });
          }
          // As the server: a connection URL from Add to Slack carries Dürbün's key after # (screenshots can go).
          const [hook, key = ''] = String(patch.webhookUrl ?? '').split('#');
          const params = new URLSearchParams(key);
          slack.hint = hook ? `hooks.slack.com · …${hook.replace(/\/+$/, '').slice(-4)}` : undefined;
          slack.uploads = !!(hook && params.get('token') && params.get('channel'));
          slack.channel = slack.uploads ? params.get('channel_name') || undefined : undefined;
        }
        if ('sender' in patch) slack.sender = patch.sender || undefined;
      }
      return json(res, 200, {
        configured: !!slack.hint,
        hint: slack.hint,
        sender: slack.sender,
        ...(slack.hint && slack.uploads ? { uploads: true } : {}),
        ...(slack.hint && slack.channel ? { channel: slack.channel } : {}),
      });
    }
    if (p === '/api/slack/send' && req.method === 'POST') {
      const { text = '', markdown = '', screenshot } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!slack.hint) return json(res, 409, { error: 'Slack is not connected', code: 'slack.notConfigured' });
      const body = String(markdown || text);
      console.log(`[slack] ${body.length} chars${screenshot ? ` + ${screenshot}` : ''}:\n${body}\n`);
      const shot = !screenshot
        ? {}
        : slack.uploads
          ? { screenshot: 'sent' }
          : { screenshot: 'failed', screenshotError: { code: 'slack.uploadsOff', message: 'This Slack connection sends text only' } };
      return setTimeout(() => json(res, 200, { ok: true, ...shot }), 400);
    }
    if (await handleFlowsApi(req, res, p, { json, readBody, broadcast })) return;
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
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function syncClient(ws) {
  send(ws, { type: 'hello', server: server(), settings });
  send(ws, snapshot());
  if (logs.length === 0) send(ws, { type: 'history', logs: [], done: true });
  for (let i = 0; i < logs.length; i += 5000) send(ws, { type: 'history', logs: logs.slice(i, i + 5000), done: i + 5000 >= logs.length });
}

/** Commands a window showing a recording may send (the server: the rest is refused with recorder.notLive). */
const VIEW_COMMANDS = new Set(['mocks.set', 'settings.update', 'doctor.run', 'demo.set']);

function syncView(ws, id, v) {
  send(ws, { type: 'hello', server: server(), settings, recording: v.opened.recording });
  send(ws, viewSnapshot(v));
  if (!v.logs.length) send(ws, { type: 'history', logs: [], done: true });
  for (let i = 0; i < v.logs.length; i += 5000) send(ws, { type: 'history', logs: v.logs.slice(i, i + 5000), done: i + 5000 >= v.logs.length });
}

/** A deleted recording: its windows reconnect (and land on the live data). */
function dropView(id) {
  frozen.delete(id);
  for (const [ws, vid] of viewClients) if (vid === id) ws.close(4004, 'This recording was deleted');
}

wss.on('connection', (ws, req) => {
  const viewId = new URL(req?.url ?? '/', 'http://x').searchParams.get('view');
  const v = viewId ? viewData(viewId) : undefined;
  if (v) {
    viewClients.set(ws, viewId);
    syncView(ws, viewId, v);
  } else {
    clients.add(ws);
    syncClient(ws);
  }
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.type !== 'command') return;
      if (v && !VIEW_COMMANDS.has(msg.command?.name)) {
        send(ws, { type: 'reply', requestId: msg.requestId, ok: false, error: 'This is a recording, not live data', code: 'recorder.notLive' });
        return;
      }
      handleCommand(ws, msg);
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    viewClients.delete(ws);
  });
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
  for (const ws of viewClients.keys()) ws.terminate();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
