/**
 * "Pati" — a Flutter pet-adoption app with the Dürbün SDK, simulated on the Android and the iOS demo
 * device: REST + GraphQL + images, auth, pagination, uploads, failures, Flutter error boxes, Dart
 * exceptions, a native iOS crash now and then, reconnects, metrics and flutter.* commands.
 */
import type { AppActionDescriptor, Header } from '@durbun/protocol';
import type { DeviceLogInput } from '../types';
import { type AppDeps, type AppIdentity, type CommandOutcome, DemoApp, type StopReason } from './appSim';
import {
  DART_NULL_CHECK_STACK,
  DART_PAYMENT_STACK,
  DART_SOCKET_STACK,
  FEATURE_FLAGS_TEXT,
  FLUTTER_IMAGE_ERROR,
  FLUTTER_OVERFLOW_ERROR,
  FLUTTER_SETSTATE_ERROR,
  ME,
  PEOPLE,
  PETS,
  PRODUCTS,
  RENDER_TREE_DUMP,
  SEARCH_TERMS,
  STORY_CAPTIONS,
  TOTAL_PETS,
  WIDGET_TREE_DUMP,
  type DemoPet,
} from './content';
import { ANDROID_SYSTEM, IOS_SYSTEM } from './devices';
import { type FailureKind, type HttpOutcome, type HttpPlan, json, type SimBody } from './http';
import { androidLine, iosLine } from './noise';
import { petThumbnailPng } from './png';
import { round, Walk } from './rng';

const API = 'https://api.pati.app/v1';
const CDN = 'https://cdn.pati.app';
const GQL = 'https://gql.pati.app/graphql';
const VERSION = '2.4.1';
const BUILD = '241';

type Toggle = 'debugPaint' | 'repaintRainbow' | 'slowAnimations' | 'performanceOverlay' | 'invertOversizedImages';
const TOGGLE_LABELS: Record<Toggle, [string, string]> = {
  debugPaint: ['Debug paint', 'debugPaintSizeEnabled'],
  repaintRainbow: ['Repaint rainbow', 'debugRepaintRainbowEnabled'],
  slowAnimations: ['Slow animations', 'timeDilation'],
  performanceOverlay: ['Performance overlay', 'showPerformanceOverlay'],
  invertOversizedImages: ['Invert oversized images', 'debugInvertOversizedImages'],
};

const thumbCache = new Map<number, string>();
function thumbBase64(id: number): string {
  let b64 = thumbCache.get(id);
  if (!b64) {
    b64 = petThumbnailPng(id).toString('base64');
    thumbCache.set(id, b64);
  }
  return b64;
}

function jwt(rng: DemoApp['rng'], userId: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: String(userId), name: ME.name, scope: 'user', iat, exp: iat + 3600 })).toString('base64url');
  return `${header}.${payload}.${rng.base64url(32)}`;
}

const SPECIES_TR: Record<DemoPet['species'], string> = { dog: 'köpek', cat: 'kedi', bird: 'kuş', rabbit: 'tavşan' };

export class PatiApp extends DemoApp {
  private toggles: Record<Toggle, boolean> = {
    debugPaint: false,
    repaintRainbow: false,
    slowAnimations: false,
    performanceOverlay: false,
    invertOversizedImages: false,
  };
  private brightness = 'system';
  private targetPlatform = 'default';
  private loggedIn = true;
  private token = '';
  private screen = 'Splash';
  private page = 1;
  private cart: { id: number; sku: string; name: string; qty: number; price: number }[] = [];
  private favorites = new Set<number>([43, 52]);
  private overflowShown = false;
  private errorBoxes = 0;
  private images = 24;
  private imageMB = 6.5;
  private frame = 18_000;
  private textScale = 1;
  private readonly containerUuid: string;
  private readonly cpu: Walk;
  private readonly memory: Walk;
  private heap = 38;
  private jankBoost = 0;
  private cpuBoost = 0;

  /** `variant`: another device than the default demo phones (e.g. the USB iPhone). */
  constructor(deps: AppDeps, variant: { device?: AppIdentity['device']; firstPid?: number } = {}) {
    const ios = deps.platform === 'ios';
    super(
      deps,
      {
        name: 'Pati',
        bundleId: 'com.mykynk.pati',
        version: VERSION,
        build: BUILD,
        processName: ios ? 'Runner' : 'com.mykynk.pati',
        // The plugin's native core is attached (native logs / crashes, OkHttp / URLSession): SPEC §10.6.
        sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter', layers: ['dart', ios ? 'ios' : 'android'] },
        source: 'dart:io',
        capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'],
        device:
          variant.device ??
          (ios
            ? { model: 'iPhone17,1', name: 'iPhone 16 Pro', osVersion: '18.2', manufacturer: 'Apple' }
            : { model: 'Pixel 8', name: 'Pixel 8', osVersion: '15', apiLevel: 35, manufacturer: 'Google' }),
      },
      variant.firstPid ?? (ios ? 48_213 : 8421),
    );
    this.containerUuid = deps.rng.uuid(true);
    // The iPhone build is a fresh install: it shows the login flow; the Android one has a saved session.
    this.loggedIn = !ios;
    this.cpu = new Walk(12, ios ? 11 : 14, 0.18, 2.2, 2, 160);
    this.memory = new Walk(ios ? 158 : 204, ios ? 166 : 214, 0.04, 1.4, 120, 420);
  }

  private get ios(): boolean {
    return this.deps.platform === 'ios';
  }

  private get refreshHz(): number {
    return this.ios ? 120 : 60;
  }

  /* ───────────── SDK descriptors & commands ───────────── */

