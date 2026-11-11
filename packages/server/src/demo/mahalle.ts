/**
 * "Mahalle" — a native Android (Kotlin + OkHttp) neighbourhood-market app with the Dürbün Android SDK:
 * OkHttp logcat lines, StrictMode noise, order tracking polls, coupon validation errors, timeouts with
 * Java stack traces, a fatal crash (AndroidRuntime) and an ANR now and then.
 */
import type { AppActionDescriptor, Header } from '@durbun/protocol';
import type { DeviceLogInput } from '../types';
import { type AppDeps, type CommandOutcome, DemoApp, type StopReason } from './appSim';
import { anrReport, JAVA_BASKET_CRASH, JAVA_BASKET_CRASH_SDK_STACK, JAVA_TIMEOUT_STACK, MARKET_PRODUCTS, MARKET_STORES, STRICT_MODE_VIOLATION } from './content';
import { ANDROID_SYSTEM } from './devices';
import { type FailureKind, type HttpOutcome, type HttpPlan, json, type SimBody } from './http';
import { androidAnrLine, androidLine } from './noise';
import { petThumbnailPng } from './png';
import { round, Walk } from './rng';

type Env = 'prod' | 'staging' | 'dev';
const API_BASE: Record<Env, string> = {
  prod: 'https://api.mahalle.app/v2',
  staging: 'https://api.staging.mahalle.app/v2',
  dev: 'http://10.0.2.2:8081/v2',
};
const CDN = 'https://cdn.mahalle.app';

const imageCache = new Map<number, string>();
function productImage(id: number): string {
  let b64 = imageCache.get(id);
  if (!b64) {
    b64 = petThumbnailPng(id * 13, 72).toString('base64');
    imageCache.set(id, b64);
  }
  return b64;
}

function kb(bytes: number): string {
  return bytes >= 1024 ? `${round(bytes / 1024, 1)} kB` : `${bytes} B`;
}

export class MahalleApp extends DemoApp {
  private env: Env = 'staging';
  private verboseHttp = false;
  private basket: { productId: number; name: string; qty: number; price: number }[] = [];
  private readonly cpu = new Walk(8, 9, 0.2, 1.8, 1, 140);
  private readonly memory = new Walk(142, 150, 0.05, 1.2, 100, 320);
  private heap = 31;
  private jankBoost = 0;
  private tracking = false;

  constructor(deps: AppDeps) {
    super(
      deps,
      {
        name: 'Mahalle',
        bundleId: 'com.mykynk.mahalle',
        version: '5.12.0',
        build: '5120',
        processName: 'com.mykynk.mahalle',
        sdk: { name: 'durbun-android', version: '0.2.0', platform: 'android' },
        source: 'okhttp',
        capabilities: ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'],
        device: { model: 'Pixel 8', name: 'Pixel 8', osVersion: '15', apiLevel: 35, manufacturer: 'Google' },
      },
      6612,
    );
  }

  private get api(): string {
    return API_BASE[this.env];
  }

  actions(): AppActionDescriptor[] {
    return [
      {
        id: 'mahalle.environment',
        kind: 'select',
        label: 'API environment',
        group: 'app',
        options: [
          { value: 'prod', label: 'Production' },
          { value: 'staging', label: 'Staging' },
          { value: 'dev', label: 'Local dev server' },
        ],
        value: this.env,
      },
      { id: 'mahalle.verboseHttp', kind: 'toggle', label: 'Verbose HTTP logging', group: 'app', value: this.verboseHttp },
      { id: 'mahalle.clearImageCache', kind: 'button', label: 'Clear image cache', group: 'app' },
    ];
  }

