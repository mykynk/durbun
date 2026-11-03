/**
 * "Kumbara" in debug on the iOS simulator — the team's savings-goals Flutter app, which has no Dürbün SDK
 * (its store / TestFlight builds run on the Pixel and the USB iPhone). A developer started it with `flutter run`,
 * so Dürbün reaches it through the Dart VM service without any integration (SPEC §5.6): logs, dart:io
 * requests, heap / frame metrics and the Flutter debug toggles — but no mock rules and no analytics events.
 * This is the demo's «VM Service» source.
 */
import type { AppActionDescriptor, Header } from '@durbun/protocol';
import { SERVER_VERSION } from '../version';
import { type AppDeps, type CommandOutcome, DemoApp, type StopReason } from './appSim';
import { IOS_SYSTEM } from './devices';
import { type FailureKind, json } from './http';
import { iosLine } from './noise';
import { round, Walk } from './rng';

const BUNDLE = 'com.mykynk.kumbara';
const API = 'https://api.kumbara.app/v1';
const VERSION = '3.2.0';
const BUILD = '320';

type Toggle = 'debugPaint' | 'slowAnimations' | 'performanceOverlay';
const TOGGLES: Record<Toggle, [label: string, flag: string]> = {
  debugPaint: ['Debug paint', 'debugPaintSizeEnabled'],
  slowAnimations: ['Slow animations', 'timeDilation'],
  performanceOverlay: ['Performance overlay', 'showPerformanceOverlay'],
};

const GOALS = [
  { id: 11, name: 'Tatil fonu', target: 40_000 },
  { id: 12, name: 'Yeni bisiklet', target: 18_500 },
  { id: 13, name: 'Acil durum', target: 25_000 },
];

export class KumbaraDebugIos extends DemoApp {
  private toggles: Record<Toggle, boolean> = { debugPaint: false, slowAnimations: false, performanceOverlay: false };
  private readonly saved = new Map<number, number>([
    [11, 16_480],
    [12, 9_200],
    [13, 21_750],
  ]);
  private readonly memory = new Walk(171, 176, 0.04, 1.2, 120, 360);
  private heap = 29;
  private jank = 0;
  private refreshed = false;

  constructor(deps: AppDeps) {
    super(
      deps,
      {
        name: 'Kumbara',
        bundleId: BUNDLE,
        version: VERSION,
        build: BUILD,
        processName: 'Runner',
        // What the Flutter VM module says about itself (platform/flutterVm/session.ts).
        sdk: { name: 'durbun-vm-service', version: SERVER_VERSION, platform: 'dart-vm' },
        source: 'dart:io',
        capabilities: ['logs', 'metrics', 'commands', 'network'],
        device: { model: 'iPhone17,1', name: 'iPhone 16 Pro', osVersion: '18.2', manufacturer: 'Apple' },
        transport: 'vm-service',
      },
      51_377,
    );
  }

  actions(): AppActionDescriptor[] {
    return [
      ...(Object.keys(TOGGLES) as Toggle[]).map(
        (key): AppActionDescriptor => ({ id: `flutter.${key}`, kind: 'toggle', label: TOGGLES[key][0], labelKey: `flutter.${key}`, group: 'flutter', value: this.toggles[key] }),
      ),
      { id: 'flutter.dumpWidgetTree', kind: 'button', label: 'Dump widget tree', labelKey: 'flutter.dumpWidgetTree', group: 'flutter' },
    ];
  }

