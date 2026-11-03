/**
 * Background "system noise" for the demo devices: logcat-style lines from Android system processes and
 * unified-log-style lines from iOS daemons, shaped like what the real platform drivers produce.
 */
import type { LogLevel } from '@durbun/protocol';
import type { DeviceLogInput } from '../types';
import { GMS_BROKER_ERROR } from './content';
import { ANDROID_SYSTEM as A, IOS_SYSTEM as I } from './devices';
import type { Rng } from './rng';

export interface ForegroundApp {
  pid: number;
  /** Android package / iOS bundle id. */
  bundleId: string;
  /** Android activity short name, e.g. ".MainActivity". */
  activity: string;
}

export function androidLine(pid: number, tid: number, level: LogLevel, tag: string, message: string, ts = Date.now()): DeviceLogInput {
  return { ts, level, tag, message, pid, tid };
}

/**
 * An ActivityManager "ANR in <pkg>" report as the Android driver emits it (platform/android/logcat.ts
 * AndroidCrashGrouper): the row is the app's (pid from the report's "PID:" line, process = the package), the
 * reporting system_server pid goes to data.reporterPid, data.package names the app.
 */
export function androidAnrLine(systemServerPid: number, pkg: string, appPid: number, report: string, ts = Date.now()): DeviceLogInput {
  return {
    ts,
    level: 'error',
    tag: 'ActivityManager',
    message: report,
    pid: appPid,
    process: pkg,
    kind: 'anr',
    data: { reporterPid: systemServerPid, package: pkg },
  };
}

export function iosLine(
  pid: number,
  process: string,
  level: LogLevel,
  subsystem: string,
  category: string,
  message: string,
  ts = Date.now(),
): DeviceLogInput {
  const entry: DeviceLogInput = { ts, level, tag: subsystem || process, message, pid, process };
  if (subsystem) entry.subsystem = subsystem;
  if (category) entry.category = category;
  return entry;
}

type Gen = () => DeviceLogInput[];

export class AndroidNoise {
  private binderSeq = 0;
  private finskySeq = 2000;

  constructor(
    private readonly rng: Rng,
    private readonly foreground: () => ForegroundApp | undefined,
    private readonly batteryLevel: () => number = () => 87,
  ) {}

  /** One "event" worth of lines (usually one, sometimes a small burst). */
  next(): DeviceLogInput[] {
    const fg = this.foreground();
    const gens: [Gen, number][] = [
      [() => this.chatty(), 2.5],
      [() => this.finsky(), 1.5],
      [() => this.healthd(), 0.12],
      [() => this.backCallback(), 0.9],
      [() => this.connectivity(fg), 0.8],
      [() => this.killCached(), 0.35],
      [() => this.gmsBroker(), 0.06],
      [() => this.binderProxy(), 0.4],
      [() => this.processStats(), 0.3],
      [() => this.fgsDisallowed(), 0.3],
      [() => this.lmkd(), 0.12],
    ];
    if (fg) {
      gens.push(
        [() => this.touch(fg), 1.2],
        [() => this.trafficStats(fg), 1.2],
        [() => this.libcProperty(fg), 0.1],
        [() => this.ime(fg), 0.6],
        [() => this.relayout(fg), 0.5],
      );
    }
    return this.rng.weighted(gens)();
  }

  private tid(pid: number) {
    return pid + this.rng.int(1, 60);
  }

  private chatty(): DeviceLogInput[] {
    const ss = A.systemServer.pid;
    const n = this.rng.int(2, 9);
    const thread = this.rng.pick([`Binder:${ss}_${this.rng.int(1, 9).toString(16).toUpperCase()}`, 'android.bg', 'PowerManagerSer', 'ActivityManager']);
    return [androidLine(ss, this.tid(ss), 'info', 'chatty', `uid=1000(system) ${thread} identical ${n} lines`)];
  }

  private finsky(): DeviceLogInput[] {
    const p = A.vending.pid;
    this.finskySeq += this.rng.int(1, 4);
    return [
      androidLine(
        p,
        this.tid(p),
        'info',
        'Finsky',
        `[${this.rng.int(2, 90)}] kxi.run(5): Stats for Executor: BlockingExecutor kzr@${this.rng.hex(7)}[Running, pool size = 1, active threads = 1, queued tasks = 0, completed tasks = ${this.finskySeq}]`,
      ),
    ];
  }