  protected onCommand(name: string, params: Record<string, unknown>): CommandOutcome {
    switch (name) {
      case 'mahalle.environment': {
        const value = params.value;
        if (value !== 'prod' && value !== 'staging' && value !== 'dev') return { ok: false, error: 'Invalid environment (prod | staging | dev)' };
        this.env = value;
        this.log('info', 'Environment', `API ortamı değişti → ${value} (${this.api})`, { data: { env: value, baseUrl: this.api } });
        this.publishActions();
        this.after(300, () => this.campaigns());
        return { ok: true, data: { value } };
      }
      case 'mahalle.verboseHttp': {
        this.verboseHttp = typeof params.value === 'boolean' ? params.value : !this.verboseHttp;
        this.log('info', 'HttpLogging', `HttpLoggingInterceptor.Level = ${this.verboseHttp ? 'HEADERS' : 'BASIC'}`);
        this.publishActions();
        return { ok: true, data: { value: this.verboseHttp } };
      }
      case 'mahalle.clearImageCache': {
        const mb = round(this.rng.float(12, 48), 1);
        this.log('info', 'Coil', `Görsel önbelleği temizlendi (${mb} MB)`, { data: { freedMB: mb } });
        return { ok: true, data: { freedMB: mb } };
      }
      default:
        return { ok: false, error: `Unknown command: ${name}` };
    }
  }

  protected metric(): Record<string, number> {
    this.heap += this.rng.float(0.1, 0.9);
    if (this.heap > 64) this.heap = this.rng.float(26, 34);
    const jank = Math.round(this.jankBoost + (this.rng.chance(0.15) ? 1 : 0));
    this.jankBoost *= 0.3;
    return {
      cpu: round(this.cpu.step(this.rng) + jank * 2.5),
      memoryMB: round(this.memory.step(this.rng)),
      heapMB: round(this.heap),
      fps: round(Math.max(12, 60 - jank * this.rng.float(0.8, 1.7) - this.rng.float(0, 0.6))),
      jankyFrames: jank,
      frameBuildMs: round(this.rng.float(2.5, 6) + jank * 0.8),
      frameRasterMs: round(this.rng.float(3, 7.5) + jank),
      threads: this.rng.int(46, 55),
    };
  }

  protected baseHeaders(url: URL): Header[] {
    const headers: Header[] = [
      ['accept-encoding', 'gzip'],
      ['user-agent', 'okhttp/4.12.0'],
    ];
    if (!url.hostname.startsWith('cdn.')) {
      headers.push(
        ['accept', 'application/json'],
        ['accept-language', 'tr-TR'],
        ['x-client', 'mahalle-android/5.12.0 (5120)'],
        ['authorization', 'Bearer mh_demo_8c1f0e2d4b6a9f17'],
      );
    }
    return headers;
  }

  protected errorText(kind: FailureKind, host: string, url: string): string {
    switch (kind) {
      case 'timeout':
        return 'java.net.SocketTimeoutException: timeout';
      case 'connection':
        return `java.net.ConnectException: Failed to connect to /${host}:${(() => {
          try {
            return new URL(url).port || '443';
          } catch {
            return '443';
          }
        })()}`;
      case 'dns':
        return `java.net.UnknownHostException: Unable to resolve host "${host}": No address associated with hostname`;
      case 'tls':
        return 'javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.';
      case 'reset':
        return 'java.io.IOException: unexpected end of stream on https://api.mahalle.app/...';
    }
  }

  protected override onRequestStart(info: { id: string; method: string; url: string }): void {
    const lines: Omit<DeviceLogInput, 'pid' | 'ts'>[] = [{ level: 'info', tag: 'okhttp.OkHttpClient', message: `--> ${info.method} ${info.url}` }];
    if (this.verboseHttp) {
      lines.push(
        { level: 'info', tag: 'okhttp.OkHttpClient', message: 'Accept: application/json' },
        { level: 'info', tag: 'okhttp.OkHttpClient', message: 'X-Client: mahalle-android/5.12.0 (5120)' },
        { level: 'info', tag: 'okhttp.OkHttpClient', message: `--> END ${info.method}` },
      );
    }
    this.deviceLog(lines);
  }

  protected override onRequestFinish(o: HttpOutcome): void {
    if (o.error) {
      this.deviceLog([{ level: 'info', tag: 'okhttp.OkHttpClient', message: `<-- HTTP FAILED: ${o.error}` }]);
      return;
    }
    this.deviceLog([{ level: 'info', tag: 'okhttp.OkHttpClient', message: `<-- ${o.status} ${o.url} (${o.durationMs}ms, ${kb(o.responseBytes)} body)` }]);
  }

