import { describe, expect, it } from 'vitest';
import type { AppSession, ProcessUpdate } from '@durbun/protocol';
import {
  APNS_TEMPLATES,
  IOS_CONTENT_SIZES,
  actionGroups,
  appActionParams,
  batteryBucket,
  baseName,
  builtinLabelId,
  checkInstallFile,
  clampAndroidScale,
  densityScale,
  dumpReply,
  fileExtension,
  filterApps,
  findVmUrl,
  fontScaleMode,
  fontScaleParams,
  formatScale,
  hasAction,
  installAccept,
  installTarget,
  isDumpAction,
  isDumpMessage,
  isReadOnlyDevice,
  logicalSize,
  mediaFileName,
  mediaResult,
  mergeApps,
  nonAsciiChars,
  openUrlParams,
  osLine,
  parseCoordinate,
  parseCoordinatePair,
  parseInstalledApps,
  processRows,
  pushHistory,
  recordDurations,
  recordingExtension,
  templateText,
  urlProblem,
  validateLocation,
  validatePush,
} from './model';

describe('device facts', () => {
  it('density is a scale factor; dpi values are converted (demo reports 420)', () => {
    expect(densityScale(2.625)).toBe(2.625);
    expect(densityScale(3)).toBe(3);
    expect(densityScale(420)).toBe(2.625);
    expect(densityScale(480)).toBe(3);
    expect(densityScale(0)).toBeUndefined();
    expect(densityScale(undefined)).toBeUndefined();
    expect(formatScale(2.625)).toBe('@2.6x');
    expect(formatScale(3)).toBe('@3x');
    expect(formatScale(1.5)).toBe('@1.5x');
    expect(logicalSize({ width: 1080, height: 2400 }, 2.625)).toEqual({ width: 411, height: 914 });
    expect(logicalSize({ width: 1080, height: 2400 }, undefined)).toBeUndefined();
  });
  it('battery buckets and OS line', () => {
    expect(batteryBucket(95)).toBe('full');
    expect(batteryBucket(40)).toBe('medium');
    expect(batteryBucket(10)).toBe('low');
    expect(osLine({ platform: 'android', osVersion: '15', apiLevel: 35 })).toBe('Android 15 · API 35');
    expect(osLine({ platform: 'ios', osVersion: '18.2' })).toBe('iOS 18.2');
    expect(osLine({ platform: 'other' })).toBeUndefined();
  });
  it('actions only for online devices that list them; imported/disconnected devices are read-only', () => {
    expect(hasAction({ state: 'online', actions: ['screenshot'] }, 'screenshot')).toBe(true);
    expect(hasAction({ state: 'offline', actions: ['screenshot'] }, 'screenshot')).toBe(false);
    expect(hasAction({ state: 'online', actions: [] }, 'screenshot')).toBe(false);
    expect(isReadOnlyDevice({ id: 'import:1', state: 'online' })).toBe(true);
    expect(isReadOnlyDevice({ id: 'android:x', state: 'disconnected' })).toBe(true);
    expect(isReadOnlyDevice({ id: 'android:x', state: 'unauthorized' })).toBe(false);
  });
});