  private healthd(): DeviceLogInput[] {
    const level = Math.round(this.batteryLevel());
    return [
      androidLine(
        A.healthd.pid,
        A.healthd.pid,
        'warn',
        'healthd',
        `battery l=${level} v=${this.rng.int(4180, 4290)} t=${(24 + this.rng.next() * 3).toFixed(1)} h=2 st=2 c=-${this.rng.int(800, 1500)} fc=4000000 cc=0 chg=a`,
      ),
    ];
  }

  private backCallback(): DeviceLogInput[] {
    const ss = A.systemServer.pid;
    return [
      androidLine(
        ss,
        this.tid(ss),
        'debug',
        'CoreBackPreview',
        `Window{${this.rng.hex(7)} u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}: Setting back callback OnBackInvokedCallbackInfo{mCallback=android.window.IOnBackInvokedCallback$Stub$Proxy@${this.rng.hex(7)}, mPriority=0, mIsAnimationCallback=false}`,
      ),
    ];
  }

  private connectivity(fg: ForegroundApp | undefined): DeviceLogInput[] {
    const ss = A.systemServer.pid;
    const uid = fg ? 10234 : 10156;
    const pkg = fg?.bundleId ?? 'com.google.android.apps.photos';
    const pid = fg?.pid ?? A.photos.pid;
    return [
      androidLine(
        ss,
        this.tid(ss),
        'debug',
        'ConnectivityService',
        `requestNetwork for uid/pid:${uid}/${pid} activeRequest: null callbackRequest: ${this.rng.int(300, 900)} [NetworkRequest [ REQUEST id=${this.rng.int(300, 900)}, [ Capabilities: INTERNET&NOT_RESTRICTED&TRUSTED&NOT_VCN_MANAGED Uid: ${uid} RequestorUid: ${uid} RequestorPkg: ${pkg} UnderlyingNetworks: Null] ]] callback flags: 0 order: 2147483647 isUidTracked: false declaredMethods: AVAIL|LOST`,
      ),
    ];
  }

  private killCached(): DeviceLogInput[] {
    const ss = A.systemServer.pid;
    const victim = this.rng.pick([
      ['com.google.android.apps.photos', 10156],
      ['com.google.android.youtube', 10171],
      ['com.android.chrome', 10133],
      ['com.google.android.apps.maps', 10162],
    ] as const);
    return [
      androidLine(
        ss,
        this.tid(ss),
        'info',
        'ActivityManager',
        `Killing ${this.rng.int(4000, 7900)}:${victim[0]}/u0a${victim[1] - 10000} (adj ${this.rng.pick([905, 935, 955, 975, 999])}): empty #${this.rng.int(17, 32)}`,
      ),
    ];
  }

  private gmsBroker(): DeviceLogInput[] {
    const p = A.gms.pid;
    return [androidLine(p, this.tid(p), 'error', 'GoogleApiManager', GMS_BROKER_ERROR)];
  }

  private binderProxy(): DeviceLogInput[] {
    const p = this.rng.pick([A.systemui.pid, A.launcher.pid, A.gmsPersistent.pid]);
    return [androidLine(p, this.tid(p), 'info', 'BpBinder', 'onLastStrongRef automatically unlinking death recipients: <uncached descriptor>')];
  }

  private processStats(): DeviceLogInput[] {
    const ss = A.systemServer.pid;
    return [androidLine(ss, this.tid(ss), 'info', 'ProcessStatsService', `Prepared write state in ${this.rng.int(1, 9)}ms`)];
  }

  private fgsDisallowed(): DeviceLogInput[] {
    const ss = A.systemServer.pid;
    return [
      androidLine(
        ss,
        this.tid(ss),
        'warn',
        'ActivityManager',
        'Background started FGS: Disallowed [callingPackage: com.google.android.gms; callingUid: 10120; uidState: CEM ; uidBFSL: n/a; intent: Intent { act=com.google.android.gms.chimera.IntentOperation.TARGETED_INTENT cmp=com.google.android.gms/.chimera.PersistentIntentOperationService }; code:DENIED; tempAllowListReason:<null>; targetSdkVersion:35; callerTargetSdkVersion:35; startForegroundCount:0]',
      ),
    ];
  }