  actions(): AppActionDescriptor[] {
    const toggle = (key: Toggle): AppActionDescriptor => ({
      id: `flutter.${key}`,
      kind: 'toggle',
      label: TOGGLE_LABELS[key][0],
      labelKey: `flutter.${key}`,
      group: 'flutter',
      value: this.toggles[key],
    });
    return [
      toggle('debugPaint'),
      toggle('repaintRainbow'),
      toggle('slowAnimations'),
      toggle('performanceOverlay'),
      toggle('invertOversizedImages'),
      {
        id: 'flutter.brightness',
        kind: 'select',
        label: 'Brightness',
        labelKey: 'flutter.brightness',
        group: 'flutter',
        options: [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
        value: this.brightness,
      },
      {
        id: 'flutter.platform',
        kind: 'select',
        label: 'Target platform',
        labelKey: 'flutter.platform',
        group: 'flutter',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'android', label: 'Android' },
          { value: 'iOS', label: 'iOS' },
          { value: 'macOS', label: 'macOS' },
        ],
        value: this.targetPlatform,
      },
      { id: 'flutter.dumpWidgetTree', kind: 'button', label: 'Dump widget tree', labelKey: 'flutter.dumpWidgetTree', group: 'flutter' },
      { id: 'flutter.dumpRenderTree', kind: 'button', label: 'Dump render tree', labelKey: 'flutter.dumpRenderTree', group: 'flutter' },
    ];
  }

  protected onCommand(name: string, params: Record<string, unknown>): CommandOutcome {
    const key = name.startsWith('flutter.') ? name.slice('flutter.'.length) : '';
    if (key in this.toggles) {
      const t = key as Toggle;
      const value = typeof params.value === 'boolean' ? params.value : !this.toggles[t];
      this.toggles[t] = value;
      const [label, flag] = TOGGLE_LABELS[t];
      const shown = t === 'slowAnimations' ? `${flag} = ${value ? '5.0' : '1.0'}` : `${flag} = ${value}`;
      this.log('info', 'flutter.tools', `${label} ${value ? 'açıldı' : 'kapatıldı'} (${shown})`, { data: { [flag]: t === 'slowAnimations' ? (value ? 5 : 1) : value } });
      this.publishActions();
      this.jankBoost += 3;
      return { ok: true, data: { value } };
    }
    switch (name) {
      case 'flutter.brightness':
      case 'flutter.platform': {
        const allowed = name === 'flutter.brightness' ? ['system', 'light', 'dark'] : ['default', 'android', 'iOS', 'macOS'];
        const value = params.value;
        if (typeof value !== 'string' || !allowed.includes(value)) return { ok: false, error: `Invalid value; expected one of ${allowed.join(', ')}` };
        if (name === 'flutter.brightness') this.brightness = value;
        else this.targetPlatform = value;
        this.log('info', 'flutter.tools', name === 'flutter.brightness' ? `Platform brightness override → ${value}` : `debugDefaultTargetPlatformOverride → ${value}`);
        this.publishActions();
        this.jankBoost += 5;
        return { ok: true, data: { value } };
      }
      case 'flutter.dumpWidgetTree':
      case 'flutter.dumpRenderTree': {
        const dump = name === 'flutter.dumpWidgetTree' ? WIDGET_TREE_DUMP : RENDER_TREE_DUMP;
        this.stdout(dump);
        if (!this.deviceLogsAvailable) this.log('debug', 'flutter', dump);
        return { ok: true, data: { lines: dump.split('\n').length } };
      }
      default:
        return { ok: false, error: `Unknown command: ${name}` };
    }
  }

  protected metric(): Record<string, number> {
    const hz = this.refreshHz;
    const cpu = this.cpu.step(this.rng) + this.cpuBoost;
    this.cpuBoost *= 0.45;
    const memory = this.memory.step(this.rng);
    this.memory.mean = Math.min(this.memory.mean + 0.05, this.ios ? 230 : 290);
    this.heap += this.rng.float(0.2, 1.4);
    if (this.heap > 92 || this.rng.chance(0.03)) {
      const before = this.heap;
      this.heap = this.rng.float(34, 46);
      this.log('verbose', 'gc', `GC: heap ${round(before)} MB → ${round(this.heap)} MB (${this.rng.int(3, 11)} ms)`);
    }
    const jank = Math.round(this.jankBoost + (this.rng.chance(0.25) ? this.rng.int(1, 2) : 0));
    this.jankBoost *= 0.35;
    const budget = 1000 / hz;
    const slow = this.toggles.slowAnimations ? 1.15 : 1;
    const overlay = this.toggles.performanceOverlay ? 1.6 : 0;
    const fps = Math.max(18, hz - jank * this.rng.float(0.7, 1.6) - this.rng.float(0, hz === 120 ? 2.5 : 0.8));
    return {
      cpu: round(Math.max(0.5, cpu)),
      memoryMB: round(memory),
      heapMB: round(this.heap),
      fps: round(fps),
      jankyFrames: jank,
      frameBuildMs: round((budget * this.rng.float(0.18, 0.42) + jank * 0.9) * slow),
      frameRasterMs: round((budget * this.rng.float(0.25, 0.55) + jank * 1.4 + overlay) * slow),
      threads: this.rng.int(this.ios ? 24 : 31, this.ios ? 29 : 37),
    };
  }

  /* ───────────── HTTP plumbing ───────────── */

  protected baseHeaders(url: URL): Header[] {
    const headers: Header[] = [
      ['user-agent', 'Dart/3.10 (dart:io)'],
      ['accept-encoding', 'gzip'],
    ];
    if (url.hostname === 'cdn.pati.app') {
      headers.push(['accept', '*/*']);
      return headers;
    }
    if (url.hostname.endsWith('pati.app')) {
      headers.push(
        ['accept', 'application/json'],
        ['accept-language', 'tr-TR,tr;q=0.9,en;q=0.8'],
        ['x-app-version', `${VERSION}+${BUILD}`],
        ['x-platform', this.ios ? 'ios' : 'android'],
      );
      if (this.loggedIn && this.token) headers.push(['authorization', `Bearer ${this.token}`]);
    }
    return headers;
  }

  protected errorText(kind: FailureKind, host: string, url: string): string {
    switch (kind) {
      case 'timeout':
        return 'TimeoutException after 0:00:15.000000: Future not completed';
      case 'connection': {
        let port = '443';
        try {
          port = new URL(url).port || (url.startsWith('http:') ? '80' : '443');
        } catch {
          // keep default
        }
        return `SocketException: Connection refused (OS Error: Connection refused, errno = ${this.ios ? 61 : 111}), address = ${host}, port = ${this.rng.int(49152, 65000)} (remote ${port})`;
      }
      case 'dns':
        return this.ios
          ? `SocketException: Failed host lookup: '${host}' (OS Error: nodename nor servname provided, or not known, errno = 8)`
          : `SocketException: Failed host lookup: '${host}' (OS Error: No address associated with hostname, errno = 7)`;
      case 'tls':
        return 'HandshakeException: Handshake error in client (OS Error: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:393))';
      case 'reset':
        return `HttpException: Connection closed before full header was received, uri = ${url}`;
    }
  }

  protected override onRequestFinish(o: HttpOutcome): void {
    if (!this.ios || !this.pid) return;
    // CFNetwork summary lines, like a real simulator shows for every URLSession / dart:io socket.
    const task = `${this.rng.uuid(true)}>.<${this.rng.int(1, 40)}`;
    if (o.error) {
      if (o.cancelled) return;
      const code = /timed out|Timeout/i.test(o.error) ? -1001 : /lookup/i.test(o.error) ? -1003 : -1004;
      this.deviceLog([
        {
          level: 'error',
          tag: 'com.apple.CFNetwork',
          subsystem: 'com.apple.CFNetwork',
          category: 'Default',
          message: `Task <${task}> finished with error [${code}] Error Domain=NSURLErrorDomain Code=${code} "${code === -1001 ? 'The request timed out.' : code === -1003 ? 'A server with the specified hostname could not be found.' : 'Could not connect to the server.'}" UserInfo={_kCFStreamErrorCodeKey=-2102, NSErrorFailingURLStringKey=${o.url}, _kCFStreamErrorDomainKey=4}`,
        },
      ]);
      return;
    }
    if (this.rng.chance(0.55)) {
      this.deviceLog([
        {
          level: 'info',
          tag: 'com.apple.CFNetwork',
          subsystem: 'com.apple.CFNetwork',
          category: 'Summary',
          message: `Task <${task}> summary for task success {transaction_duration_ms=${Math.round(o.durationMs)}, response_status=${o.status}, connection=${this.rng.int(3, 18)}, reused=${this.rng.int(0, 1)}, request_start_ms=0, request_duration_ms=0, response_start_ms=${Math.max(1, Math.round(o.durationMs * 0.85))}, response_duration_ms=${Math.max(1, Math.round(o.durationMs * 0.15))}, request_bytes=${o.requestBytes + 412}, response_bytes=${o.responseBytes}, cache_hit=false}`,
        },
      ]);
    }
  }

  private req(plan: Omit<HttpPlan, 'latencyMs'> & { latency?: [number, number] }): void {
    const [min, max] = plan.latency ?? [60, 320];
    this.http.request({ ...plan, latencyMs: this.rng.int(min, max) });
  }

  private api(method: string, path: string, status: number, body: SimBody | undefined, opts: Partial<HttpPlan> & { latency?: [number, number]; request?: SimBody } = {}): void {
    this.req({
      method,
      url: `${API}${path}`,
      body: opts.request,
      response: { status, body, headers: opts.response?.headers },
      latency: opts.latency,
      failure: opts.failure,
      cancelAfterMs: opts.cancelAfterMs,
      then: opts.then,
    });
  }

  private loadImages(ids: number[]): void {
    ids.forEach((id, i) => {
      this.after(i * this.rng.int(10, 45), () =>
        this.req({
          method: 'GET',
          url: `${CDN}/img/pets/${id}/thumb.png`,
          response: { status: 200, body: { contentType: 'image/png', base64: thumbBase64(id) }, headers: [['etag', `"${this.rng.hex(16)}"`]] },
          latency: [25, 190],
        }),
      );
    });
    this.images = Math.min(1000, this.images + ids.length);
    this.imageMB = Math.min(96, this.imageMB + ids.length * this.rng.float(0.15, 0.6));
    if (this.imageMB > 90) {
      this.imageMB *= 0.6;
      this.images = Math.round(this.images * 0.6);
    }
    this.log('debug', 'image_cache', `ImageCache: ${ids.length} görsel isteniyor (önbellekte ${this.images}/1000)`);
  }

  /* ───────────── lifecycle device lines ───────────── */

  protected onProcessStart(reason: string): void {
    const pid = this.pid as number;
    if (this.ios) {
      const rb = IOS_SYSTEM.runningboardd.pid;
      const app = `app<com.mykynk.pati(${this.containerUuid})>`;
      this.systemLog([
        iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', 'process', `[${app}:${pid}] is not RunningBoard jetsam managed.`),
        iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', 'assertion', `Acquiring assertion targeting [${app}:${pid}] from originator [osservice<com.apple.SpringBoard>:${IOS_SYSTEM.springboard.pid}] with description <RBSAssertionDescriptor| "FBApplicationProcess" ID:${rb}-${IOS_SYSTEM.springboard.pid}-${this.rng.int(1000, 9999)} target:${pid} attributes:[<RBSDomainAttribute| domain:"com.apple.frontboard" name:"Bootstrap" sourceEnvironment:"(null)">]>`),
        iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[${app}:${pid}] Bootstrap success!`),
      ]);
      this.after(120, () =>
        this.deviceLog([
          { level: 'info', tag: 'flutter', message: '[IMPORTANT:flutter/shell/platform/darwin/ios/ios_context_metal_impeller.mm(42)] Using the Impeller rendering backend (Metal).' },
          { level: 'debug', tag: 'com.apple.UIKit', subsystem: 'com.apple.UIKit', category: 'KeyWindow', message: 'Window did become key: <UIWindow: 0x10380f520; frame = (0 0; 402 874); autoresize = W+H; gestureRecognizers = <NSArray: 0x600000c8d2f0>; layer = <UIWindowLayer: 0x600002e1c3c0>>' },
        ]),
      );
      this.after(380, () =>
        this.systemLog([iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Scene', '[sceneID:com.mykynk.pati-default] Scene lifecycle state did change: Foreground')]),
      );
      return;
    }
    const ss = ANDROID_SYSTEM.systemServer.pid;
    this.systemLog([
      androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', `START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000 cmp=com.mykynk.pati/.MainActivity bnds=[561,1408][814,1730]} with LAUNCH_MULTIPLE from uid 10162 (BAL_ALLOW_VISIBLE_WINDOW) result code=0`),
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Start proc ${pid}:com.mykynk.pati/u0a234 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}`),
    ]);
    this.after(40, () =>
      this.deviceLog([
        { level: 'info', tag: 'nativeloader', message: `Configuring clns-7 for other apk /data/app/~~Xk1q2W3e4R5t6Y7u8I9o0P==/com.mykynk.pati-${this.rng.hex(6)}==/base.apk. target_sdk_version=35, uses_libraries=, library_path=/data/app/~~Xk1q2W3e4R5t6Y7u8I9o0P==/com.mykynk.pati/lib/arm64, permitted_path=/data:/mnt/expand:/data/user/0/com.mykynk.pati` },
        { level: 'debug', tag: 'HostConnection', message: `HostConnection::get() New Host Connection established 0xb400007a1c2f${this.rng.hex(4)}, tid ${pid}` },
        { level: 'warn', tag: 'Gralloc4', message: 'mapper 4.x is not supported' },
        { level: 'debug', tag: 'FlutterJNI', message: 'Beginning load of flutter...' },
        { level: 'debug', tag: 'FlutterJNI', message: 'flutter (null) was loaded normally!' },
        { level: 'info', tag: 'flutter', message: '[IMPORTANT:flutter/shell/platform/android/android_context_vk_impeller.cc(62)] Using the Impeller rendering backend (Vulkan).' },
        { level: 'info', tag: 'FirebaseApp', message: 'Device unlocked: initializing all Firebase APIs for app [DEFAULT]' },
        { level: 'info', tag: 'FirebaseInitProvider', message: 'FirebaseApp initialization successful' },
        { level: 'debug', tag: 'FlutterGeolocator', message: 'Attaching Geolocator to activity' },
        { level: 'debug', tag: 'NetworkSecurityConfig', message: 'No Network Security Config specified, using platform default' },
      ]),
    );
    this.after(420, () => {
      this.deviceLog([{ level: 'info', tag: 'Choreographer', message: `Skipped ${this.rng.int(28, 64)} frames!  The application may be doing too much work on its main thread.` }]);
      this.systemLog([
        androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', `Displayed com.mykynk.pati/.MainActivity for user 0: +${this.rng.int(610, 980)}ms`),
        androidLine(ss, ss + 33, 'info', 'WindowManager', `Changing focus from Window{${this.rng.hex(7)} u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity} to Window{${this.rng.hex(7)} u0 com.mykynk.pati/com.mykynk.pati.MainActivity} displayId=0 Callers=com.android.server.wm.RootWindowContainer.updateFocusedWindowLocked:463 com.android.server.wm.WindowManagerService.updateFocusedWindowLocked:6380`),
      ]);
    });
    if (reason !== 'restart') this.after(6000, () => this.deviceLog([{ level: 'debug', tag: 'ProfileInstaller', message: 'Installing profile for com.mykynk.pati' }]));
  }

  protected onProcessEnd(reason: StopReason): void {
    const pid = this.pid as number;
    if (this.ios) {
      const rb = IOS_SYSTEM.runningboardd.pid;
      const app = `app<com.mykynk.pati(${this.containerUuid})>:${pid}`;
      const exit =
        reason === 'crash'
          ? '<RBSProcessExitContext| specific, status:<RBSProcessExitStatus| domain:signal(2) code:SIGABRT(6)>>'
          : '<RBSProcessExitContext| voluntary>';
      this.systemLog([
        iosLine(rb, 'runningboardd', reason === 'crash' ? 'error' : 'info', 'com.apple.runningboard', 'process', `[${app}] termination reported by launchd (${reason === 'crash' ? '2, 6, 6' : '15, 0, 0'})`),
        iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[${app}] Process exited: ${exit}.`),
        iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', 'process', `[${app}] Now flagged as pending exit for reason: workspace client connection invalidated`),
      ]);
      return;
    }
    const ss = ANDROID_SYSTEM.systemServer.pid;
    const win = this.rng.hex(7);
    const lines: DeviceLogInput[] = [];
    if (reason === 'clear-data') lines.push(androidLine(ss, ss + 5, 'info', 'ActivityManager', 'Force stopping com.mykynk.pati appid=10234 user=0: clear data'));
    else if (reason === 'uninstall') lines.push(androidLine(ss, ss + 5, 'info', 'PackageManager', 'Removing package com.mykynk.pati'));
    else lines.push(androidLine(ss, ss + 5, 'info', 'ActivityManager', `Force stopping com.mykynk.pati appid=10234 user=0: from pid ${this.rng.int(9000, 9900)}`));
    lines.push(
      androidLine(ss, ss + 5, 'info', 'ActivityManager', `Killing ${pid}:com.mykynk.pati/u0a234 (adj 0): stop com.mykynk.pati due to from pid ${this.rng.int(9000, 9900)}`),
      androidLine(ss, ss + 33, 'info', 'WindowManager', `WIN DEATH: Window{${win} u0 com.mykynk.pati/com.mykynk.pati.MainActivity}`),
      androidLine(ss, ss + 40, 'warn', 'InputDispatcher', `channel '${win} com.mykynk.pati/com.mykynk.pati.MainActivity' ~ Channel is unrecoverably broken and will be disposed!`),
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Process com.mykynk.pati (pid ${pid}) has died: fg  TOP`),
    );
    this.systemLog(lines);
  }

  /* ───────────── behaviour ───────────── */

  protected onRunning(firstLaunch: boolean): void {
    this.screen = 'Splash';
    this.page = 1;
    this.startup();
    this.every(430, () => this.backgroundLog());
    this.every(1500, () => this.printLine());
    if (!this.ios) this.periodically(980, 1020, () => this.appTimeStats());
    if (firstLaunch) this.openingScript();
    this.periodically(6500, 13_000, () => this.scenario(), firstLaunch ? 20_000 : 3500);
    this.periodically(16_000, 34_000, () => this.slowFrames());
    this.periodically(75_000, 140_000, () => this.flutterErrorBox(), firstLaunch ? (this.ios ? 21_000 : 12_000) : undefined);
    this.periodically(170_000, 300_000, () => this.dartException(), firstLaunch ? (this.ios ? 48_000 : 66_000) : undefined);
    if (this.ios) {
      this.periodically(230_000, 330_000, () => this.transportBlip(), firstLaunch ? 92_000 : undefined);
      this.periodically(380_000, 560_000, () => this.nativeCrash(), firstLaunch ? 150_000 : undefined);
    }
  }

  /** The first minute of the demo shows every kind of situation early, then randomness takes over. */
  private openingScript(): void {
    const steps: [number, () => void][] = this.ios
      ? [
          // after the fresh-install login (~2–4 s)
          [6000, () => this.feed('slow')],
          [9500, () => this.tokenExpiry()],
          [12_000, () => this.likeStory(true)],
          [14_500, () => this.upload()],
          [18_000, () => this.offline()],
        ]
      : [
          [4000, () => this.search(false, true)],
          [6500, () => this.petDetail(true)],
          [9000, () => this.shop()],
          [14_000, () => this.checkout(true)],
          [17_000, () => this.feed('slow')],
          [24_000, () => this.feed('503')],
        ];
    for (const [at, step] of steps) this.after(at, () => this.running && step());
  }

  private navigate(screen: string, route: string, params: Record<string, unknown> = {}): void {
    const from = this.screen;
    this.screen = screen;
    this.log('debug', 'router', `GoRouter: ${from} → ${route}`, { data: { from, to: route, ...params } });
    this.event('screen_view', { screen_name: screen, screen_class: `${screen}Page`, ...params });
    this.cpuBoost += this.rng.float(8, 26);
    this.jankBoost += this.rng.float(0.5, 3);
  }

  private startup(): void {
    this.log('info', 'main', `Pati ${VERSION} (${BUILD}) başlatılıyor — flavor: dev`, {
      data: { flavor: 'dev', buildMode: 'debug', dart: '3.10.0', flutter: '3.38.1', platform: this.ios ? 'ios' : 'android', locale: 'tr_TR' },
    });
    this.after(25, () => this.log('debug', 'di', 'GetIt: 37 bağımlılık kaydedildi (12 ms)'));
    this.after(60, () => {
      this.log('info', 'firebase', 'Firebase.initializeApp tamamlandı (pati-prod)');
      this.req({
        method: 'POST',
        url: 'https://firebaseinstallations.googleapis.com/v1/projects/pati-prod/installations',
        body: json({ fid: `f${this.rng.base64url(16)}`, appId: '1:493812736401:android:9c1f2e3d4b5a6978', authVersion: 'FIS_v2', sdkVersion: 'a:18.0.0' }),
        response: {
          status: 200,
          body: json({
            name: `projects/493812736401/installations/f${this.rng.base64url(16)}`,
            refreshToken: `3_AS3qfwK${this.rng.base64url(40)}`,
            authToken: { token: `eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.${this.rng.base64url(60)}.${this.rng.base64url(40)}`, expiresIn: '604800s' },
          }),
        },
        latency: [90, 260],
      });
    });
    this.after(90, () =>
      this.api('GET', '/config/remote', this.rng.chance(0.6) ? 304 : 200, undefined, {
        latency: [40, 140],
        then: (o) => {
          this.log('info', 'remote_config', FEATURE_FLAGS_TEXT, {
            data: { version: 87, cached: o.status === 304, flags: { newCheckout: true, petStories: true, adoptionWizardV2: false, maxUploadMB: 10 } },
          });
        },
      }),
    );
    this.after(160, () => {
      if (this.loggedIn) this.refreshToken(() => this.loadProfile(() => this.home()));
      else this.loginFlow();
    });
  }

  private refreshToken(next: () => void): void {
    this.log('info', 'auth', 'Kayıtlı oturum bulundu, token yenileniyor');
    const tokens = json({ accessToken: jwt(this.rng, ME.id), refreshToken: `rt_${this.rng.base64url(24)}`, tokenType: 'Bearer', expiresIn: 3600 });
    this.api('POST', '/auth/refresh', 200, tokens, {
      request: json({ refreshToken: `rt_${this.rng.base64url(24)}`, deviceId: this.rng.uuid() }),
      latency: [80, 260],
      then: (o) => {
        if (o.status && o.status < 300) {
          this.token = jwt(this.rng, ME.id);
          this.log('info', 'auth', `Token yenilendi (${o.durationMs} ms), 3600 sn geçerli`, { data: { userId: ME.id, expiresIn: 3600 } });
        } else {
          this.log('warn', 'auth', `Token yenilenemedi: ${o.error ?? `HTTP ${o.status}`}`);
        }
        next();
      },
    });
    this.token = jwt(this.rng, ME.id);
  }

  private loadProfile(next: () => void): void {
    this.api(
      'GET',
      '/me',
      200,
      json({
        id: ME.id,
        name: ME.name,
        email: ME.email,
        city: ME.city,
        avatarUrl: `${CDN}/img/users/${ME.id}/avatar.png`,
        pets: 2,
        favorites: this.favorites.size,
        notifications: { push: true, email: false, sms: false },
        locale: 'tr-TR',
        createdAt: '2024-05-12T09:31:44Z',
      }),
      { latency: [60, 200], then: () => next() },
    );
  }

  private loginFlow(): void {
    this.navigate('Login', '/login');
    this.stdout('🔐 Oturum yok → /login');
    this.after(this.rng.int(1800, 3200), () => {
      this.log('info', 'auth', 'Giriş deneniyor', { data: { method: 'email', email: ME.email } });
      this.api(
        'POST',
        '/auth/login',
        200,
        json({
          accessToken: jwt(this.rng, ME.id),
          refreshToken: `rt_${this.rng.base64url(24)}`,
          tokenType: 'Bearer',
          expiresIn: 3600,
          user: { id: ME.id, name: ME.name, email: ME.email, city: ME.city, memberSince: '2024-05-12' },
        }),
        {
          request: json({ email: ME.email, password: '********', device: { platform: this.ios ? 'ios' : 'android', model: this.identity.device.model } }),
          latency: [180, 520],
          then: (o) => {
            this.loggedIn = true;
            this.token = jwt(this.rng, ME.id);
            this.log('info', 'auth', 'Kullanıcı giriş yaptı', { data: { userId: ME.id, method: 'email', elapsedMs: o.durationMs } });
            this.event('login', { method: 'email' });
            this.home();
          },
        },
      );
    });
  }

  private petPage(page: number, limit = 20): { pets: DemoPet[]; body: SimBody } {
    const pets = Array.from({ length: limit }, (_, i) => PETS[(page * limit + i) % PETS.length] as DemoPet);
    const totalPages = Math.ceil(TOTAL_PETS / limit);
    return {
      pets,
      body: json({
        data: pets.map((p, i) => ({
          id: p.id + page * 100 + i,
          name: p.name,
          species: p.species,
          breed: p.breed,
          sex: p.sex,
          ageMonths: p.ageMonths,
          location: { city: p.city, district: p.district },
          thumbUrl: `${CDN}/img/pets/${p.id}/thumb.png`,
          adoption: { status: 'available', fee: 0 },
          vaccinated: p.id % 3 !== 0,
          favorite: this.favorites.has(p.id),
        })),
        meta: { page, limit, total: TOTAL_PETS, totalPages, hasMore: page < totalPages },
        links: { next: page < totalPages ? `/v1/pets?page=${page + 1}&limit=${limit}` : null },
      }),
    };
  }

  private home(): void {
    this.navigate('Home', '/');
    const { pets, body } = this.petPage(1);
    this.api('GET', '/pets?page=1&limit=20', 200, body, {
      response: { status: 200, headers: [['x-total-count', String(TOTAL_PETS)]] },
      latency: [90, 340],
      then: (o) => {
        if (o.status !== 200) return;
        this.log('info', 'PetRepository', `20 dost yüklendi (sayfa 1/9, ${o.durationMs} ms)`, { data: { page: 1, pageSize: 20, total: TOTAL_PETS, cacheHit: false } });
        this.stdout(`🐾 PetRepository.fetch(page: 1) → 20 öğe (${o.durationMs} ms)`);
        this.loadImages(pets.slice(0, this.rng.int(4, 6)).map((p) => p.id));
      },
    });
    this.after(120, () => this.stories());
    this.after(200, () =>
      this.api(
        'GET',
        '/notifications?unread=true',
        200,
        json({
          data: [
            { id: 'n_3412', type: 'favorite', title: 'Pamuk favorilere eklendi', createdAt: new Date(Date.now() - 3_600_000).toISOString() },
            { id: 'n_3409', type: 'message', title: 'Ece Kaya: "Karabaş hâlâ sahiplendirilebilir mi?"', createdAt: new Date(Date.now() - 7_200_000).toISOString() },
          ],
          unreadCount: 2,
        }),
        { latency: [60, 180] },
      ),
    );
    this.after(800, () => this.analyticsFlush());
  }

  private stories(): void {
    const query =
      'query GetPetStories($first: Int!, $after: String) {\n  stories(first: $first, after: $after) {\n    edges {\n      cursor\n      node { id caption mediaUrl likeCount viewerHasLiked author { id displayName avatarUrl } createdAt }\n    }\n    pageInfo { endCursor hasNextPage }\n  }\n}';
    const edges = this.rng.sample(STORY_CAPTIONS, 5).map((caption, i) => {
      const pet = PETS[(i * 3 + this.rng.int(0, 5)) % PETS.length] as DemoPet;
      return {
        cursor: Buffer.from(`story:${1200 + i}`).toString('base64'),
        node: {
          id: `s_${1200 + i}`,
          caption,
          mediaUrl: `${CDN}/img/pets/${pet.id}/story.png`,
          likeCount: this.rng.int(3, 240),
          viewerHasLiked: this.rng.chance(0.3),
          author: { id: `u_${7000 + i}`, displayName: this.rng.pick(PEOPLE), avatarUrl: `${CDN}/img/users/${7000 + i}/avatar.png` },
          createdAt: new Date(Date.now() - i * 5_400_000).toISOString(),
        },
      };
    });
    this.req({
      method: 'POST',
      url: GQL,
      body: json({ operationName: 'GetPetStories', query, variables: { first: 5, after: null } }),
      response: { status: 200, body: json({ data: { stories: { edges, pageInfo: { endCursor: edges.at(-1)?.cursor, hasNextPage: true } } } }) },
      latency: [110, 380],
      then: (o) => this.log('debug', 'graphql', `GetPetStories → ${edges.length} hikâye (${o.durationMs} ms)`),
    });
  }

  private analyticsFlush(): void {
    const bytes = Buffer.alloc(this.rng.int(180, 900));
    for (let i = 0; i < bytes.length; i++) bytes[i] = this.rng.int(0, 255);
    this.req({
      method: 'POST',
      url: 'https://app-measurement.com/a',
      body: { contentType: 'application/x-protobuf', base64: bytes.toString('base64') },
      response: { status: 204 },
      latency: [70, 230],
    });
  }

  private scenario(): void {
    if (!this.running) return;
    const pick = this.rng.weighted<() => void>([
      [() => this.browse(), 3],
      [() => this.petDetail(), 3],
      [() => this.favorite(), 1.4],
      [() => this.search(), 1.4],
      [() => this.shop(), 1.8],
      [() => this.checkout(), 1],
      [() => this.profile(), 0.9],
      [() => this.upload(), 0.6],
      [() => this.feed(), 1.8],
      [() => this.likeStory(), 1.2],
      [() => this.tokenExpiry(), 0.5],
      [() => this.offline(), 0.25],
      [() => this.devServer(), 0.3],
      [() => this.geocode(), 0.6],
      [() => this.analyticsFlush(), 0.8],
    ]);
    pick();
  }

  private browse(): void {
    this.page = this.page >= 9 ? 1 : this.page + 1;
    const page = this.page;
    if (this.screen !== 'Home') this.navigate('Home', '/');
    this.log('debug', 'PetGrid', `Liste sonuna yaklaşıldı, sayfa ${page} isteniyor`, { data: { scrollOffset: round(this.rng.float(1800, 9000)), page } });
    const { pets, body } = this.petPage(page);
    this.api('GET', `/pets?page=${page}&limit=20`, 200, body, {
      latency: [90, 420],
      then: (o) => {
        if (o.status !== 200) {
          this.log('warn', 'PetRepository', `Sayfa ${page} yüklenemedi: ${o.error ?? `HTTP ${o.status}`}`);
          return;
        }
        this.log('info', 'PetRepository', `${pets.length} dost yüklendi (sayfa ${page}/9, ${o.durationMs} ms)`, { data: { page, pageSize: 20, total: TOTAL_PETS } });
        this.stdout(`🐾 PetRepository.fetch(page: ${page}) → ${pets.length} öğe`);
        this.loadImages(pets.slice(0, this.rng.int(3, 6)).map((p) => p.id));
      },
    });
  }

  private petDetail(forceMissing = false): void {
    const missing = forceMissing || this.rng.chance(0.08);
    const pet = this.rng.pick(PETS);
    const id = missing ? 9999 : pet.id;
    this.navigate('PetDetail', `/pets/${id}`, { petId: id });
    this.stdout(`[GoRouter] going to /pets/${id}`);
    if (missing) {
      this.api('GET', `/pets/${id}`, 404, json({ error: 'not_found', message: `Pet ${id} bulunamadı`, requestId: this.rng.uuid() }), {
        latency: [50, 160],
        then: () => this.log('warn', 'PetRepository', `Pet ${id} bulunamadı (404) — liste önbelleği eski olabilir`, { data: { petId: id } }),
      });
      return;
    }
    const detail = {
      id: pet.id,
      name: pet.name,
      species: pet.species,
      breed: pet.breed,
      sex: pet.sex,
      ageMonths: pet.ageMonths,
      location: { city: pet.city, district: pet.district, approx: true },
      description: `${pet.name} çok uysal ve oyuncu bir ${SPECIES_TR[pet.species]}. Çocuklarla ve diğer hayvanlarla arası iyi. Aşıları tam, düzenli veteriner kontrolünde.`,
      photos: [1, 2, 3].map((n) => `${CDN}/img/pets/${pet.id}/${n}.png`),
      health: {
        vaccinations: [
          { name: 'Kuduz', date: '2026-03-14' },
          { name: 'Karma', date: '2026-04-02' },
        ],
        microchip: `9002150048${this.rng.int(10000, 99999)}`,
        neutered: pet.id % 2 === 0,
        lastVetVisit: '2026-10-21',
      },
      owner: { id: 7000 + pet.id, displayName: this.rng.pick(PEOPLE), verified: true, responseRate: round(this.rng.float(0.7, 0.99), 2) },
      stats: { views: this.rng.int(120, 4200), favorites: this.rng.int(4, 320) },
      createdAt: '2026-09-30T14:12:09Z',
    };
    this.api('GET', `/pets/${pet.id}`, 200, json(detail), {
      latency: [70, 260],
      then: (o) => {
        if (o.status === 200) this.log('debug', 'PetDetailPage', `build #${this.rng.int(2, 5)} (${pet.name}, ${pet.breed})`);
      },
    });
    this.loadImages([pet.id]);
    this.after(90, () =>
      this.req({
        method: 'POST',
        url: GQL,
        body: json({
          operationName: 'PetDetailExtras',
          query: 'query PetDetailExtras($petId: ID!) {\n  pet(id: $petId) {\n    id\n    similar(first: 4) { id name breed thumbUrl }\n    adoptionSteps { title done }\n  }\n}',
          variables: { petId: String(pet.id) },
        }),
        response: {
          status: 200,
          body: json({
            data: {
              pet: {
                id: String(pet.id),
                similar: this.rng.sample(PETS, 4).map((p) => ({ id: String(p.id), name: p.name, breed: p.breed, thumbUrl: `${CDN}/img/pets/${p.id}/thumb.png` })),
                adoptionSteps: [
                  { title: 'Başvuru formu', done: true },
                  { title: 'Tanışma', done: false },
                  { title: 'Sözleşme', done: false },
                ],
              },
            },
          }),
        },
        latency: [90, 300],
      }),
    );
  }

  private favorite(): void {
    const pet = this.rng.pick(PETS);
    const adding = !this.favorites.has(pet.id);
    if (adding) this.favorites.add(pet.id);
    else this.favorites.delete(pet.id);
    this.api(adding ? 'POST' : 'DELETE', `/pets/${pet.id}/favorite`, adding ? 201 : 204, adding ? json({ petId: pet.id, favoritedAt: new Date().toISOString() }) : undefined, {
      latency: [60, 180],
    });
    this.event(adding ? 'add_to_favorites' : 'remove_from_favorites', { pet_id: pet.id, species: pet.species });
    this.log('info', 'favorites', `${pet.name} ${adding ? 'favorilere eklendi' : 'favorilerden çıkarıldı'} (toplam ${this.favorites.size})`);
  }

  private search(retry = false, force429 = false): void {
    const term = this.rng.pick(SEARCH_TERMS);
    if (!retry) this.navigate('Search', '/search', { query: term });
    const limited = force429 || (!retry && this.rng.chance(0.3));
    const results = this.rng.sample(PETS, this.rng.int(3, 12));
    this.api(
      'GET',
      `/search?q=${encodeURIComponent(term)}&limit=20`,
      limited ? 429 : 200,
      limited ? json({ error: 'rate_limited', message: 'Çok fazla istek, lütfen 2 sn sonra tekrar deneyin', retryAfter: 2 }) : json({ query: term, results: results.map((p) => ({ id: p.id, name: p.name, breed: p.breed })), tookMs: this.rng.int(8, 60) }),
      {
        response: limited ? { status: 429, headers: [['retry-after', '2'], ['x-ratelimit-limit', '30'], ['x-ratelimit-remaining', '0']] } : undefined,
        latency: [40, 190],
        then: (o) => {
          if (o.status === 429) {
            this.log('warn', 'api', 'Retrying request (1/3) after 429 Too Many Requests', { data: { path: '/v1/search', retryAfterSec: 2 } });
            this.after(2000, () => this.search(true));
          } else if (o.status === 200) {
            this.event('search', { search_term: term, results: results.length });
          }
        },
      },
    );
  }

  private shop(): void {
    this.navigate('Shop', '/shop', { category: 'mama' });
    this.api(
      'GET',
      '/products?category=mama&page=1',
      200,
      json({ data: PRODUCTS.map((p) => ({ ...p, currency: 'TRY', stock: this.rng.int(0, 80), imageUrl: `${CDN}/img/products/${p.sku.toLowerCase()}.png` })), meta: { page: 1, total: PRODUCTS.length } }),
      { latency: [80, 280] },
    );
    const product = this.rng.pick(PRODUCTS);
    this.after(this.rng.int(1200, 2600), () => {
      if (!this.running) return;
      const existing = this.cart.find((c) => c.sku === product.sku);
      if (existing && this.rng.chance(0.5)) {
        existing.qty++;
        this.api('PATCH', `/cart/items/${existing.id}`, 200, json({ id: existing.id, sku: existing.sku, qty: existing.qty }), {
          request: json({ qty: existing.qty }),
          latency: [60, 200],
        });
      } else {
        const item = { id: this.rng.int(50_000, 59_999), sku: product.sku, name: product.name, qty: 1, price: product.price };
        this.cart.push(item);
        this.api('POST', '/cart/items', 201, json({ ...item, currency: 'TRY' }), { request: json({ sku: product.sku, qty: 1 }), latency: [70, 240] });
        this.event('add_to_cart', { item_id: product.sku, item_name: product.name, price: product.price, quantity: 1, currency: 'TRY' });
      }
      const total = round(this.cart.reduce((s, c) => s + c.price * c.qty, 0), 2);
      this.log('info', 'cart', `Sepet güncellendi: ${this.cart.length} ürün, ₺${total.toLocaleString('tr-TR')}`, { data: { items: this.cart.length, total, currency: 'TRY' } });
      if (this.cart.length > 3) {
        const removed = this.cart.shift();
        if (removed) this.api('DELETE', `/cart/items/${removed.id}`, 204, undefined, { latency: [50, 150] });
      }
    });
  }

  private checkout(forceInvalid = false): void {
    if (this.cart.length === 0 && !forceInvalid) {
      this.shop();
      return;
    }
    if (this.cart.length === 0) this.cart.push({ id: 50_412, sku: PRODUCTS[0]!.sku, name: PRODUCTS[0]!.name, qty: 1, price: PRODUCTS[0]!.price });
    this.navigate('Checkout', '/checkout');
    const total = round(this.cart.reduce((s, c) => s + c.price * c.qty, 0) + 49.9, 2);
    const invalid = forceInvalid || this.rng.chance(0.3);
    const orderId = `PT-2026-${this.rng.int(110_000, 129_999)}`;
    this.event('begin_checkout', { value: total, currency: 'TRY', items: this.cart.length });
    this.api(
      'POST',
      '/orders',
      invalid ? 422 : 201,
      invalid
        ? json({ error: 'validation_failed', message: 'Adres bilgisi eksik', fields: { 'address.postalCode': 'Posta kodu geçersiz', 'address.line1': 'Zorunlu alan' } })
        : json({ id: orderId, status: 'created', total, currency: 'TRY', estimatedDelivery: '2026-11-04' }),
      {
        request: json({
          items: this.cart.map((c) => ({ sku: c.sku, qty: c.qty })),
          addressId: 12,
          paymentMethod: 'card',
          note: 'Kapıya bırakın lütfen 🙏',
        }),
        latency: [160, 480],
        then: (o) => {
          if (o.status === 422) {
            this.log('warn', 'checkout', 'Sipariş doğrulanamadı: Posta kodu geçersiz', { data: { fields: ['address.postalCode', 'address.line1'] } });
            return;
          }
          if (o.status !== 201) return;
          this.pay(orderId, total);
        },
      },
    );
  }

  private pay(orderId: string, total: number): void {
    const outcome = this.rng.weighted<'ok' | 'declined' | 'error'>([
      ['ok', 6],
      ['declined', 2],
      ['error', 1],
    ]);
    const body =
      outcome === 'ok'
        ? json({ status: 'succeeded', transactionId: `txn_${this.rng.hex(20)}`, amount: total, currency: 'TRY', installments: 1 })
        : outcome === 'declined'
          ? json({ error: 'card_declined', code: '51', message: 'Kart reddedildi: yetersiz bakiye' })
          : json({ error: 'internal', message: 'Ödeme sağlayıcısına ulaşılamadı', traceId: this.rng.hex(32) });
    this.api('POST', '/payments/charge', outcome === 'ok' ? 200 : outcome === 'declined' ? 402 : 500, body, {
      request: json({ orderId, amount: total, currency: 'TRY', card: { brand: 'visa', last4: '4242', expiry: '09/29' }, installments: 1, threeDS: false }),
      latency: outcome === 'error' ? [1400, 2600] : [450, 1300],
      then: (o) => {
        if (o.status === 200) {
          this.log('info', 'payment', `Ödeme başarılı: ${orderId}`, { data: { orderId, amount: total, currency: 'TRY' } });
          this.event('purchase', { transaction_id: orderId, value: total, currency: 'TRY', items: this.cart.length, payment_type: 'card' });
          this.cart = [];
          this.navigate('OrderSuccess', `/orders/${orderId}/success`, { orderId });
        } else {
          this.log('error', 'payment', 'Ödeme başarısız', {
            data: { orderId, status: o.status, amount: total },
            error: {
              type: 'PaymentException',
              message: o.status === 402 ? 'Kart reddedildi (51: yetersiz bakiye)' : `Ödeme sağlayıcısı hata döndürdü (HTTP ${o.status})`,
              stack: DART_PAYMENT_STACK,
            },
          });
        }
      },
    });
  }

  private profile(): void {
    this.navigate('Profile', '/profile');
    this.loadProfile(() => undefined);
    this.after(this.rng.int(1500, 3000), () => {
      const city = this.rng.pick(['İstanbul', 'İzmir', 'Ankara']);
      this.api('PUT', '/me/profile', 200, json({ id: ME.id, name: ME.name, city, bio: 'Kedi ve köpek dostu 🐾', updatedAt: new Date().toISOString() }), {
        request: json({ name: ME.name, city, bio: 'Kedi ve köpek dostu 🐾' }),
        latency: [90, 260],
        then: () => this.log('info', 'profile', 'Profil kaydedildi', { data: { city } }),
      });
      this.api('PATCH', '/me/settings', 200, json({ notifications: { push: true, email: this.rng.chance(0.5) } }), {
        request: json({ notifications: { email: this.rng.chance(0.5) } }),
        latency: [60, 200],
      });
    });
  }

  private upload(): void {
    this.navigate('AddPhoto', '/pets/new/photo');
    const png = petThumbnailPng(this.rng.int(1, 999), 64);
    const boundary = `dart-http-boundary-${this.rng.hex(24)}`;
    const head = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="petId"\r\n\r\n${this.rng.pick(PETS).id}\r\n--${boundary}\r\ncontent-type: image/png\r\ncontent-disposition: form-data; name="file"; filename="IMG_2041.png"\r\n\r\n`,
    );
    const size = this.rng.int(1_900_000, 3_400_000);
    this.log('info', 'upload', `Fotoğraf yükleniyor (${round(size / 1_048_576, 1)} MB)`, { data: { fileName: 'IMG_2041.png', bytes: size } });
    const id = this.rng.hex(12);
    [25, 50, 75].forEach((pct, i) => this.after((i + 1) * this.rng.int(700, 1100), () => this.log('debug', 'upload', `Yükleme %${pct}`)));
    this.req({
      method: 'POST',
      url: `${API}/uploads/pet-photo`,
      headers: [['content-type', `multipart/form-data; boundary=${boundary}`]],
      body: { contentType: `multipart/form-data; boundary=${boundary}`, base64: Buffer.concat([head, png]).toString('base64'), size, truncated: true },
      response: { status: 201, body: json({ url: `${CDN}/img/uploads/${id}.jpg`, width: 1080, height: 1350, sizeBytes: size, moderation: 'pending' }) },
      latency: [3200, 5600],
      then: (o) => {
        if (o.status === 201) this.log('info', 'upload', `Yükleme tamamlandı (${round(o.durationMs / 1000, 1)} sn)`, { data: { uploadId: id } });
        else this.log('error', 'upload', `Yükleme başarısız: ${o.error ?? `HTTP ${o.status}`}`);
      },
    });
  }

  private feed(force?: 'slow' | '503'): void {
    this.navigate('Feed', '/feed');
    const r = force === 'slow' ? 0.3 : force === '503' ? 0.05 : this.rng.next();
    const cursor = Buffer.from(JSON.stringify({ offset: this.rng.int(1, 30) * 20 })).toString('base64url');
    const items = Array.from({ length: 10 }, (_, i) => {
      const pet = PETS[(i * 7 + this.rng.int(0, 20)) % PETS.length] as DemoPet;
      return this.rng.chance(0.5)
        ? { type: 'adoption', id: `a_${pet.id}`, petId: pet.id, title: `${pet.name} yuva arıyor`, city: pet.city }
        : { type: 'tip', id: `t_${300 + i}`, title: this.rng.pick(['Kışın patileri nasıl korunur?', 'Yavru kediler için beslenme', 'Köpeklerde diş bakımı', 'Aşı takvimi rehberi']) };
    });
    if (r < 0.12) {
      this.api('GET', `/feed?cursor=${cursor}`, 503, { contentType: 'text/html; charset=utf-8', text: '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n' }, {
        latency: [30, 90],
        then: () => this.log('error', 'FeedRepository', 'Akış yüklenemedi: HTTP 503 (bakım?)', { data: { cursor } }),
      });
      return;
    }
    if (r < 0.2) {
      this.api('GET', `/feed?cursor=${cursor}`, 200, undefined, {
        latency: [15_000, 15_000],
        failure: { kind: 'timeout', afterMs: 15_000 },
        then: (o) =>
          this.log('error', 'FeedRepository', 'Akış zaman aşımına uğradı', {
            data: { cursor, timeoutMs: 15000 },
            error: { type: 'TimeoutException', message: o.error ?? 'timeout', stack: DART_SOCKET_STACK },
          }),
      });
      return;
    }
    if (r < 0.27) {
      this.api('GET', `/feed?cursor=${cursor}`, 200, json({ items, nextCursor: cursor }), {
        latency: [4000, 6000],
        cancelAfterMs: this.rng.int(1200, 2400),
        then: () => this.log('debug', 'FeedRepository', 'İstek iptal edildi (sayfadan çıkıldı)'),
      });
      this.after(1000, () => this.navigate('Home', '/'));
      return;
    }
    const slow = r < 0.45;
    this.api('GET', `/feed?cursor=${cursor}`, 200, json({ items, nextCursor: Buffer.from(JSON.stringify({ offset: 400 })).toString('base64url') }), {
      latency: slow ? [2100, 5800] : [120, 480],
      then: (o) => {
        if (slow) this.log('warn', 'perf', `Yavaş istek: GET /v1/feed ${round(o.durationMs / 1000, 1)} sn sürdü`, { data: { path: '/v1/feed', durationMs: o.durationMs, thresholdMs: 2000 } });
        this.log('debug', 'FeedRepository', `${items.length} öğe (${o.durationMs} ms)`);
      },
    });
  }

  private likeStory(forceMissing = false): void {
    const id = `s_${this.rng.int(1190, 1210)}`;
    const missing = forceMissing || this.rng.chance(0.15);
    this.req({
      method: 'POST',
      url: GQL,
      body: json({ operationName: 'LikeStory', query: 'mutation LikeStory($id: ID!) {\n  likeStory(storyId: $id) { id likeCount viewerHasLiked }\n}', variables: { id } }),
      response: {
        status: 200,
        body: missing
          ? json({ errors: [{ message: 'Story not found', path: ['likeStory'], extensions: { code: 'NOT_FOUND' } }], data: { likeStory: null } })
          : json({ data: { likeStory: { id, likeCount: this.rng.int(4, 260), viewerHasLiked: true } } }),
      },
      latency: [80, 260],
      then: () => {
        if (missing) this.log('warn', 'graphql', 'LikeStory: Story not found (NOT_FOUND)', { data: { storyId: id } });
        else this.event('like_story', { story_id: id });
      },
    });
    if (this.rng.chance(0.3)) {
      // anonymous shorthand query (no operation name)
      this.req({
        method: 'POST',
        url: GQL,
        body: json({ query: '{ me { id unreadCount } }' }),
        response: { status: 200, body: json({ data: { me: { id: String(ME.id), unreadCount: this.rng.int(0, 4) } } }) },
        latency: [50, 160],
      });
    }
  }

  private tokenExpiry(): void {
    this.log('warn', 'auth', 'Token expires in 58 s, refreshing proactively', { data: { expiresIn: 58 } });
    this.api('GET', '/me', 401, json({ error: 'token_expired', message: 'Access token expired' }), {
      response: { status: 401, headers: [['www-authenticate', 'Bearer error="invalid_token", error_description="The access token expired"']] },
      latency: [40, 120],
      then: () => {
        this.log('info', 'auth', 'Token süresi doldu, yenileniyor');
        this.refreshToken(() => this.loadProfile(() => this.log('info', 'auth', 'İstek yeni token ile tekrarlandı')));
      },
    });
  }

  private offline(): void {
    this.log('warn', 'connectivity', 'Bağlantı yok — çevrimdışı moda geçildi', { data: { type: 'none' } });
    for (const path of ['/pets?page=1&limit=20', '/notifications?unread=true']) {
      this.api('GET', path, 200, undefined, {
        latency: [5, 30],
        failure: { kind: 'dns', afterMs: this.rng.int(5, 40) },
        then: (o) => this.log('error', 'api', `İstek başarısız: ${path}`, { error: { type: 'SocketException', message: o.error ?? '', stack: DART_SOCKET_STACK } }),
      });
    }
    this.after(this.rng.int(3000, 6000), () => this.log('info', 'connectivity', 'Bağlantı geri geldi (wifi)', { data: { type: 'wifi' } }));
  }

  private devServer(): void {
    const url = this.ios ? 'http://127.0.0.1:8080/health' : 'http://10.0.2.2:8080/health';
    this.req({
      method: 'GET',
      url,
      latency: [3, 20],
      failure: { kind: 'connection', afterMs: this.rng.int(3, 20) },
      then: (o) => this.log('warn', 'devtools', 'Yerel geliştirme sunucusuna ulaşılamadı (mock sunucu kapalı mı?)', { data: { url, error: o.error } }),
    });
  }

  private geocode(): void {
    const lat = round(40.99 + this.rng.float(-0.02, 0.02), 4);
    const lon = round(29.03 + this.rng.float(-0.02, 0.02), 4);
    this.log('debug', 'location', `Konum güncellendi (±${this.rng.int(5, 30)} m)`, { data: { lat, lon } });
    this.req({
      method: 'GET',
      url: `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=tr&key=AIzaSyDemoKey-Pati0000000000000000`,
      response: {
        status: 200,
        body: json({
          results: [
            {
              formatted_address: 'Caferağa, Moda Cd. No:12, 34710 Kadıköy/İstanbul, Türkiye',
              geometry: { location: { lat, lng: lon }, location_type: 'ROOFTOP' },
              place_id: `ChIJ${this.rng.base64url(20)}`,
              types: ['street_address'],
            },
          ],
          status: 'OK',
        }),
      },
      latency: [90, 260],
    });
  }

  /* ───────────── ambient output ───────────── */

  private backgroundLog(): void {
    if (!this.running) return;
    const r = this.rng;
    const variant = r.weighted<number>([
      [0, 3],
      [1, 2],
      [2, 2],
      [3, 1.2],
      [4, 1.5],
      [5, 1],
      [6, 0.8],
      [7, 0.6],
      [8, 0.25],
      [9, 0.15],
      [10, 0.8],
    ]);
    switch (variant) {
      case 0:
        this.log('debug', 'riverpod', r.pick(['petListProvider → AsyncData(20 öğe)', `cartProvider → AsyncData(${this.cart.length} ürün)`, this.loggedIn ? `authStateProvider → Authenticated(userId: ${ME.id})` : 'authStateProvider → Unauthenticated()', 'feedProvider → AsyncLoading()', 'notificationsProvider → AsyncData(unread: 2)']));
        return;
      case 1:
        this.log('verbose', 'frame', `Frame #${++this.frame}: build ${round(r.float(2.1, 6.5))} ms, raster ${round(r.float(3.2, 8.8))} ms`);
        return;
      case 2:
        this.log('debug', 'image_cache', `ImageCache: ${this.images}/1000 görsel, ${round(this.imageMB)} MB / 100 MB`);
        return;
      case 3:
        this.log('debug', 'sync', JSON.stringify({ event: 'sync', status: 'ok', changed: r.int(0, 6), durationMs: r.int(40, 400), table: r.pick(['favorites', 'messages', 'drafts']) }));
        return;
      case 4:
        this.log('info', 'analytics', `${r.int(1, 4)} olay kuyruğa alındı (toplam ${r.int(4, 30)})`);
        return;
      case 5:
        this.log('debug', 'cache', `Cache hit: GET /v1/pets?page=${r.int(1, 4)} (age ${r.int(2, 59)} s)`);
        return;
      case 6:
        this.log('debug', 'perf', 'Route timing', { data: { route: `/${this.screen.toLowerCase()}`, firstFrameMs: r.int(12, 90), buildCount: r.int(1, 6), rebuildReason: r.pick(['setState', 'provider', 'mediaQuery']) } });
        return;
      case 7:
        this.log('info', 'ws', `Sohbet soketi: heartbeat ✓ (${r.int(18, 90)} ms)`);
        return;
      case 8: {
        const rtt = r.int(600, 1400);
        this.log('warn', 'connectivity', `Bağlantı kalitesi düşük (RTT ${rtt} ms)`, { data: { rttMs: rtt, type: 'wifi' } });
        return;
      }
      case 9:
        this.log('error', 'image', `Görsel çözümlenemedi: Exception: Invalid image data (${CDN}/img/pets/${r.pick(PETS).id}/3.png)`);
        return;
      default:
        this.log('verbose', 'gesture', `GestureDetector: tap at Offset(${round(r.float(20, 380))}, ${round(r.float(80, 820))})`);
    }
  }

  /** Flutter print/debugPrint output, which the OS log captures (device log, tag "flutter"). */
  private stdout(message: string, level: 'info' | 'error' = 'info', kind?: 'flutter-error' | 'crash'): void {
    const entry: Parameters<DemoApp['deviceLog']>[0][number] = { level, tag: 'flutter', message };
    if (kind) entry.kind = kind;
    this.deviceLog([entry]);
  }

  private printLine(): void {
    if (!this.running) return;
    const r = this.rng;
    this.stdout(
      r.pick([
        `🐾 ${this.screen}: rebuild (${r.int(1, 4)} widgets)`,
        `[ImageCache] ${this.images}/1000 images, ${round(this.imageMB)} MB`,
        `Riverpod: ${r.pick(['cartProvider', 'feedProvider', 'petListProvider'])} changed`,
        `[Hive] box "favorites" synced (${this.favorites.size} kayıt)`,
        `⏱ ${this.screen} first frame in ${r.int(14, 80)} ms`,
      ]),
    );
  }

  private appTimeStats(): void {
    if (!this.running) return;
    const avg = round(this.rng.float(6.8, 11.5) + this.jankBoost * 1.4, 2);
    this.deviceLog([
      {
        level: 'debug',
        tag: 'EGL_emulation',
        message: `app_time_stats: avg=${avg}ms min=${round(this.rng.float(1.6, 3.2), 2)}ms max=${round(avg * this.rng.float(2.2, 5.5), 2)}ms count=${this.rng.int(52, 61)}`,
      },
    ]);
  }

  private slowFrames(): void {
    const skipped = this.rng.int(12, 58);
    this.jankBoost += skipped / 3;
    this.cpuBoost += this.rng.float(20, 60);
    if (this.ios) {
      this.log('warn', 'perf', `Jank: ${Math.round(skipped / 2)} kare 8.3 ms bütçesini aştı (en kötü ${this.rng.int(28, 70)} ms)`, { data: { screen: this.screen, frames: Math.round(skipped / 2) } });
      return;
    }
    const v = Date.now() * 1e6;
    this.deviceLog([
      { level: 'info', tag: 'Choreographer', message: `Skipped ${skipped} frames!  The application may be doing too much work on its main thread.` },
      {
        level: 'info',
        tag: 'OpenGLRenderer',
        message: `Davey! duration=${Math.round(skipped * 16.7)}ms; Flags=0, FrameTimelineVsyncId=${this.rng.int(1_000_000, 9_999_999)}, IntendedVsync=${v}, Vsync=${v + 16_666_666 * skipped}, InputEventId=0, HandleInputStart=${v + 1_200_000}, AnimationStart=${v + 1_300_000}, PerformTraversalsStart=${v + 1_400_000}, DrawStart=${v + 9_100_000}, FrameDeadline=${v + 20_266_666}, FrameInterval=16666666, FrameStartTime=${v + 16_666_666}, SyncQueued=${v + 9_900_000}, SyncStart=${v + 10_000_000}, IssueDrawCommandsStart=${v + 10_200_000}, SwapBuffers=${v + 14_000_000}, FrameCompleted=${v + 16_000_000}, DequeueBufferDuration=${this.rng.int(20_000, 90_000)}, QueueBufferDuration=${this.rng.int(200_000, 900_000)}, GpuCompleted=${v + 15_500_000}, SwapBuffersCompleted=${v + 15_800_000}, DisplayPresentTime=0, CommandSubmissionCompleted=${v + 14_200_000}, `,
      },
    ]);
  }

  /* ───────────── errors, crashes, reconnects ───────────── */

  private flutterErrorBox(): void {
    if (!this.running) return;
    const first = this.errorBoxes++ === 0;
    const kind = first
      ? this.ios
        ? 'setState'
        : 'overflow'
      : this.rng.weighted<'overflow' | 'image' | 'setState'>([
          ['overflow', 3],
          ['image', 2],
          ['setState', 1.5],
        ]);
    if (kind === 'image') {
      const url = `${CDN}/img/pets/9999/cover.png`;
      this.req({
        method: 'GET',
        url,
        response: {
          status: 404,
          body: { contentType: 'application/xml', text: '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>img/pets/9999/cover.png</Key></Error>' },
        },
        latency: [30, 120],
        then: () => this.emitFlutterError(FLUTTER_IMAGE_ERROR(url), 'NetworkImageLoadException', `HTTP request failed, statusCode: 404, ${url}`),
      });
      return;
    }
    if (kind === 'overflow' && this.overflowShown) {
      // Flutter prints the full box only once per error type; repeats are one-liners.
      const line = 'Another exception was thrown: A RenderFlex overflowed by 38 pixels on the right.';
      this.stdout(line, 'error');
      this.log('error', 'flutter', line, { kind: 'flutter-error' });
      return;
    }
    if (kind === 'overflow') this.overflowShown = true;
    const text = kind === 'overflow' ? FLUTTER_OVERFLOW_ERROR : FLUTTER_SETSTATE_ERROR;
    this.emitFlutterError(text, 'FlutterError', kind === 'overflow' ? 'A RenderFlex overflowed by 38 pixels on the right.' : 'setState() called after dispose()');
  }

  private emitFlutterError(box: string, type: string, summary: string): void {
    // FlutterError.onError (SDK) and FlutterError.presentError → stdout (device log) both report it.
    this.log('error', 'flutter', box, { kind: 'flutter-error', error: { type, message: summary } });
    this.stdout(box, 'error', 'flutter-error');
  }

  private dartException(): void {
    if (!this.running) return;
    this.log('fatal', 'zone', 'Unhandled exception: Null check operator used on a null value', {
      kind: 'crash',
      error: { type: '_TypeError', message: 'Null check operator used on a null value', stack: DART_NULL_CHECK_STACK },
      data: { screen: this.screen, isolate: 'main', fatal: false },
    });
    this.stdout(`[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Null check operator used on a null value\n${DART_NULL_CHECK_STACK}`, 'error');
  }

  private transportBlip(): void {
    if (!this.running) return;
    // A slow request is in flight while the connection drops: it fails on disconnect, then the late
    // response upgrades it once the SDK has reconnected with the same session.
    this.api('GET', '/feed?cursor=eyJvZmZzZXQiOjQwfQ', 200, json({ items: [], nextCursor: null }), { latency: [2600, 3400] });
    this.after(400, () => {
      this.reconnect(this.rng.int(1400, 2200));
      this.after(2400, () => this.log('info', 'durbun', 'Dürbün bağlantısı yeniden kuruldu (kuyruktaki mesajlar gönderildi)'));
    });
  }

  private nativeCrash(): void {
    if (!this.running || !this.ios) return;
    this.deviceLog([
      {
        level: 'fatal',
        tag: 'Runner',
        kind: 'crash',
        message:
          "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[__NSCFString objectForKey:]: unrecognized selector sent to instance 0x600000c8c120'\n*** First throw call stack:\n(0x180b21234 0x18015b3d8 0x180b2a5c4 0x180b0c8a4 0x180b0de8c 0x104a1c2d8 0x104a1b9f0 0x1066f4c28 0x1066f6750 0x106708f74 0x180a8f3c4 0x180a8b5ac 0x180a8a6b4 0x1883c11c8 0x1854cd1e0 0x1855f1d38 0x104a0e2c0 0x1056d1410)\nlibc++abi: terminating due to uncaught exception of type NSException",
      },
    ]);
    this.stop('crash');
    this.deps.sched.after(this.rng.int(4000, 7000), () => this.launch('user'));
  }

  /* ───────────── reactions to device actions ───────────── */

  handleDeepLink(url: string): void {
    if (!this.running) return;
    let path = url;
    try {
      const u = new URL(url);
      path = u.protocol === 'pati:' ? `/${u.host}${u.pathname}` : u.pathname;
    } catch {
      // keep raw
    }
    this.log('info', 'router', `Deep link: ${url} → ${path}`, { data: { url, path } });
    this.event('deep_link_open', { url });
    const m = /\/pets\/(\d+)/.exec(path);
    if (m) this.navigate('PetDetail', path, { petId: Number(m[1]) });
  }

  handlePush(payload: Record<string, unknown>): void {
    if (!this.running) return;
    const aps = (payload.aps ?? {}) as { alert?: { title?: string; body?: string } | string };
    const title = typeof aps.alert === 'string' ? aps.alert : (aps.alert?.title ?? 'Bildirim');
    this.log('info', 'push', `Bildirim alındı: ${title}`, { data: payload });
    this.event('notification_receive', { title });
  }

  handleLocation(lat: number, lon: number): void {
    if (!this.running) return;
    this.log('info', 'location', `Konum güncellendi: ${lat.toFixed(4)}, ${lon.toFixed(4)}`, { data: { lat, lon, source: 'simulated' } });
  }

  handleAppearance(mode: 'dark' | 'light'): void {
    if (!this.running) return;
    this.log('info', 'theme', `Platform brightness değişti → ${mode}`, { data: { brightness: mode, followSystem: this.brightness === 'system' } });
    this.jankBoost += 4;
  }

  handleTextScale(scale: number): void {
    if (!this.running) return;
    this.textScale = scale;
    this.log('info', 'a11y', `MediaQuery.textScaler → ${scale}x`, { data: { textScaleFactor: scale } });
    if (scale >= 1.3) this.after(300, () => this.flutterErrorBox());
  }

  handleText(text: string): void {
    if (!this.running) return;
    this.log('debug', 'search', `Arama alanı: "${text}"`, { data: { length: text.length } });
  }

  handleKey(key: string): void {
    if (!this.running) return;
    if (key === 'back') this.navigate('Home', '/');
    else if (key === 'home') {
      this.log('info', 'lifecycle', 'AppLifecycleState.inactive → hidden → paused');
      this.after(this.rng.int(2500, 4500), () => this.log('info', 'lifecycle', 'AppLifecycleState.resumed'));
    }
  }

  resetData(): void {
    this.loggedIn = false;
    this.token = '';
    this.cart = [];
    this.favorites.clear();
    this.overflowShown = false;
  }

  get currentTextScale(): number {
    return this.textScale;
  }
}