  private call(method: string, path: string, status: number, body: SimBody | undefined, opts: Partial<HttpPlan> & { latency?: [number, number]; request?: SimBody } = {}): void {
    const [min, max] = opts.latency ?? [70, 380];
    const dev = this.env === 'dev';
    this.http.request({
      method,
      url: `${this.api}${path}`,
      body: opts.request,
      response: { status, body, headers: opts.response?.headers },
      latencyMs: dev ? this.rng.int(3, 15) : this.rng.int(min, max),
      failure: dev ? { kind: 'connection' } : opts.failure,
      then: opts.then,
    });
  }

  /* ───────────── lifecycle device lines ───────────── */

  protected onProcessStart(): void {
    const pid = this.pid as number;
    const ss = ANDROID_SYSTEM.systemServer.pid;
    this.systemLog([
      androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', 'START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000 cmp=com.mykynk.mahalle/.ui.MainActivity} with LAUNCH_MULTIPLE from uid 10162 result code=0'),
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Start proc ${pid}:com.mykynk.mahalle/u0a241 for next-top-activity {com.mykynk.mahalle/com.mykynk.mahalle.ui.MainActivity}`),
    ]);
    this.after(50, () =>
      this.deviceLog([
        { level: 'debug', tag: 'nativeloader', message: `Configuring clns-8 for other apk /data/app/~~Lq9w8E7r6T5y4U3i2O1p0A==/com.mykynk.mahalle-${this.rng.hex(6)}==/base.apk. target_sdk_version=35` },
        { level: 'debug', tag: 'StrictMode', message: STRICT_MODE_VIOLATION },
        { level: 'info', tag: 'MahalleApp', message: 'Hilt component initialized (23 ms)' },
        { level: 'warn', tag: 'OpenGLRenderer', message: 'Unable to match the desired swap behavior.' },
        { level: 'debug', tag: 'NetworkSecurityConfig', message: 'No Network Security Config specified, using platform default' },
      ]),
    );
    this.after(500, () => {
      this.deviceLog([{ level: 'info', tag: 'Choreographer', message: `Skipped ${this.rng.int(24, 40)} frames!  The application may be doing too much work on its main thread.` }]);
      this.systemLog([androidLine(ss, ss + 21, 'info', 'ActivityTaskManager', `Displayed com.mykynk.mahalle/.ui.MainActivity for user 0: +${this.rng.int(420, 720)}ms`)]);
    });
  }

  protected onProcessEnd(reason: StopReason): void {
    const pid = this.pid as number;
    const ss = ANDROID_SYSTEM.systemServer.pid;
    const win = this.rng.hex(7);
    const lines: DeviceLogInput[] = [];
    if (reason === 'crash') {
      lines.push(androidLine(ss, ss + 12, 'warn', 'ActivityTaskManager', '  Force finishing activity com.mykynk.mahalle/.ui.MainActivity'));
    } else if (reason === 'uninstall') {
      lines.push(androidLine(ss, ss + 5, 'info', 'PackageManager', 'Removing package com.mykynk.mahalle'));
    } else {
      lines.push(androidLine(ss, ss + 5, 'info', 'ActivityManager', `Force stopping com.mykynk.mahalle appid=10241 user=0: ${reason === 'clear-data' ? 'clear data' : `from pid ${this.rng.int(9000, 9900)}`}`));
    }
    lines.push(
      androidLine(ss, ss + 33, 'info', 'WindowManager', `WIN DEATH: Window{${win} u0 com.mykynk.mahalle/com.mykynk.mahalle.ui.MainActivity}`),
      androidLine(ss, ss + 9, 'info', 'ActivityManager', `Process com.mykynk.mahalle (pid ${pid}) has died: ${reason === 'crash' ? 'fg  TOP' : 'fg  TOP'}`),
    );
    this.systemLog(lines);
  }

  /* ───────────── behaviour ───────────── */

  protected onRunning(firstLaunch: boolean): void {
    this.log('info', 'MahalleApp', `Uygulama başlatıldı (cold start ${this.rng.int(380, 640)} ms)`, { data: { env: this.env, versionCode: 5120, sdkInt: 35 } });
    this.after(80, () => this.campaigns());
    this.after(220, () => this.stores());
    this.every(950, () => this.backgroundLog());
    if (firstLaunch) {
      const steps: [number, () => void][] = [
        [5000, () => this.coupon()],
        [8500, () => this.recommendations()],
        [12_000, () => this.addToBasket()],
        [15_000, () => this.reviewsTimeout()],
      ];
      for (const [at, step] of steps) this.after(at, () => this.running && step());
    }
    this.periodically(9000, 18_000, () => this.scenario(), firstLaunch ? 19_000 : 4000);
    // First run: the ANR comes before the crash (a crash restarts the process and its timers).
    this.periodically(420_000, 640_000, () => this.anr(), firstLaunch ? 52_000 : undefined);
    this.periodically(300_000, 470_000, () => this.crash(), firstLaunch ? 96_000 : undefined);
  }

  private campaigns(): void {
    this.call(
      'GET',
      '/campaigns',
      200,
      json({
        data: [
          { id: 'kasim20', title: 'Kasım İndirimi %20', endsAt: '2026-11-30T20:59:59Z', minBasket: 250 },
          { id: 'free-delivery', title: 'Ücretsiz Teslimat', endsAt: '2026-11-08T20:59:59Z', minBasket: 150 },
          { id: 'kahvalti', title: 'Kahvaltılıklarda 2 al 1 öde', endsAt: '2026-11-15T20:59:59Z' },
        ],
      }),
      {
        then: (o) => {
          if (o.status === 200) this.log('debug', 'CampaignRepository', `3 kampanya yüklendi (${o.durationMs} ms)`);
          else this.log('error', 'CampaignRepository', `Kampanyalar yüklenemedi: ${o.error ?? `HTTP ${o.status}`}`, o.error ? { error: { type: 'java.net.ConnectException', message: o.error } } : {});
        },
      },
    );
  }

  private stores(): void {
    this.call('GET', '/stores?lat=40.9903&lon=29.0289&radius=2000', 200, json({ data: MARKET_STORES.map((s) => ({ ...s, open: true, etaMin: this.rng.int(12, 40), logo: `${CDN}/stores/${s.id}/logo.png` })), meta: { total: MARKET_STORES.length } }), {
      then: (o) => {
        if (o.status !== 200) return;
        this.log('debug', 'MainViewModel', `UiState → Content(stores=${MARKET_STORES.length}, campaigns=3)`);
        MARKET_STORES.slice(0, 3).forEach((s, i) =>
          this.after(i * 30, () =>
            this.http.request({ method: 'GET', url: `${CDN}/stores/${s.id}/logo.png`, response: { status: 200, body: { contentType: 'image/png', base64: productImage(s.id) } }, latencyMs: this.rng.int(30, 160) }),
          ),
        );
      },
    });
  }

  private scenario(): void {
    if (!this.running) return;
    this.rng.weighted<() => void>([
      [() => this.browseStore(), 3],
      [() => this.addToBasket(), 2.5],
      [() => this.coupon(), 1],
      [() => this.order(), 1.2],
      [() => this.recommendations(), 0.9],
      [() => this.reviewsTimeout(), 0.6],
      [() => this.campaigns(), 0.8],
    ])();
  }

  private browseStore(): void {
    const store = this.rng.pick(MARKET_STORES);
    const category = this.rng.pick(['sarkuteri', 'firin', 'manav', 'kahvalti']);
    this.event('view_item_list', { item_list_id: `store_${store.id}`, item_list_name: store.name, category });
    this.log('debug', 'StoreViewModel', `Mağaza açıldı: ${store.name} (${store.district})`, { data: { storeId: store.id, category } });
    this.call('GET', `/stores/${store.id}/products?category=${category}&page=1`, 200, json({ data: MARKET_PRODUCTS.map((p) => ({ ...p, currency: 'TRY', image: `${CDN}/products/${p.id}.png`, inStock: this.rng.chance(0.85) })), page: 1, hasMore: false }), {
      then: () => {
        for (const p of this.rng.sample(MARKET_PRODUCTS, 3)) {
          this.http.request({ method: 'GET', url: `${CDN}/products/${p.id}.png`, response: { status: 200, body: { contentType: 'image/png', base64: productImage(p.id) } }, latencyMs: this.rng.int(20, 140) });
        }
      },
    });
  }

  private addToBasket(): void {
    const p = this.rng.pick(MARKET_PRODUCTS);
    const line = this.basket.find((b) => b.productId === p.id);
    if (line) line.qty++;
    else this.basket.push({ productId: p.id, name: p.name, qty: 1, price: p.price });
    const total = round(this.basket.reduce((s, b) => s + b.price * b.qty, 0), 2);
    this.call('POST', '/basket/items', 201, json({ basketId: 'b_77120', items: this.basket.length, total, currency: 'TRY' }), {
      request: json({ productId: p.id, qty: 1 }),
      then: (o) => {
        if (o.status !== 201) return;
        this.event('add_to_cart', { item_id: String(p.id), item_name: p.name, price: p.price, quantity: 1, currency: 'TRY' });
        this.log('info', 'BasketRepository', `Sepet: ${this.basket.length} ürün, ₺${total.toLocaleString('tr-TR')}`, { data: { items: this.basket.length, total } });
      },
    });
  }

  private coupon(): void {
    this.call('POST', '/basket/coupon', 422, json({ error: 'coupon_expired', message: 'Kupon süresi dolmuş', code: 'KASIM20', expiredAt: '2026-11-01T20:59:59Z' }), {
      request: json({ code: 'KASIM20' }),
      then: () => this.log('warn', 'BasketViewModel', 'Kupon uygulanamadı: Kupon süresi dolmuş (KASIM20)', { data: { code: 'KASIM20', http: 422 } }),
    });
  }

  private order(): void {
    if (this.basket.length === 0) {
      this.addToBasket();
      return;
    }
    const total = round(this.basket.reduce((s, b) => s + b.price * b.qty, 0) + 19.9, 2);
    const orderId = `MH${this.rng.int(4_100_000, 4_199_999)}`;
    this.event('begin_checkout', { value: total, currency: 'TRY' });
    this.call('POST', '/orders', 201, json({ id: orderId, status: 'received', total, currency: 'TRY', etaMin: this.rng.int(20, 45) }), {
      request: json({ basketId: 'b_77120', addressId: 'adr_3', paymentMethod: 'card_on_delivery', tip: 10 }),
      latency: [220, 650],
      then: (o) => {
        if (o.status !== 201) return;
        this.event('purchase', { transaction_id: orderId, value: total, currency: 'TRY', items: this.basket.length });
        this.log('info', 'OrderRepository', `Sipariş oluşturuldu: ${orderId}`, { data: { orderId, total } });
        this.basket = [];
        this.track(orderId);
      },
    });
  }

  private track(orderId: string): void {
    if (this.tracking) return;
    this.tracking = true;
    const statuses = ['received', 'preparing', 'preparing', 'on_the_way', 'on_the_way', 'delivered'];
    statuses.forEach((status, i) =>
      this.after(i * 5000 + 1500, () => {
        const done = i === statuses.length - 1;
        this.call(
          'GET',
          `/orders/${orderId}/tracking`,
          200,
          json({
            orderId,
            status,
            courier: status === 'on_the_way' ? { name: 'Murat K.', vehicle: 'motosiklet', location: { lat: round(40.99 + i * 0.002, 4), lon: round(29.02 + i * 0.003, 4) } } : null,
            etaMin: Math.max(0, 30 - i * 6),
          }),
          { latency: [60, 200] },
        );
        if (status === 'on_the_way' || done) this.log('info', 'OrderTracker', done ? `Sipariş teslim edildi: ${orderId}` : `Kurye yolda (${Math.max(0, 30 - i * 6)} dk)`);
        if (done) this.tracking = false;
      }),
    );
  }

  private recommendations(): void {
    const traceId = this.rng.hex(32);
    this.call('GET', '/recommendations?limit=10', 500, json({ error: 'internal', message: 'Unexpected error', traceId }), {
      then: (o) => {
        if (o.status === 500) this.log('error', 'RecommendationRepository', `Öneriler yüklenemedi: HTTP 500 (traceId=${traceId.slice(0, 8)}…)`, { data: { traceId } });
      },
    });
  }

  private reviewsTimeout(): void {
    const store = this.rng.pick(MARKET_STORES);
    this.call('GET', `/stores/${store.id}/reviews?page=1`, 200, undefined, {
      latency: [10_000, 10_000],
      failure: { kind: 'timeout', afterMs: 10_000 },
      then: (o) => {
        this.log('error', 'ReviewRepository', 'Yorumlar yüklenemedi', { error: { type: 'java.net.SocketTimeoutException', message: o.error ?? 'timeout', stack: JAVA_TIMEOUT_STACK } });
        this.deviceLog([{ level: 'warn', tag: 'System.err', message: JAVA_TIMEOUT_STACK }]);
      },
    });
  }

  private backgroundLog(): void {
    if (!this.running) return;
    const r = this.rng;
    switch (r.weighted<number>([[0, 2], [1, 1.5], [2, 1.5], [3, 1], [4, 1], [5, 0.25]])) {
      case 0:
        this.log('debug', 'Coil', `🧠 Memory cache hit - ${CDN}/products/${r.pick(MARKET_PRODUCTS).id}.png`);
        return;
      case 1:
        this.log('debug', 'LocationProvider', `Konum: ${round(40.99 + r.float(-0.005, 0.005), 4)}, ${round(29.03 + r.float(-0.005, 0.005), 4)} (±${r.int(5, 25)} m)`);
        return;
      case 2:
        this.log('verbose', 'Compose', `Recomposition: StoreListScreen (${r.int(1, 9)} skipped, ${r.int(0, 3)} recomposed)`);
        return;
      case 3:
        this.log('info', 'WorkManager', `Work [ id=${r.uuid()}, tags={ com.mykynk.mahalle.sync.SyncWorker } ] ${r.pick(['SUCCESS', 'SUCCESS', 'RETRY'])}`);
        return;
      case 4:
        this.log('debug', 'Analytics', `event queued: ${r.pick(['view_item', 'scroll', 'select_promotion'])}`);
        return;
      default:
        this.log('warn', 'BatteryOptimizer', 'Arka plan senkronizasyonu ertelendi (Doze modu)');
    }
  }

  /* ───────────── crash & ANR ───────────── */

  private crash(): void {
    if (!this.running) return;
    const pid = this.pid as number;
    this.log('fatal', 'AndroidRuntime', 'java.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} not attached to a context.', {
      kind: 'crash',
      error: { type: 'java.lang.IllegalStateException', message: 'Fragment BasketFragment{4a1c2e9} not attached to a context.', stack: JAVA_BASKET_CRASH_SDK_STACK },
      data: { thread: 'main', screen: 'Basket' },
    });
    this.deviceLog([{ level: 'fatal', tag: 'AndroidRuntime', kind: 'crash', message: JAVA_BASKET_CRASH.replace('{pid}', String(pid)) }]);
    this.after(60, () => {
      this.stop('crash');
      this.deps.sched.after(this.rng.int(5000, 8000), () => this.launch('user'));
    });
  }

  private anr(): void {
    if (!this.running) return;
    const pid = this.pid as number;
    const ss = ANDROID_SYSTEM.systemServer.pid;
    this.jankBoost += 40;
    this.systemLog([
      androidLine(
        ss,
        ss + 40,
        'warn',
        'InputDispatcher',
        `Window '8f2c1a0 com.mykynk.mahalle/com.mykynk.mahalle.ui.MainActivity' is not responding. Waited 5001ms for MotionEvent(deviceId=4, source=TOUCHSCREEN, displayId=0, action=DOWN)`,
      ),
    ]);
    this.after(900, () => {
      this.systemLog([androidAnrLine(ss, 'com.mykynk.mahalle', pid, anrReport('com.mykynk.mahalle', pid, new Date()))]);
      this.after(2500, () => {
        this.deviceLog([{ level: 'info', tag: 'Choreographer', message: `Skipped ${this.rng.int(280, 340)} frames!  The application may be doing too much work on its main thread.` }]);
        this.log('warn', 'MainThreadWatchdog', 'Ana iş parçacığı 5.4 sn bloke kaldı (SharedPreferences.commit ana thread üzerinde)', { data: { blockedMs: 5400, culprit: 'SessionPrefs.save' } });
      });
    });
  }

  resetData(): void {
    this.basket = [];
    this.env = 'staging';
  }
}