  private lmkd(): DeviceLogInput[] {
    return [
      androidLine(
        A.lmkd.pid,
        A.lmkd.pid,
        'info',
        'lowmemorykiller',
        `Kill 'com.google.android.apps.photos' (${A.photos.pid}), uid 10156, oom_score_adj 975 to free ${this.rng.int(60000, 120000)}kB rss, ${this.rng.int(20000, 40000)}kB swap; reason: low watermark is breached and swap is low (${this.rng.int(5000, 9000)}kB < 314572kB)`,
      ),
    ];
  }

  private touch(fg: ForegroundApp): DeviceLogInput[] {
    const tid = fg.pid;
    const hex = this.rng.hex(7);
    const now = Date.now();
    return [
      androidLine(fg.pid, tid, 'info', 'ViewRootImpl', `ViewRootImpl@${hex}[MainActivity]: ViewPostIme pointer 0`, now),
      androidLine(fg.pid, tid, 'info', 'ViewRootImpl', `ViewRootImpl@${hex}[MainActivity]: ViewPostIme pointer 1`, now + this.rng.int(60, 180)),
    ];
  }

  private trafficStats(fg: ForegroundApp): DeviceLogInput[] {
    return [androidLine(fg.pid, fg.pid + this.rng.int(20, 40), 'debug', 'TrafficStats', `tagSocket(${this.rng.int(90, 260)}) with statsTag=0xffffffff, statsUid=-1`)];
  }

  private libcProperty(fg: ForegroundApp): DeviceLogInput[] {
    return [androidLine(fg.pid, fg.pid, 'warn', 'libc', 'Access denied finding property "ro.vendor.df.effect.conflict"')];
  }

  private ime(fg: ForegroundApp): DeviceLogInput[] {
    const id = this.rng.hex(8);
    return [
      androidLine(fg.pid, fg.pid, 'info', 'ImeTracker', `${fg.bundleId}:${id}: onRequestShow at ORIGIN_CLIENT reason SHOW_SOFT_INPUT fromUser false`),
      androidLine(
        fg.pid,
        fg.pid,
        'debug',
        'InputMethodManager',
        `showSoftInput() view=io.flutter.embedding.android.FlutterView{${this.rng.hex(7)} VFE...... .F...... 0,0-1080,2337 #1 id/flutter_view} flags=0 reason=SHOW_SOFT_INPUT`,
      ),
      androidLine(A.ime.pid, A.ime.pid, 'info', 'ImeTracker', `${fg.bundleId}:${id}: onShown`),
    ];
  }

  private relayout(fg: ForegroundApp): DeviceLogInput[] {
    return [
      androidLine(
        fg.pid,
        fg.pid,
        'debug',
        'ViewRootImpl',
        `ViewRootImpl@${this.rng.hex(7)}[MainActivity]: Relayout returned: old=(0,0,1080,2400) new=(0,0,1080,2400) req=(1080,2400)0 dur=${this.rng.int(3, 14)} res=0x0 s={true 0xb400007a2d0f${this.rng.hex(4)}} ch=false seqId=0`,
      ),
    ];
  }
}

/** The daemons iOS noise lines come from (pids differ between the simulator and a physical iPhone). */
export type IosNoiseDaemons = Record<'backboardd' | 'mdns' | 'nsurlsessiond' | 'locationd' | 'springboard' | 'runningboardd' | 'tccd', { pid: number }>;

/** Where app bundles live: inside the simulator's data folder on the Mac, or on the phone itself. */
const SIM_BUNDLE_ROOT = '/Users/deniz/Library/Developer/CoreSimulator/Devices/5E1D3A7B-2C4F-4B8E-9A61-0D7F3C2B1A90/data/Containers/Bundle/Application';
export const DEVICE_BUNDLE_ROOT = '/private/var/containers/Bundle/Application';

export class IosNoise {
  private connSeq = 2;
  private resolverSeq = 40;
  private readonly d: IosNoiseDaemons;
  private readonly bundleRoot: string;