  protected onCommand(name: string, params: Record<string, unknown>): CommandOutcome {
    const key = name.startsWith('flutter.') ? (name.slice('flutter.'.length) as Toggle) : undefined;
    if (key && key in TOGGLES) {
      const value = typeof params.value === 'boolean' ? params.value : !this.toggles[key];
      this.toggles[key] = value;
      this.log('info', 'flutter.tools', `${TOGGLES[key][0]} ${value ? 'açıldı' : 'kapatıldı'} (${TOGGLES[key][1]} = ${key === 'slowAnimations' ? (value ? '5.0' : '1.0') : value})`);
      this.publishActions();
      return { ok: true, data: { value } };
    }
    if (name === 'flutter.dumpWidgetTree') {
      const dump = 'KumbaraApp\n└MaterialApp\n └GoalsPage\n  └ListView(3 GoalCard)';
      this.deviceLog([{ level: 'info', tag: 'flutter', message: dump }]);
      return { ok: true, data: { text: dump } };
    }
    return { ok: false, error: `Unknown command ${name}` };
  }

  protected onProcessStart(): void {
    const pid = this.pid as number;
    const rb = IOS_SYSTEM.runningboardd.pid;
    const label = `app<${BUNDLE}(${this.rng.uuid(true)})>:${pid}`;
    this.systemLog([
      iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', 'process', `[${label}] is not RunningBoard jetsam managed.`),
      iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[${label}] Bootstrap success!`),
    ]);
    // `flutter run` prints the service URL; the app announces it in its own log too (that is what Dürbün reads).
    const port = 49_152 + (pid % 16_000);
    this.after(90, () =>
      this.deviceLog([
        { level: 'info', tag: 'flutter', message: '[IMPORTANT:flutter/shell/platform/darwin/ios/ios_context_metal_impeller.mm(42)] Using the Impeller rendering backend (Metal).' },
        { level: 'info', tag: 'flutter', message: `The Dart VM service is listening on http://127.0.0.1:${port}/${this.rng.base64url(8)}=/` },
      ]),
    );
  }

  protected onProcessEnd(reason: StopReason): void {
    const pid = this.pid as number;
    this.systemLog([
      iosLine(IOS_SYSTEM.springboard.pid, 'SpringBoard', 'info', 'com.apple.FrontBoard', 'Process', `[app<${BUNDLE}>:${pid}] Process exited: <RBSProcessExitContext| ${reason === 'crash' ? 'specific' : 'voluntary'}>.`),
    ]);
  }

  protected onRunning(firstLaunch: boolean): void {
    this.log('info', 'main', `Kumbara ${VERSION} (${BUILD}) başlatılıyor — flavor: dev, mod: debug`, { data: { flavor: 'dev', buildMode: 'debug', flutter: '3.38.1' } });
    this.after(180, () => this.loadGoals());
    this.every(4_200, () => this.chatter());
    this.periodically(11_000, 19_000, () => this.loadGoals());
    this.periodically(25_000, 40_000, () => this.deposit(), firstLaunch ? 9_000 : undefined);
  }

  private loadGoals(): void {
    if (!this.running) return;
    const expired = this.refreshed === false && this.rng.chance(0.25);
    if (expired) {
      // An expired session: the app refreshes its token and asks again.
      this.refreshed = true;
      this.http.request({
        method: 'GET',
        url: `${API}/goals`,
        response: { status: 401, body: json({ error: 'token_expired' }) },
        latencyMs: this.rng.int(80, 160),
        then: () => {
          this.log('warn', 'auth', 'Oturum süresi doldu, token yenileniyor');
          this.http.request({
            method: 'POST',
            url: `${API}/auth/refresh`,
            body: json({ refreshToken: `rt_${this.rng.base64url(18)}` }),
            response: { status: 200, body: json({ accessToken: `at_${this.rng.base64url(24)}`, expiresIn: 3600 }) },
            latencyMs: this.rng.int(120, 260),
            then: () => this.loadGoals(),
          });
        },
      });
      return;
    }
    this.http.request({
      method: 'GET',
      url: `${API}/goals`,
      response: { status: 200, body: json({ goals: GOALS.map((g) => ({ ...g, saved: this.saved.get(g.id) ?? 0, currency: 'TRY' })) }) },
      latencyMs: this.rng.int(70, 240),
      then: (o) => {
        if (o.status === 200) this.deviceLog([{ level: 'info', tag: 'flutter', message: `💰 GoalRepository.fetch → ${GOALS.length} hedef (${o.durationMs} ms)` }]);
      },
    });
  }

  private deposit(): void {
    if (!this.running) return;
    const goal = this.rng.pick(GOALS);
    const amount = this.rng.pick([100, 250, 500]);
    this.http.request({
      method: 'POST',
      url: `${API}/goals/${goal.id}/deposits`,
      body: json({ amount, currency: 'TRY' }),
      response: { status: 201, body: json({ id: this.rng.int(9000, 9999), goalId: goal.id, amount }) },
      latencyMs: this.rng.int(140, 380),
      then: (o) => {
        if (o.status !== 201) return;
        this.saved.set(goal.id, (this.saved.get(goal.id) ?? 0) + amount);
        const pct = Math.round(((this.saved.get(goal.id) ?? 0) / goal.target) * 100);
        this.log('info', 'goals', `${goal.name}: ${amount} ₺ eklendi (%${pct})`, { data: { goalId: goal.id, amount, percent: pct } });
        this.jank += 2;
      },
    });
  }

  private chatter(): void {
    if (!this.running) return;
    const pick = this.rng.weighted<() => void>([
      [() => this.log('debug', 'goals', `Hedef ilerlemesi hesaplandı (Tatil fonu %${Math.round(((this.saved.get(11) ?? 0) / 40_000) * 100)})`), 1],
      [() => this.deviceLog([{ level: 'info', tag: 'flutter', message: `GoalsPage: rebuild (${this.rng.int(1, 3)} widgets)` }]), 1],
      [() => this.log('debug', 'cache', `Hive: "goals" kutusu senkronlandı (${GOALS.length} kayıt)`), 0.6],
    ]);
    pick();
  }

  protected metric(): Record<string, number> {
    this.heap += this.rng.float(0.1, 0.9);
    if (this.heap > 64) this.heap = this.rng.float(26, 32);
    const jank = Math.round(this.jank + (this.rng.chance(0.2) ? 1 : 0));
    this.jank *= 0.4;
    const slow = this.toggles.slowAnimations ? 1.15 : 1;
    // The VM service gives heap, RSS and frame timings; no CPU or threads.
    return {
      memoryMB: round(this.memory.step(this.rng)),
      heapMB: round(this.heap),
      fps: round(Math.max(30, 120 - jank * this.rng.float(1, 2.4) - this.rng.float(0, 2))),
      jankyFrames: jank,
      frameBuildMs: round((8.3 * this.rng.float(0.2, 0.45) + jank * 0.8) * slow),
      frameRasterMs: round((8.3 * this.rng.float(0.25, 0.5) + jank * 1.2 + (this.toggles.performanceOverlay ? 1.6 : 0)) * slow),
    };
  }

  protected baseHeaders(url: URL): Header[] {
    const headers: Header[] = [
      ['user-agent', 'Dart/3.10 (dart:io)'],
      ['accept-encoding', 'gzip'],
    ];
    if (url.hostname === 'api.kumbara.app') {
      headers.push(['accept', 'application/json'], ['accept-language', 'tr-TR'], ['x-app-version', `${VERSION}+${BUILD}`]);
    }
    return headers;
  }

  protected errorText(kind: FailureKind, host: string, url: string): string {
    switch (kind) {
      case 'timeout':
        return 'TimeoutException after 0:00:15.000000: Future not completed';
      case 'connection':
        return `SocketException: Connection refused (OS Error: Connection refused, errno = 61), address = ${host}, port = ${this.rng.int(49152, 65000)}`;
      case 'dns':
        return `SocketException: Failed host lookup: '${host}' (OS Error: nodename nor servname provided, or not known, errno = 8)`;
      case 'tls':
        return 'HandshakeException: Handshake error in client (OS Error: CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate(handshake.cc:393))';
      case 'reset':
        return `HttpException: Connection closed before full header was received, uri = ${url}`;
    }
  }
}