describe('open-url', () => {
  it('validates the address', () => {
    expect(urlProblem('')).toBe('empty');
    expect(urlProblem('  ')).toBe('empty');
    expect(urlProblem('pati://pets/42')).toBeNull();
    expect(urlProblem(' https://pati.app/x?y=1 ')).toBeNull();
    expect(urlProblem('pati.app/pets')).toBe('noScheme');
    expect(urlProblem('pati://pets 42')).toBe('spaces');
  });
  it('builds params (target app optional) and keeps a de-duplicated history', () => {
    expect(openUrlParams(' pati://x ')).toEqual({ url: 'pati://x' });
    expect(openUrlParams('pati://x', 'com.mykynk.pati')).toEqual({ url: 'pati://x', appId: 'com.mykynk.pati' });
    expect(openUrlParams('pati://x', '  ')).toEqual({ url: 'pati://x' });
    expect(pushHistory(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushHistory(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
    expect(pushHistory(['a'], '  ')).toEqual(['a']);
  });
});

describe('appearance', () => {
  it('Android font scale: 0.5–2.0 in 0.05 steps', () => {
    expect(clampAndroidScale(1.17)).toBe(1.15);
    expect(clampAndroidScale(0.2)).toBe(0.5);
    expect(clampAndroidScale(5)).toBe(2);
    expect(clampAndroidScale(Number.NaN)).toBe(1);
    expect(fontScaleParams('android', 1.3)).toEqual({ scale: 1.3 });
  });
  it('iOS simulator: content size category + scale capped at 3', () => {
    expect(fontScaleMode({ platform: 'ios' })).toBe('ios');
    expect(fontScaleMode({ platform: 'android' })).toBe('android');
    expect(fontScaleParams('ios', 3)).toEqual({ scale: 1, contentSize: 'large' });
    expect(fontScaleParams('ios', 0)).toEqual({ scale: 0.824, contentSize: 'extra-small' });
    expect(fontScaleParams('ios', 99)).toEqual({ scale: 3, contentSize: 'accessibility-extra-extra-extra-large' });
    expect(IOS_CONTENT_SIZES).toHaveLength(12);
  });
});

describe('input', () => {
  it('lists characters adb input text cannot type', () => {
    expect(nonAsciiChars('Merhaba dünya, şimdi!')).toEqual(['ü', 'ş']);
    expect(nonAsciiChars('hello\nworld')).toEqual([]);
    expect(nonAsciiChars('ıııİ')).toEqual(['ı', 'İ']);
  });
});

describe('location', () => {
  it('parses coordinates with dot or Turkish comma decimals', () => {
    expect(parseCoordinate('41.0082')).toBe(41.0082);
    expect(parseCoordinate('41,0082')).toBe(41.0082);
    expect(parseCoordinate(' -0.1278 ')).toBe(-0.1278);
    expect(parseCoordinate('abc')).toBeUndefined();
    expect(parseCoordinate('')).toBeUndefined();
    expect(parseCoordinatePair('41.0082, 28.9784')).toEqual({ lat: 41.0082, lon: 28.9784 });
    expect(parseCoordinatePair('41,0082; 28,9784')).toEqual({ lat: 41.0082, lon: 28.9784 });
    expect(parseCoordinatePair('37.7749 -122.4194')).toEqual({ lat: 37.7749, lon: -122.4194 });
    expect(parseCoordinatePair('41.0082')).toBeUndefined();
  });
  it('validates ranges', () => {
    expect(validateLocation('41.0082', '28.9784')).toEqual({ lat: 41.0082, lon: 28.9784 });
    expect(validateLocation('91', '0')).toEqual({ error: 'lat' });
    expect(validateLocation('0', '-181')).toEqual({ error: 'lon' });
    expect(validateLocation('x', '0')).toEqual({ error: 'lat' });
  });
});

describe('push notification', () => {
  it('accepts templates and enforces object + aps + 4096 bytes', () => {
    for (const name of Object.keys(APNS_TEMPLATES) as (keyof typeof APNS_TEMPLATES)[]) expect(validatePush(templateText(name)).ok).toBe(true);
    expect(validatePush('{ nope')).toMatchObject({ ok: false, error: 'json' });
    expect(validatePush('[1]')).toEqual({ ok: false, error: 'notObject' });
    expect(validatePush('{"alert":"x"}')).toEqual({ ok: false, error: 'noAps' });
    expect(validatePush('{"aps":"x"}')).toEqual({ ok: false, error: 'noAps' });
    const big = JSON.stringify({ aps: { alert: 'ş'.repeat(2100) } });
    expect(validatePush(big)).toMatchObject({ ok: false, error: 'tooLarge' });
    const ok = validatePush('{ "aps": { "badge": 1 } }');
    expect(ok).toEqual({ ok: true, payload: { aps: { badge: 1 } }, bytes: 19 });
  });
});

describe('screen recording & media', () => {
  it('durations and file extensions per platform', () => {
    expect(recordDurations({ platform: 'android', kind: 'physical' })).toEqual([10, 30, 60, 180]);
    expect(Math.max(...recordDurations({ platform: 'ios', kind: 'simulator' }))).toBe(300);
    expect(recordingExtension({ kind: 'simulator' })).toBe('mov');
    expect(recordingExtension({ kind: 'physical' })).toBe('mp4');
    expect(recordingExtension({ kind: 'emulator' })).toBe('mp4');
  });
  it('file names come from the server path, else a readable generated name', () => {
    expect(baseName('/tmp/durbun/screenshot-pixel-8.png')).toBe('screenshot-pixel-8.png');
    expect(mediaFileName('recording', { kind: 'simulator', name: 'iPhone 16 Pro · Demo' }, new Date(2026, 10, 2, 9, 8, 7).getTime())).toBe('recording-iphone-16-pro-demo-20261102-090807.mov');
    expect(mediaFileName('screenshot', { kind: 'emulator', name: 'Pixel 8' }, 0, '/x/y/shot.png')).toBe('shot.png');
  });
  it('validates screenshot / recording replies', () => {
    expect(mediaResult({ url: '/api/files/a.png', file: '/tmp/a.png', width: 540, height: 1200 })).toEqual({ url: '/api/files/a.png', file: '/tmp/a.png', width: 540, height: 1200 });
    expect(mediaResult({ url: '/api/files/b.mp4' })).toEqual({ url: '/api/files/b.mp4' });
    expect(mediaResult({ file: 'x' })).toBeNull();
    expect(mediaResult(null)).toBeNull();
  });
});

describe('install', () => {
  it('accepts the right package per platform', () => {
    expect(installTarget({ platform: 'android', kind: 'physical' })).toBe('android');
    expect(installTarget({ platform: 'ios', kind: 'simulator' })).toBe('ios-sim');
    expect(installTarget({ platform: 'ios', kind: 'physical' })).toBe('ios-device');
    expect(installAccept('android')).toBe('.apk');
    expect(installAccept('ios-sim')).toBe('.app,.zip');
    expect(fileExtension('Pati-release.APK')).toBe('.apk');
    expect(checkInstallFile({ name: 'app.apk', size: 10 }, 'android')).toEqual({ ok: true });
    expect(checkInstallFile({ name: 'app.apk', size: 0 }, 'android')).toEqual({ ok: false, reason: 'empty' });
    expect(checkInstallFile({ name: 'app.aab', size: 10 }, 'android')).toEqual({ ok: false, reason: 'aab' });
    expect(checkInstallFile({ name: 'Runner.ipa', size: 10 }, 'android')).toEqual({ ok: false, reason: 'wrongPlatform' });
    expect(checkInstallFile({ name: 'Runner.app.zip', size: 10 }, 'ios-sim')).toEqual({ ok: true });
    expect(checkInstallFile({ name: 'Runner.ipa', size: 10 }, 'ios-device')).toEqual({ ok: true });
    expect(checkInstallFile({ name: 'notes.txt', size: 10 }, 'ios-sim')).toEqual({ ok: false, reason: 'unknownType' });
  });
});

describe('apps', () => {
  const session = (id: string, bundle: string, name: string, connected: boolean, version?: string): AppSession => ({
    id,
    sessionKey: id,
    deviceId: 'demo:1',
    sdk: { name: 'demo', version: '1', platform: 'flutter' },
    app: { name, id: bundle, version, debug: true },
    transport: 'demo',
    connected,
    connectedAt: 0,
    capabilities: [],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  });
  it('parses list-apps replies defensively', () => {
    expect(parseInstalledApps([{ id: 'a', name: 'A', version: '1', system: true }, { name: 'no id' }, null, { id: 'b' }])).toEqual([
      { id: 'a', name: 'A', version: '1', debuggable: false, system: true },
      { id: 'b', name: undefined, version: undefined, debuggable: false, system: false },
    ]);
    expect(parseInstalledApps({})).toEqual([]);
  });
  it('merges SDK apps: user apps first, connected SDK apps on top, system apps last', () => {
    const rows = mergeApps(
      [
        { id: 'com.android.chrome', name: 'Chrome' },
        { id: 'com.mykynk.pati', name: 'Pati', version: '2.4.1' },
        { id: 'com.android.settings', name: 'Settings', system: true },
        { id: 'com.mykynk.mahalle', name: 'Mahalle' },
      ],
      [session('app:1', 'com.mykynk.mahalle', 'Mahalle', false), session('app:2', 'com.mykynk.pati', 'Pati', true), session('app:3', 'com.new.sdkonly', 'Yeni', true, '0.1')],
    );
    expect(rows.map((r) => r.id)).toEqual(['com.mykynk.pati', 'com.new.sdkonly', 'com.mykynk.mahalle', 'com.android.chrome', 'com.android.settings']);
    expect(rows.find((r) => r.id === 'com.new.sdkonly')).toMatchObject({ listed: false, sdk: true, connected: true, version: '0.1' });
    expect(rows.find((r) => r.id === 'com.mykynk.pati')).toMatchObject({ listed: true, sdk: true, connected: true, debuggable: true });
    expect(filterApps(rows, 'MAH').map((r) => r.id)).toEqual(['com.mykynk.mahalle']);
    expect(filterApps(rows, 'android').length).toBe(2);
  });
});

describe('app actions', () => {
  it('labels built-ins by id (labelKey === id) and groups in a fixed order', () => {
    expect(builtinLabelId({ id: 'flutter.debugPaint' })).toBe('flutter.debugPaint');
    expect(builtinLabelId({ id: 'x', labelKey: 'android.gc' })).toBe('android.gc');
    expect(builtinLabelId({ id: 'mahalle.environment' })).toBeUndefined();
    const groups = actionGroups([
      { id: 'mahalle.env', kind: 'select', label: 'Env', group: 'app' },
      { id: 'custom', kind: 'button', label: 'X' },
      { id: 'android.gc', kind: 'button', label: 'GC', group: 'android' },
      { id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', group: 'flutter' },
      { id: 'zzz', kind: 'button', label: 'Z', group: 'zeta' },
    ]);
    expect(groups.map((g) => g.group)).toEqual(['flutter', 'android', 'app', 'zeta']);
    expect(groups.find((g) => g.group === 'app')!.actions.map((a) => a.id)).toEqual(['mahalle.env', 'custom']);
  });
  it('params: toggles and selects send { value }, buttons {}', () => {
    expect(appActionParams({ kind: 'toggle' }, true)).toEqual({ value: true });
    expect(appActionParams({ kind: 'toggle' }, 'x')).toEqual({ value: false });
    expect(appActionParams({ kind: 'select' }, 'dark')).toEqual({ value: 'dark' });
    expect(appActionParams({ kind: 'button' }, true)).toEqual({});
  });
  it('dumps: reply text when present, else match the log row', () => {
    expect(dumpReply({ text: 'a\nb', lines: 2 })).toEqual({ text: 'a\nb', lines: 2 });
    expect(dumpReply({ lines: 20 })).toEqual({ text: undefined, lines: 20 });
    expect(dumpReply('x\ny')).toEqual({ text: 'x\ny', lines: 2 });
    expect(dumpReply(null)).toEqual({});
    expect(isDumpAction('flutter.dumpWidgetTree')).toBe(true);
    expect(isDumpAction('ios.dumpUserDefaults')).toBe(true);
    expect(isDumpAction('flutter.debugPaint')).toBe(false);
    const widget = '[root](renderObject: RenderView#1a2b3)\n└View\n └RawView';
    expect(isDumpMessage(widget, 'flutter.dumpWidgetTree')).toBe(true);
    expect(isDumpMessage('Widget tree (3 lines)\na\nb', 'flutter.dumpWidgetTree')).toBe(true);
    expect(isDumpMessage('one\ntwo\nthree\nfour', 'custom.dump', 4)).toBe(true);
    expect(isDumpMessage('one\ntwo\nthree\nfour', 'custom.dump', 40)).toBe(false);
    expect(isDumpMessage('short', 'flutter.dumpWidgetTree')).toBe(false);
  });
});

describe('Dart VM Service input', () => {
  it('finds the service URL in pasted text', () => {
    expect(findVmUrl('http://127.0.0.1:50123/AbCdEf=/')).toBe('http://127.0.0.1:50123/AbCdEf=/');
    const run = [
      'Launching lib/main.dart on Pixel 8 in debug mode...',
      'A Dart VM Service on Pixel 8 is available at: http://127.0.0.1:61234/pQ8x3W_XyZ0=/',
      'The Flutter DevTools debugger and profiler on Pixel 8 is available at: http://127.0.0.1:9100?uri=http://127.0.0.1:61234/pQ8x3W_XyZ0=/',
    ].join('\n');
    expect(findVmUrl(run)).toBe('http://127.0.0.1:61234/pQ8x3W_XyZ0=/');
    expect(findVmUrl('http://127.0.0.1:9100/?uri=ws%3A%2F%2F127.0.0.1%3A61234%2Fabc%3D%2Fws')).toBe('ws://127.0.0.1:61234/abc=/ws');
    expect(findVmUrl('nothing here')).toBeUndefined();
  });
});

describe('processes', () => {
  const p = (pid: number, name: string, event: ProcessUpdate['event'] = 'seen'): ProcessUpdate => ({ deviceId: 'demo:1', pid, name, event, ts: 0 });
  const byPid = { 1: p(1, 'init'), 1043: p(1043, 'system_server'), 8421: p(8421, 'com.mykynk.pati'), 7000: p(7000, 'com.old', 'died') };
  const sessions = [{ app: { pid: 8421, name: 'Pati', id: 'com.mykynk.pati' }, connected: true }] as unknown as AppSession[];
  it('app processes first, exited ones hidden unless asked, search by name or pid prefix', () => {
    const r = processRows(byPid, sessions, '', false);
    expect(r.rows.map((x) => x.pid)).toEqual([8421, 1, 1043]);
    expect(r.rows[0]!.appName).toBe('Pati');
    expect(r).toMatchObject({ total: 4, died: 1 });
    expect(processRows(byPid, sessions, '', true).rows.map((x) => x.pid)).toEqual([8421, 1, 1043, 7000]);
    expect(processRows(byPid, sessions, 'SYSTEM', false).rows.map((x) => x.pid)).toEqual([1043]);
    expect(processRows(byPid, sessions, '10', false).rows.map((x) => x.pid)).toEqual([1043]);
    expect(processRows(undefined, [], '', false)).toEqual({ rows: [], total: 0, died: 0 });
  });
});