  constructor(
    private readonly rng: Rng,
    private readonly foreground: () => ForegroundApp | undefined,
    /** Stable bundle container UUID for runningboard lines. */
    private readonly appUuid: string,
    /** Defaults: the simulator's daemons and bundle folder. */
    opts: { daemons?: IosNoiseDaemons; bundleRoot?: string } = {},
  ) {
    this.d = opts.daemons ?? I;
    this.bundleRoot = opts.bundleRoot ?? SIM_BUNDLE_ROOT;
  }

  next(): DeviceLogInput[] {
    const fg = this.foreground();
    const gens: [Gen, number][] = [
      [() => this.hid(), 1.6],
      [() => this.mdns(fg), 0.7],
      [() => this.locationd(fg), 0.7],
      [() => this.xpc(fg), 0.8],
      [() => this.springboard(fg), 0.6],
      [() => this.sqlite(), 0.15],
    ];
    if (fg) {
      gens.push(
        [() => this.uiEvent(fg), 1.2],
        [() => this.runningboard(fg), 1.3],
        [() => this.unconnectedEndpoint(fg), 0.22],
        [() => this.prefs(fg), 0.1],
        [() => this.tcc(fg), 0.15],
      );
    }
    return this.rng.weighted(gens)();
  }

  private app(fg: ForegroundApp) {
    return `app<${fg.bundleId}(${this.appUuid})>:${fg.pid}`;
  }

  private hid(): DeviceLogInput[] {
    return [
      iosLine(
        this.d.backboardd.pid,
        'backboardd',
        'debug',
        'com.apple.BackBoard',
        'HID',
        `[HID] [MT] dispatchEvent Dispatching event with 1 children, _eventMask=0x23 _childEventMask=0x3 Cancel=0 Touching=${this.rng.int(0, 1)} inRange=1 (deviceID 0x200000001)`,
      ),
    ];
  }

  private mdns(fg: ForegroundApp | undefined): DeviceLogInput[] {
    const r = ++this.resolverSeq;
    const hash = this.rng.hex(8).toUpperCase();
    const client = fg ? `${fg.pid} (Runner)` : `${this.d.nsurlsessiond.pid} (nsurlsessiond)`;
    const now = Date.now();
    return [
      iosLine(this.d.mdns.pid, 'mDNSResponder', 'info', 'com.apple.mDNSResponder', 'Default', `[R${r}] getaddrinfo start -- flags: 0xC000D000, ifindex: 0, protocols: 0, hostname: <mask.hash: '${hash}'>, options: 0x0 {}, client pid: ${client}`, now),
      iosLine(this.d.mdns.pid, 'mDNSResponder', 'info', 'com.apple.mDNSResponder', 'Default', `[R${r}] getaddrinfo stop -- hostname: <mask.hash: '${hash}'>, client pid: ${client}, duration: 0.0${this.rng.int(12, 89)}s`, now + this.rng.int(10, 80)),
    ];
  }

  private locationd(fg: ForegroundApp | undefined): DeviceLogInput[] {
    const client = fg?.bundleId ?? 'com.apple.weather';
    const message = this.rng.chance(0.5)
      ? `{"msg":"client authorization status", "Client":"${client}:", "AuthorizationStatus":"kCLAuthorizationStatusAuthorizedWhenInUse(4)", "Accuracy":"full"}`
      : `{"msg":"CLLocationManager", "event":"activity", "_cmd":"requestLocation", "client":"${client}", "desiredAccuracy":-1, "distanceFilter":-1, "hasLocation":true}`;
    return [iosLine(this.d.locationd.pid, 'locationd', 'info', 'com.apple.locationd.Core', 'Client', message)];
  }

  private xpc(fg: ForegroundApp | undefined): DeviceLogInput[] {
    const pid = fg?.pid ?? this.d.springboard.pid;
    const proc = fg ? 'Runner' : 'SpringBoard';
    const name = this.rng.pick(['com.apple.cfprefsd.daemon', 'com.apple.lsd.mapdb', 'com.apple.coremedia.routingcontext.xpc', 'com.apple.UIKit.KeyboardManagement.hosted']);
    return [iosLine(pid, proc, 'debug', 'com.apple.xpc', '', `[0x6000${this.rng.hex(8)}] activating connection: mach=true listener=false peer=false name=${name}`)];
  }

  private springboard(fg: ForegroundApp | undefined): DeviceLogInput[] {
    const scene = fg ? `${fg.bundleId}-default` : 'com.apple.springboard';
    return [
      iosLine(
        this.d.springboard.pid,
        'SpringBoard',
        'info',
        'com.apple.FrontBoard',
        'Scene',
        `[sceneID:${scene}] Sending action(s) in update: UIOpenURLAction=0, BSAction=${this.rng.int(1, 2)}`,
      ),
    ];
  }

  private sqlite(): DeviceLogInput[] {
    return [iosLine(this.d.springboard.pid, 'SpringBoard', 'error', 'com.apple.libsqlite3', 'logging', 'cannot open file at line 49446 of [1b37c146ee]')];
  }

  private uiEvent(fg: ForegroundApp): DeviceLogInput[] {
    const ptr = `0x6000${this.rng.hex(8)}`;
    const now = Date.now();
    return [
      iosLine(fg.pid, 'Runner', 'debug', 'com.apple.UIKit', 'EventDispatch', `Evaluating dispatch of UIEvent: ${ptr}; type: 0; subtype: 0; backing type: 11; shouldSend: 1; ignoreInteractionEvents: 0, systemGestureStateChange: 0`, now),
      iosLine(fg.pid, 'Runner', 'debug', 'com.apple.UIKit', 'EventDispatch', `Sending UIEvent type: 0; subtype: 0; to window: <UIWindow: 0x10380f520>; contextId: 0x6A1F3B2C`, now + 1),
    ];
  }

  private runningboard(fg: ForegroundApp): DeviceLogInput[] {
    const rb = this.d.runningboardd.pid;
    const variants = [
      `Calculated state for ${this.app(fg)}: running-active (role: UserInteractiveFocal) (endowments: <private>)`,
      `[${this.app(fg)}] Set jetsam priority to 100 [0] flag[1]`,
      `Acquiring assertion targeting [${this.app(fg)}] from originator [osservice<com.apple.SpringBoard>:${this.d.springboard.pid}] with description <RBSAssertionDescriptor| "FBScene" ID:${rb}-${this.d.springboard.pid}-${this.rng.int(1000, 9999)} target:${fg.pid} attributes:[<RBSDomainAttribute| domain:"com.apple.frontboard" name:"Visibility" sourceEnvironment:"(null)">]>`,
    ];
    return [iosLine(rb, 'runningboardd', 'info', 'com.apple.runningboard', this.rng.pick(['monitor', 'process', 'assertion']), this.rng.pick(variants))];
  }

  private unconnectedEndpoint(fg: ForegroundApp): DeviceLogInput[] {
    this.connSeq += this.rng.int(0, 1);
    return [
      iosLine(
        fg.pid,
        'Runner',
        'error',
        'com.apple.network',
        'connection',
        `nw_connection_copy_connected_local_endpoint_block_invoke [C${this.connSeq}] Client called nw_connection_copy_connected_local_endpoint on unconnected nw_connection`,
      ),
    ];
  }

  private prefs(fg: ForegroundApp): DeviceLogInput[] {
    return [
      iosLine(
        fg.pid,
        'Runner',
        'error',
        'com.apple.defaults',
        'User Defaults',
        `Couldn't read values in CFPrefsPlistSource<0x6000${this.rng.hex(8)}> (Domain: group.${fg.bundleId}, User: kCFPreferencesAnyUser, ByHost: Yes, Container: (null), Contents Need Refresh: Yes): Using kCFPreferencesAnyUser with a container is only allowed for System Containers, detaching from cfprefsd`,
      ),
    ];
  }

  private tcc(fg: ForegroundApp): DeviceLogInput[] {
    return [
      iosLine(
        this.d.tccd.pid,
        'tccd',
        'info',
        'com.apple.TCC',
        'access',
        `AUTHREQ_ATTRIBUTION: msgID=${fg.pid}.${this.rng.int(1, 40)}, attribution={responsible={TCCDProcess: identifier=${fg.bundleId}, pid=${fg.pid}, auid=501, euid=501, binary_path=${this.bundleRoot}/${this.appUuid}/Runner.app/Runner}}, service=kTCCServicePhotos`,
      ),
    ];
  }
}
