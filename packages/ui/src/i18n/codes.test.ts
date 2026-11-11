import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_NODE_SPECS } from '@durbun/protocol';
import { messageKeys, setLanguage, type Lang } from './core';
import {
  LOCAL_CODES,
  SERVER_CODES,
  allServerCodes,
  deviceDisplayName,
  deviceStateText,
  driverStatusText,
  errorDetail,
  errorText,
  logStatusText,
  tCodeIn,
} from './codes';
import './foundation';

const LANGS: Lang[] = ['tr', 'en'];
const FALLBACK = '«server english»';

afterAll(() => setLanguage('en'));

/** Realistic params, as the real server sends them (captured from `durbun --demo` + the server source). */
const SYSTEM_SAMPLES: [code: string, params: Record<string, string | number>][] = [
  ['device.connected', { device: 'Pixel 8 · Demo', deviceId: 'demo:1', platform: 'android', kind: 'emulator', connection: 'local', osVersion: '15' }],
  ['device.connected', { device: 'Yusuf’un iPhone’u', deviceId: 'ios:00008120-001A', platform: 'ios', kind: 'physical', connection: 'usb', osVersion: '18.1' }],
  ['device.connected', { device: 'Galaxy S23', deviceId: 'android:192.168.1.40:5555', platform: 'android', kind: 'physical', connection: 'wifi', osVersion: '' }],
  ['device.connected', { device: 'Network device', deviceId: 'net:other-unknown-unknown', platform: 'other', kind: 'physical', connection: 'local', osVersion: '' }],
  ['device.disconnected', { device: 'iPhone 16 Pro', deviceId: 'ios-sim:5E1D', state: 'disconnected', detail: 'Simulator shut down' }],
  ['device.disconnected', { device: 'Galaxy S23', deviceId: 'android:R5CW', state: 'offline', detail: 'adb reports the device as offline — reconnect the cable or run "adb kill-server".' }],
  ['device.disconnected', { device: 'Pixel 7', deviceId: 'android:2A1', state: 'unauthorized', detail: 'Unlock the device and accept the "Allow USB debugging?" prompt (RSA key fingerprint).' }],
  ['device.disconnected', { device: 'Pixel 7', deviceId: 'android:2A1', state: 'disconnected', detail: '' }],
  ['device.disconnected', { device: 'Pixel 8 · Demo', deviceId: 'demo:1', state: 'disconnected', detail: 'Demo mode turned off' }],
  ['device.disconnected', { device: 'iPhone', deviceId: 'net:ios-iphone-iphone', state: 'disconnected', detail: 'No app is connected over the network' }],
  ['app.connected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'flutter', transport: 'adb-reverse', device: 'Pixel 7' }],
  ['app.connected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '', sdk: 'dart-vm', transport: 'vm-service', device: 'iPhone 16 Pro' }],
  ['app.connected', { app: 'Mahalle', bundleId: 'com.mykynk.mahalle', version: '5.12.0', sdk: 'android', transport: 'demo', device: 'Pixel 8 · Demo' }],
  ['app.connected', { app: 'Kasa', bundleId: 'com.example.kasa', version: '1.0.0', sdk: 'react-native', transport: 'websocket', device: 'Galaxy S23' }],
  ['app.reconnected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'ios', transport: 'usbmux', device: 'Yusuf’un iPhone’u' }],
  ['app.disconnected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'flutter', transport: 'demo', device: 'iPhone 16 Pro · Demo', failedRequests: 1 }],
  ['app.disconnected', { app: 'Mahalle', bundleId: 'com.mykynk.mahalle', version: '5.12.0', sdk: 'android', transport: 'demo', device: 'Pixel 8 · Demo', failedRequests: 0 }],
  ['app.disconnected', { app: 'Pati', bundleId: 'com.mykynk.pati', version: '2.4.1', sdk: 'flutter', transport: 'tcp', device: 'iPhone', failedRequests: 3 }],
  ['process.started', { process: 'com.mykynk.mahalle', pid: 6944 }],
  ['process.died', { process: 'Runner', pid: 48213 }],
  ['marker', { label: '', n: 3 }],
  ['marker', { label: 'Ödeme akışı testi', n: 4 }],
  ['logs.streamStarted', { via: 'logcat' }],
  ['logs.streamStopped', { via: 'idevicesyslog' }],
  ['logs.streamError', { via: 'simctl log stream', detail: 'log stream exited (exit code 1): boom — restarting' }],
  // An attached iPhone whose idevicesyslog stream went quiet (restarted with backoff).
  ['logs.streamStalled', { via: 'idevicesyslog', seconds: 30, detail: 'no log line from the device for 30 s although it is connected (idevicesyslog runs but sends nothing); restarting idevicesyslog in 2 s (attempt 1)' }],
  ['logs.scopeApplied', { via: 'idevicesyslog', device: 'Yusuf’un iPhone’u' }],
  // A USB drop the iPhone came back from within the grace (no disconnected / connected lines).
  ['logs.connectionLost', { via: 'idevicesyslog', connection: 'usb', graceSeconds: 3, detail: 'the USB connection dropped; log lines are missing until the device is back; it is shown disconnected if it is not back within 3 s' }],
  ['logs.connectionLost', { via: 'idevicesyslog', connection: 'wifi', graceSeconds: 10, detail: 'the Wi-Fi connection dropped; it is shown disconnected if it is not back within 10 s' }],
  ['logs.connectionRestored', { via: 'idevicesyslog', connection: 'usb', seconds: 1.4, detail: 'the USB connection was gone for 1.4 s; log lines from that moment are missing' }],
  ['logs.connectionRestored', { via: 'idevicesyslog', connection: 'usb', seconds: 0.8, detail: 'the USB connection was gone for 0.8 s' }],
  // iosDeviceLogScope 'apps' cannot be applied: every line is shown.
  ['logs.scopeNotApplied', { via: 'idevicesyslog', reason: 'devicectlMissing', device: 'Yusuf’un iPhone’u' }],
  ['logs.scopeNotApplied', { via: 'idevicesyslog', reason: 'appListFailed', device: 'Yusuf’un iPhone’u' }],
  ['logs.scopeNotApplied', { via: 'idevicesyslog', reason: 'somethingNew', device: 'Yusuf’un iPhone’u' }],
  ['vm.attached', { app: 'Pati', url: 'ws://127.0.0.1:52345/Ab3x=/ws' }],
  ['vm.detached', { app: 'Pati', reason: 'the app stopped or the device was disconnected' }],
  ['vm.detached', { app: 'Pati', reason: 'detached by the user' }],
  ['vm.attachFailed', { url: 'http://127.0.0.1:50123/x=/', error: 'connect ECONNREFUSED 127.0.0.1:50123' }],
  ['vm.hotRestart', { app: 'Pati' }],
  ['vm.hotReload', { app: 'Pati' }],
  // Another Dürbün on this Mac (e.g. the Mac app on 9750) owns the device's adb reverse mappings.
  ['sdk.routeElsewhere', { port: 9750 }],
];

const NOTICE_SAMPLES: [code: string, params: Record<string, string | number> | undefined][] = [
  [
    'settings.adjusted',
    { details: 'maxLogEntries 5000000 → 1000000 (allowed 1000–1000000); logcatTail -5 → 0 (allowed 0–100000); watchedApps normalized (trimmed, de-duplicated)' },
  ],
  ['settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 1 }],
  ['settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }],
  ['settings.lanOff', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }],
  ['settings.lanOff', { sdkPort: 9751, httpPort: 9750, restartRequired: 1 }],
  ['settings.sdkRebindFailed', { port: 9751, error: 'Port 9751 is already used by another program' }],
  ['config.writeFailed', { file: 'settings.json', error: 'EACCES: permission denied' }],
  ['config.unreadable', { file: 'settings.json', error: 'Unexpected end of JSON input', backup: '/Users/x/.durbun/settings.json.corrupt-1793651000000' }],
  ['config.unreadable', { file: 'mocks.json', error: 'Unexpected token } in JSON at position 41' }],
  ['config.dataDirFallback', { dir: '/Users/x/.durbun', fallback: '/var/folders/tmp/durbun-x', error: 'EACCES: permission denied' }],
  ['config.tempDirFallback', { dir: '/var/folders/tmp/durbun-tmp-a1b2', error: 'ENOSPC: no space left on device' }],
  ['sdk.portBusy', { port: 9751 }],
  ['sdk.listenFailed', { port: 9751, error: 'EACCES: permission denied' }],
  ['demo.startFailed', { reason: 'demo data folder is not writable' }],
  ['replay.bodyTruncated', undefined],
  ['replay.bodyMissing', undefined],
  ['replay.bodyDropped', undefined],
  ['vm.attached', { app: 'Pati' }],
  ['vm.detached', { app: 'Pati', reason: 'the app restarted (new VM service URL)' }],
  ['vm.attachFailed', { url: 'http://127.0.0.1:50123/x=/', error: 'timeout' }],
];

/** Flow step summaries, step errors, preflight and validation issues, notices: params as the server sends them. */
const FLOW_SAMPLES: [code: string, params: Record<string, string | number>][] = [
  ['flow.step.http', { method: 'POST', url: 'https://api.kumbara.app/v1/login', status: 200, duration: '142 ms' }],
  ['flow.step.http', { method: 'GET', url: 'https://api.kumbara.app/v1/cart', status: 503, duration: '12.5 s' }],
  ['flow.step.sawRequest', { method: 'GET', url: 'https://api.kumbara.app/v1/cart', status: 200 }],
  ['flow.step.sawRequest', { method: 'POST', url: 'https://api.kumbara.app/v1/order', status: 0 }],
  ['flow.step.sawLog', { message: 'Checkout finished in 812 ms' }],
  ['flow.step.sawEvent', { name: 'checkout_done' }],
  ['flow.step.waited', { duration: '500 ms' }],
  ['flow.step.checksPassed', { count: 1 }],
  ['flow.step.checksPassed', { count: 3 }],
  ['flow.step.conditionTrue', { explain: '' }],
  ['flow.step.conditionFalse', { explain: '401 — expected equals 200' }],
  ['flow.step.conditionFalse', { explain: ' and nothing — expected it to exist' }],
  ['flow.step.vars', { names: 'orderId, total' }],
  ['flow.step.vars', { names: '' }],
  ['flow.step.screenshot', { name: 'Sepet ekranı' }],
  ['flow.step.recording', { seconds: 180 }],
  ['flow.step.recordingSaved', { name: 'recording' }],
  ['flow.step.mockAdded', { url: '/v1/cart' }],
  ['flow.step.mockAddedWaiting', { url: '/v1/cart' }],
  ['flow.step.httpBodyInferred', { method: 'POST', url: 'https://api.kumbara.app/v1/login', status: 200, duration: '142 ms', bodyType: 'json' }],
  ['flow.step.openedUrl', { url: 'kumbara://cart' }],
  ['flow.step.appLaunched', { app: 'com.mykynk.pati' }],
  ['flow.step.appStopped', { app: 'com.mykynk.pati' }],
  ['flow.step.appRestarted', { app: 'com.mykynk.pati' }],
  ['flow.step.appDataCleared', { app: 'com.mykynk.pati' }],
  ['flow.step.appInstalled', { file: 'app-debug.apk' }],
  ['flow.step.appUninstalled', { app: 'com.mykynk.pati' }],
  ['flow.step.appearance', { mode: 'dark' }],
  ['flow.step.fontScale', { scale: '1.3' }],
  ['flow.step.location', { lat: '41.0082', lon: '28.9784' }],
  ['flow.step.pushSent', { app: 'com.mykynk.pati' }],
  ['flow.step.textTyped', { text: 'qa+1731300000@example.com' }],
  ['flow.step.keyPressed', { key: 'back' }],
  ['flow.step.statusBar', { mode: 'clean' }],
  ['flow.step.animationsOn', {}],
  ['flow.step.animationsOff', {}],
  ['flow.automation.loop', { flow: 'Çökme raporu', count: 5 }],
  ['flow.automation.busy', {}],
  ['flow.id.reserved', {}],
  ['preflight.start.unknown', { node: 'http_3' }],
  ['preflight.call.depth', { flow: 'Giriş yap', max: 8 }],
  ['flow.step.mockOn', { rule: 'Sepet 500' }],
  ['flow.step.mockOff', { rule: 'Sepet 500' }],
  ['flow.step.mockRemoved', { rule: '/v1/cart' }],
  ['flow.step.marker', { label: 'Ödeme testi' }],
  ['flow.step.note', { text: 'Kampanya kodu yalnızca TR’de geçerli' }],
  ['flow.step.note', { text: '' }],
  ['flow.step.subflowPassed', { flow: 'Giriş yap' }],
  ['flow.step.iteration', { index: 2, count: 5 }],
  ['flow.step.iterationStopped', { index: 3, count: 5 }],
  ['flow.step.repeated', { count: 1 }],
  ['flow.step.repeatMet', { count: 2 }],
  ['flow.step.repeatNotMet', { count: 10 }],
  ['flow.step.retrying', { attempt: 1, error: 'GET https://api.kumbara.app/v1/cart failed: connect ECONNREFUSED 10.0.2.2:443' }],
  ['flow.step.timeout', { seconds: 300 }],
  ['flow.sdk.missing', { capability: 'network', app: 'com.mykynk.pati' }],
  ['flow.sdk.missing', { capability: 'events', app: '' }],
  ['flow.http.method', { method: 'G ET' }],
  ['flow.http.invalidUrl', { url: '' }],
  ['flow.http.invalidUrl', { url: 'ftp://files.kumbara.app' }],
  ['flow.http.header', { header: 'X Token' }],
  ['flow.http.failed', { method: 'GET', url: 'https://api.kumbara.app/v1/cart', error: 'The request timed out' }],
  ['flow.http.failed', { method: 'GET', url: 'https://api.kumbara.app/v1/cart', error: '' }],
  ['flow.http.status', { method: 'POST', url: 'https://api.kumbara.app/v1/login', status: 401, duration: '88 ms', expected: '2xx' }],
  ['flow.extract.missing', { name: 'token', from: 'body', path: 'data.token' }],
  ['flow.extract.missing', { name: 'session', from: 'header', path: '' }],
  ['flow.regex.invalid', { pattern: '([a-z' }],
  ['flow.assert.failed', { count: 1, first: 'Total is 15 (12 — expected equals 15)' }],
  ['flow.assert.failed', { count: 3, first: 'Total is 15 (12 — expected equals 15)' }],
  ['flow.noErrors.found', { count: 2, first: 'Crash: FormatException: Invalid radix-10 number' }],
  ['flow.repeat.notMet', { count: 10 }],
  ['flow.call.unknown', { flow: 'login' }],
  ['flow.call.depth', { max: 8 }],
  ['flow.call.input', { flow: 'Giriş yap', name: 'email' }],
  ['flow.call.failed', { flow: 'Giriş yap', error: 'Expected status 2xx, got 401 (POST https://api.kumbara.app/v1/login)' }],
  ['flow.call.failed', { flow: 'Giriş yap', error: '' }],
  ['flow.param.type', { param: 'durationMs', expected: 'number' }],
  ['flow.param.type', { param: 'headers', expected: 'somethingNew' }],
  ['flow.param.type', { param: 'count', expected: 'numberOrList' }],
  ['flow.param.json', { param: 'payload' }],
  ['flow.mock.invalid', { error: 'url must not be empty' }],
  ['flow.mock.notFound', { rule: 'Sepet 500' }],
  ['flow.wait.network', { url: '/v1/cart', timeout: '30.0 s' }],
  ['flow.wait.network', { url: '', timeout: '5000 ms' }],
  ['flow.wait.log', { text: 'Checkout finished', timeout: '30.0 s' }],
  ['flow.wait.event', { name: 'checkout_done', timeout: '15.0 s' }],
  ['flow.node.unknownType', { type: 'http.reqest' }],
  ['flow.template.syntax', { ref: 'login.body.items[' }],
  ['flow.template.unknownRoot', { ref: 'loginn.body.token' }],
  ['flow.template.unknownHelper', { ref: '$uuidd' }],
  ['flow.template.unknownPipe', { ref: 'login.body.items | size' }],
  ['template.syntax', { ref: 'login.body.items[' }],
  // Notices
  ['flow.automation.failed', { flow: 'Çökme raporu', error: 'No device is connected; this flow has device steps', reason: 'flow.preflight.failed' }],
  ['flow.automation.failed', { flow: 'Çökme raporu', error: 'At most 10 runs at once', reason: 'flow.run.tooMany' }],
  ['flow.automation.failed', { flow: 'Çökme raporu', error: 'boom' }],
  ['flow.file.unreadable', { file: 'login.json', problem: 'Unexpected token } in JSON at position 41' }],
  ['backup.failed', { error: 'ENOSPC: no space left on device' }],
  // Validation issues
  ['flow.format', { format: 'durbun-session' }],
  ['flow.version', { version: '2' }],
  ['flow.id.fixed', { from: 'Login Flow', to: 'login-flow' }],
  ['flow.node.idGenerated', { id: 'http1' }],
  ['flow.node.idFixed', { from: 'get-cart', to: 'get_cart' }],
  ['flow.node.duplicateId', { id: 'login' }],
  ['flow.node.reservedId', { id: 'env' }],
  ['flow.node.unknownType', { type: 'http.reqest', suggestion: 'http.request' }],
  ['flow.node.unknownType', { type: 'tap', suggestion: '' }],
  ['flow.node.unreachable', { node: 'Sepeti aç' }],
  ['flow.nodes.tooMany', { max: 500 }],
  ['flow.edges.tooMany', { max: 2000 }],
  ['flow.edge.unknownNode', { node: 'cart2' }],
  ['flow.edge.port', { port: 'yes', ports: 'true, false, error' }],
  ['flow.edge.intoTrigger', { node: 'start' }],
  ['flow.param.required', { param: 'url' }],
  ['flow.param.range', { param: 'maxSeconds', min: 1, max: 600 }],
  ['flow.param.range', { param: 'delayMs', min: 0, max: '' }],
  ['flow.param.option', { param: 'method', value: 'FETCH', options: 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS' }],
  ['flow.param.option', { param: 'bodyType', value: '', options: 'none, json, text, form' }],
  ['flow.param.unknown', { param: 'retries', type: 'http.request' }],
  ['flow.rule.op', { op: '=~' }],
  ['flow.rule.op', { op: '' }],
  ['flow.extract.name', { name: 'access-token' }],
  ['flow.extract.from', { value: 'cookie' }],
  ['flow.assign.name', { name: '1x' }],
  ['flow.input.name', { name: 'e mail' }],
  ['flow.input.duplicate', { name: 'email' }],
  ['flow.output.name', { name: 'order id' }],
  ['flow.template.syntax', { detail: 'Unclosed {{ (every {{ needs a }} after it)' }],
  ['flow.param.jsonText', { param: 'text' }],
  ['flow.param.status', { param: 'expectStatus', value: '2XX OK' }],
  ['flow.param.fixed', { param: 'status' }],
  ['flow.param.fixed', { param: 'extract.path' }],
  ['flow.mock.delay', {}],
  ['flow.name.reserved', { name: '__proto__' }],
  ['flow.rule.right', { op: 'equals' }],
  ['flow.extract.pathSyntax', { detail: 'Unclosed [ in "items[0"' }],
  ['flow.extract.pathFixed', { from: '$.data.token', to: 'data.token' }],
  ['flow.regex.invalid', { pattern: '([a-z]+', param: 'text' }],
  ['flow.template.unknownRoot', { root: 'loginn' }],
  ['flow.call.unknown', { flowId: 'login' }],
  ['flow.trigger.added', { id: 'start1' }],
  // Preflight issues
  ['preflight.flow.invalid', { problem: 'url is required' }],
  ['preflight.device.gone', { device: 'android:R5CW30XYZ' }],
  ['preflight.device.offline', { device: 'Galaxy S23', state: 'offline' }],
  ['preflight.device.offline', { device: 'Pixel 7', state: 'somethingNew' }],
  ['preflight.device.nonePlatform', { platform: 'ios' }],
  ['preflight.device.nonePlatform', { platform: 'other' }],
  ['preflight.device.noneSkipped', { count: 12 }],
  ['preflight.device.auto', { device: 'Pixel 8' }],
  ['preflight.app.notInstalled', { app: 'com.mykynk.pati', device: 'Pixel 7' }],
  ['preflight.action.emulator', { step: 'Location', device: 'Galaxy S23', action: 'location' }],
  ['preflight.action.simulator', { step: 'Push notification', device: 'Yusuf’un iPhone’u', action: 'push-notification' }],
  ['preflight.action.tool', { step: 'Screen recording', device: 'iPhone 15', action: 'screen-record' }],
  ['preflight.action.platform', { step: 'Input text', device: 'iPhone 16 Pro', action: 'input-text' }],
  ['preflight.sdk.notConnected', { step: 'Wait for a request', capability: 'network' }],
  ['preflight.sdk.notConnected', { step: 'Wait for a request', capability: 'commands' }],
  ['preflight.call.unknown', { flow: 'login' }],
  ['preflight.call.recursive', { flow: 'Giriş yap' }],
  ['preflight.env.unknown', { env: 'staging' }],
  ['preflight.env.none', { keys: 'baseUrl, token' }],
  ['preflight.env.missing', { env: 'Staging', keys: 'token' }],
  ['preflight.env.empty', { env: 'Staging', keys: 'password' }],
  ['preflight.input.missing', { name: 'email' }],
  // Package inspect warnings
  ['package.flow.invalid', { problem: 'nodes must be a list' }],
  ['package.flow.problems', { flow: 'Giriş yap', count: 2 }],
  ['package.mock.invalid', { problem: 'rule #2 (Login): action is missing' }],
  // Package import notices
  ['package.settings.ignored', { keys: 'futureSetting' }],
  ['package.settings.failed', { error: 'Invalid settings: maxLogEntries must be a number' }],
  ['package.slack.failed', { error: 'The webhook URL must start with https://' }],
  ['package.flow.saveFailed', { flow: 'Giriş yap', error: 'At most 200 flows' }],
  ['package.mocks.saveFailed', { error: 'too many mock rules (1001); at most 1000' }],
  ['package.run.failed', { run: 'Giriş yap', error: 'ENOSPC: no space left on device' }],
];

/** English words that must not leak into Turkish system lines. */
const ENGLISH_LEFTOVERS = /\b(connected|disconnected|started|died|stopped|interrupted|restarting|attached|detached|pending|failed|shut down)\b/;

function expectClean(text: string, where: string): void {
  expect(text, where).not.toBe(FALLBACK);
  expect(text, where).not.toMatch(/\{\s*[\w.]+\s*(,\s*number\s*)?\}/);
  expect(text, where).not.toMatch(/ {2}/);
  expect(text, where).not.toMatch(/\bundefined\b|\bnull\b|\bNaN\b/);
  expect(text, where).not.toMatch(/\(\s*\)|\( | \)|· ·|·\s*$|^\s*·/);
  expect(text, where).toBe(text.trim());
  expect(text.length, where).toBeGreaterThan(1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe('server codes → i18n', () => {
  it('every maintained code has Turkish and English text', () => {
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const codes = [...allServerCodes(), ...LOCAL_CODES];
    expect(codes.length).toBeGreaterThan(120);
    const missing = codes.filter((c) => !tr.has(`code.${c}`) || !en.has(`code.${c}`));
    expect(missing).toEqual([]);
  });

  it('the maintained list covers every code literal in the server source', () => {
    const packages = existsSync(join(process.cwd(), 'packages/server/src')) ? join(process.cwd(), 'packages') : join(process.cwd(), '..');
    const roots = [join(packages, 'server/src'), join(packages, 'protocol/src/flows')];
    if (!roots.every((r) => existsSync(r))) return; // UI package checked out alone
    const NOT_CODES = new Set([
      'api.kumbara.app', // a demo host name
      'app.action',
      'backup.json',
      'command.result',
      'demo.set',
      'device.action',
      'doctor.run',
      'marker.add',
      'metrics.watch',
      'mocks.json',
      'mocks.set',
      'net.error',
      'net.replay',
      'net.request',
      'net.response',
      'preflight.action.unsupported', // examples in a doc comment (the real codes: preflight.action.<where>, preflight.sdk.notConnected)
      'preflight.sdk.missing',
      'sdk.close',
      'settings.json',
      'settings.onUnsupported', // JSON paths of flow validation issues
      'settings.timeoutMs',
      'slack.json',
      'settings.update',
      'upload.bin',
      'vm.attach',
      'vm.detach',
    ]);
    // Flow node types ('flow.call', 'device.openUrl', …) are not codes.
    const nodeTypes = new Set(FLOW_NODE_SPECS.map((s) => s.type));
    const literal =
      /'((?:device|app|logs|driver|demo|action|command|config|settings|replay|vm|server|sdk|metrics|net|params|screenshot|process|marker|import|upload|body|file|har|search|url|method|access|api|mocks|doctor|reader|flow|flowRun|preflight|package|backup|uiPrefs|template|env)\.[A-Za-z][A-Za-z.]*)'/g;
    const found = new Set<string>();
    for (const root of roots) {
      for (const f of walk(root)) for (const m of readFileSync(f, 'utf8').matchAll(literal)) if (!NOT_CODES.has(m[1]!) && !nodeTypes.has(m[1]!)) found.add(m[1]!);
    }
    expect(found.size).toBeGreaterThan(250);
    const known = new Set(allServerCodes());
    expect([...found].filter((c) => !known.has(c)).sort()).toEqual([]);
  });

  it('every system line code has a realistic sample', () => {
    const sampled = new Set(SYSTEM_SAMPLES.map(([c]) => c));
    expect(SERVER_CODES.systemLines.filter((c) => !sampled.has(c))).toEqual([]);
  });

  it.each(LANGS)('renders every system line with real params cleanly (%s)', (lang) => {
    for (const [code, params] of SYSTEM_SAMPLES) {
      const text = tCodeIn(lang, code, params, FALLBACK);
      expectClean(text, `${lang} ${code} ${JSON.stringify(params)}`);
      if (lang === 'tr') expect(text, `${code}: ${text}`).not.toMatch(ENGLISH_LEFTOVERS);
    }
  });

  it.each(LANGS)('renders notices with real params cleanly (%s)', (lang) => {
    for (const [code, params] of NOTICE_SAMPLES) {
      const text = tCodeIn(lang, code, params, FALLBACK);
      expectClean(text, `${lang} ${code}`);
    }
  });

  it.each(LANGS)('renders every code without params (labels, states, errors) (%s)', (lang) => {
    for (const code of [...allServerCodes(), ...LOCAL_CODES]) {
      const text = tCodeIn(lang, code, undefined, FALLBACK);
      expectClean(text, `${lang} ${code}`);
    }
  });

  it('writes natural Turkish for the lifecycle lines', () => {
    const tr = (code: string, params: Record<string, string | number>) => tCodeIn('tr', code, params, FALLBACK);
    expect(tr('device.connected', SYSTEM_SAMPLES[0]![1])).toBe('Pixel 8 · Demo bağlandı (Android 15 · emülatör)');
    expect(tr('device.connected', SYSTEM_SAMPLES[1]![1])).toBe('Yusuf’un iPhone’u bağlandı (iOS 18.1 · USB)');
    expect(tr('device.connected', SYSTEM_SAMPLES[2]![1])).toBe('Galaxy S23 bağlandı (Wi-Fi)');
    expect(tr('device.disconnected', SYSTEM_SAMPLES[4]![1])).toBe('iPhone 16 Pro bağlantısı kesildi (simülatör kapatıldı)');
    expect(tr('device.disconnected', SYSTEM_SAMPLES[5]![1])).toBe('Galaxy S23 bağlantısı kesildi (çevrimdışı)');
    expect(tr('device.disconnected', SYSTEM_SAMPLES[7]![1])).toBe('Pixel 7 bağlantısı kesildi');
    expect(tr('app.connected', SYSTEM_SAMPLES[10]![1])).toBe('Pati 2.4.1 bağlandı (Flutter SDK · adb reverse)');
    expect(tr('app.connected', SYSTEM_SAMPLES[11]![1])).toBe('Pati bağlandı (Dart VM Service)');
    expect(tr('app.disconnected', SYSTEM_SAMPLES[15]![1])).toBe('Pati bağlantısı kesildi · yanıt bekleyen 1 istek başarısız sayıldı');
    expect(tr('app.disconnected', SYSTEM_SAMPLES[16]![1])).toBe('Mahalle bağlantısı kesildi');
    expect(tr('process.started', { process: 'com.mykynk.mahalle', pid: 6944 })).toBe('com.mykynk.mahalle başladı · pid 6944');
    expect(tr('process.died', { process: 'Runner', pid: 48213 })).toBe('Runner sonlandı · pid 48213');
    expect(tr('marker', { label: '', n: 3 })).toBe('İşaret 3');
    expect(tr('marker', { label: 'Ödeme akışı testi', n: 4 })).toBe('Ödeme akışı testi');
    expect(tr('logs.streamError', { via: 'logcat', detail: 'x' })).toBe('Cihaz log akışı kesildi (logcat); yeniden başlatılıyor');
    expect(tr('logs.streamStalled', { via: 'idevicesyslog', seconds: 30 })).toBe('iPhone bağlı ama log akışı 30 sn’dir sessiz; yeniden başlatılıyor');
    expect(tr('logs.scopeNotApplied', { via: 'idevicesyslog', reason: 'devicectlMissing', device: 'Yusuf’un iPhone’u' })).toBe(
      'Yusuf’un iPhone’u: sistem süreçlerinin satırları da gösteriliyor; uygulama satırlarını ayırmak için Xcode 15 ya da daha yenisi (devicectl) gerekir',
    );
    expect(tr('logs.scopeNotApplied', { via: 'idevicesyslog', reason: 'appListFailed', device: 'Yusuf’un iPhone’u' })).toBe(
      'Yusuf’un iPhone’u: sistem süreçlerinin satırları da gösteriliyor; kurulu uygulamalar devicectl ile okunamadığı için uygulama satırları ayrılamıyor',
    );
    // A reason this UI does not know yet: the sentence without the why.
    expect(tr('logs.scopeNotApplied', { via: 'idevicesyslog', reason: 'somethingNew', device: 'Yusuf’un iPhone’u' })).toBe('Yusuf’un iPhone’u: sistem süreçlerinin satırları da gösteriliyor');
    expect(tcodeEn('logs.scopeNotApplied', { reason: 'devicectlMissing', device: 'Pixel' })).toBe('Pixel: system process lines are shown too; telling app lines apart needs Xcode 15 or newer (devicectl)');
    expect(tr('logs.scopeApplied', { via: 'idevicesyslog', device: 'Yusuf’un iPhone’u' })).toBe('Yusuf’un iPhone’u: kurulu uygulamalar okundu; sistem süreçlerinin satırları artık gizleniyor');
    const lost = SYSTEM_SAMPLES.filter(([c]) => c === 'logs.connectionLost').map(([, p]) => p);
    expect(tr('logs.connectionLost', lost[0]!)).toBe('Cihazın USB bağlantısı koptu; dönene kadar log satırı gelmez. 3 sn içinde dönmezse cihaz bağlı değil olarak görünür');
    expect(tr('logs.connectionLost', lost[1]!)).toBe('Cihazın Wi-Fi bağlantısı koptu; 10 sn içinde dönmezse cihaz bağlı değil olarak görünür');
    const back = SYSTEM_SAMPLES.filter(([c]) => c === 'logs.connectionRestored').map(([, p]) => p);
    expect(tr('logs.connectionRestored', back[0]!)).toBe('Cihazın USB bağlantısı 1,4 sn sonra geri geldi; aradaki log satırları eksik');
    expect(tr('logs.connectionRestored', back[1]!)).toBe('Cihazın USB bağlantısı 0,8 sn sonra geri geldi');
    expect(tcodeEn('logs.connectionRestored', back[0]!)).toBe('The device’s USB connection is back after 1.4 s; log lines from the gap are missing');
    expect(tr('vm.detached', { app: 'Pati', reason: 'detached by the user' })).toBe('Pati için Dart VM Service bağlantısı kesildi (elle ayrıldı)');
    expect(tcodeEn('app.disconnected', { app: 'Pati', failedRequests: 3 })).toBe('Pati disconnected · 3 pending requests failed');
    // Older `{ name }` params still render.
    expect(tr('device.connected', { name: 'Pixel 8' })).toBe('Pixel 8 bağlandı');
  });

  it('localizes notices: adjusted values, LAN mode with and without restart', () => {
    const adjusted = tCodeIn('tr', 'settings.adjusted', NOTICE_SAMPLES[0]![1], FALLBACK);
    expect(adjusted).toContain('Bellekte tutulacak en fazla log: 5.000.000 yerine 1.000.000 kullanıldı (izin verilen 1.000–1.000.000)');
    expect(adjusted).toContain('İzlenen uygulamalar listesi düzenlendi');
    expect(tCodeIn('tr', 'settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 1 }, FALLBACK)).toContain('Dürbün yeniden başlatılana kadar');
    expect(tCodeIn('tr', 'settings.lanOn', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }, FALLBACK)).not.toContain('yeniden başlatılana');
    expect(tCodeIn('en', 'settings.lanOff', { sdkPort: 9751, httpPort: 9750, restartRequired: 0 }, FALLBACK)).toBe(
      'Local network mode is off: the SDK port (9751) now accepts connections from this Mac only.',
    );
  });

  it('keeps the specific part of server errors and localizes the rest', () => {
    setLanguage('tr');
    expect(errorText({ code: 'action.installFailed', message: 'Install failed: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]' })).toBe(
      'Kurulum başarısız oldu: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
    );
    expect(errorText({ code: 'config.invalid', message: 'Invalid settings: maxLogEntries must be a number' })).toBe('Geçersiz ayar: maxLogEntries must be a number');
    expect(errorText({ code: 'replay.invalidMethod', message: 'Invalid HTTP method "G E T"' })).toBe('Geçersiz HTTP metodu: G E T');
    expect(errorText({ code: 'upload.tooLarge', message: 'File is too large (limit 2 GB)' })).toBe('Dosya çok büyük (en fazla 2 GB)');
    expect(errorText({ code: 'action.failed', message: 'The action failed' })).toBe('İşlem başarısız oldu');
    expect(errorText({ code: 'device.readOnly', message: 'Imported sessions are read-only recordings' })).toBe(
      'İçe aktarılan kayıtlar salt okunurdur; cihaz işlemleri kullanılamaz',
    );
    expect(
      errorText({
        code: 'command.failed',
        message: 'No Dart VM service URL found. Paste the URL printed by `flutter run` ("A Dart VM Service … is available at: http://127.0.0.1:…/…=/"), a DevTools link, or the whole output.',
      }),
    ).toMatch(/^Metinde Dart VM Service adresi bulunamadı/);
    expect(errorText({ code: 'command.timeout', message: 'No reply within 15 s' })).toBe('Sunucu zamanında yanıt vermedi');
    expect(errorText({ code: 'something.new', message: 'Brand new failure' })).toBe('Brand new failure');
    expect(errorText(new Error('plain'))).toBe('plain');
    expect(errorText('text')).toBe('text');
    expect(errorDetail('Could not launch com.x: Error: Activity class does not exist')).toBe('Error: Activity class does not exist');
    setLanguage('en');
  });

  it('localizes driver states, device states and the virtual desktop device', () => {
    setLanguage('tr');
    expect(driverStatusText({ id: 'android', detail: 'adb 1.0.41 (37.0.0-14910828) · 0 devices online' })).toBe('adb 1.0.41 (37.0.0-14910828) · 0 cihaz bağlı');
    expect(driverStatusText({ id: 'ios-sim', detail: '0 booted simulators' })).toBe('0 açık simülatör');
    expect(driverStatusText({ id: 'ios-device', detail: '2 devices' })).toBe('2 bağlı cihaz');
    expect(driverStatusText({ id: 'flutter-vm', detail: 'Waiting for Flutter debug apps (auto-attach on)' })).toBe(
      'Flutter debug uygulamaları bekleniyor (otomatik bağlanma açık)',
    );
    // The server says "3 virtual devices"; the text names no count, so it cannot go stale again.
    expect(driverStatusText({ id: 'demo', detail: 'Generating demo data for 3 virtual devices', code: 'demo.active' })).toBe('Demo cihazlarında örnek veri üretiliyor');
    expect(driverStatusText({ id: 'android', detail: 'something odd' })).toBe('something odd');
    expect(deviceDisplayName({ id: 'desktop', name: 'Desktop' })).toBe('Masaüstü · Dürbün’ün gönderdikleri');
    expect(deviceDisplayName({ id: 'import:1', name: '📁 Pixel 8 · Demo' })).toBe('📁 Pixel 8 · Demo');
    expect(deviceStateText({ state: 'disconnected', stateCode: 'device.imported' })).toBe('İçe aktarılan kayıt · salt okunur');
    expect(deviceStateText({ state: 'unauthorized', stateCode: 'device.untrusted' })).toMatch(/Güven’e dokunun/);
    expect(logStatusText({ logs: { status: 'unavailable', code: 'logs.networkOnly' } })).toMatch(/^Yalnızca SDK verisi/);
    setLanguage('en');
    expect(deviceDisplayName({ id: 'desktop', name: 'Desktop' })).toBe('Desktop · sent by Dürbün');
    expect(driverStatusText({ id: 'ios-sim', detail: '1 booted simulator' })).toBe('1 booted simulator');
  });
});

describe('flow codes → i18n', () => {
  it.each(LANGS)('renders flow, preflight, validation and package codes with real params cleanly (%s)', (lang) => {
    for (const [code, params] of FLOW_SAMPLES) {
      expect(allServerCodes(), code).toContain(code);
      expectClean(tCodeIn(lang, code, params, FALLBACK), `${lang} ${code} ${JSON.stringify(params)}`);
    }
  });

  it('words the most visible flow codes', () => {
    const tr = (code: string, params: Record<string, string | number>) => tCodeIn('tr', code, params, FALLBACK);
    const sample = (code: string, i = 0) => FLOW_SAMPLES.filter(([c]) => c === code)[i]![1];
    expect(tr('flow.step.http', sample('flow.step.http'))).toBe('POST https://api.kumbara.app/v1/login → 200 · 142 ms');
    expect(tr('flow.step.http', sample('flow.step.http', 1))).toBe('GET https://api.kumbara.app/v1/cart → 503 · 12,5 sn');
    expect(tcodeEn('flow.step.http', sample('flow.step.http', 1))).toBe('GET https://api.kumbara.app/v1/cart → 503 · 12.5 s');
    expect(tr('flow.step.sawRequest', sample('flow.step.sawRequest', 1))).toBe('POST https://api.kumbara.app/v1/order → başarısız');
    expect(tr('flow.wait.network', sample('flow.wait.network'))).toBe('30 sn içinde “/v1/cart” ile eşleşen istek gelmedi');
    expect(tr('flow.step.conditionFalse', sample('flow.step.conditionFalse', 1))).toBe('Koşul sağlanmadı: nothing — expected it to exist');
    expect(tr('flow.param.type', sample('flow.param.type'))).toBe('durationMs: bir sayı olmalı');
    expect(tr('flow.param.type', sample('flow.param.type', 1))).toBe('headers: değer türü yanlış');
    expect(tr('flow.param.type', { param: 'count', expected: 'numberOrList' })).toBe('count: bir sayı ya da liste olmalı');
    expect(tcodeEn('flow.automation.loop', { flow: 'Crash report', count: 5 })).toBe(
      'Automation for “Crash report” was switched off: it started 5 times in a row right after its previous run',
    );
    expect(tr('flow.extract.missing', sample('flow.extract.missing'))).toBe('token yanıttan okunamadı (yanıt gövdesi data.token)');

    expect(tr('flow.assert.failed', sample('flow.assert.failed'))).toBe('Kontrol başarısız: Total is 15 (12 — expected equals 15)');
    expect(tr('flow.assert.failed', sample('flow.assert.failed', 1))).toBe('3 kontrol başarısız; ilki: Total is 15 (12 — expected equals 15)');
    expect(tcodeEn('flow.assert.failed', sample('flow.assert.failed'))).toBe('Check failed: Total is 15 (12 — expected equals 15)');
    expect(tcodeEn('flow.assert.failed', sample('flow.assert.failed', 1))).toBe('3 checks failed; first: Total is 15 (12 — expected equals 15)');
    expect(tcodeEn('flow.step.checksPassed', { count: 1 })).toBe('1 check passed');

    expect(tr('preflight.device.auto', sample('preflight.device.auto'))).toBe('Pixel 8 üzerinde çalışacak. Başka bir cihaz için hedefi değiştirin.');
    expect(tcodeEn('preflight.device.auto', sample('preflight.device.auto'))).toBe('Runs on Pixel 8. Change the target to use another device.');
    expect(tr('preflight.device.offline', sample('preflight.device.offline'))).toBe('Galaxy S23 hazır değil (çevrimdışı)');
    expect(tr('preflight.device.offline', sample('preflight.device.offline', 1))).toBe('Pixel 7 hazır değil');
    expect(tr('preflight.device.nonePlatform', sample('preflight.device.nonePlatform'))).toBe('Bağlı iOS cihazı yok; akışta cihaz adımları var');
    expect(tr('preflight.device.noneSkipped', { count: 12 })).toBe('Bağlı cihaz yok; 12 cihaz adımı atlanacak');
    expect(tcodeEn('preflight.device.noneSkipped', { count: 1 })).toBe('No device is connected; the device step will be skipped');
    expect(tr('preflight.action.emulator', sample('preflight.action.emulator'))).toBe('Galaxy S23 bu adımı çalıştıramaz: yalnızca Android emülatöründe çalışır');
    expect(tcodeEn('preflight.action.emulator', sample('preflight.action.emulator'))).toBe('Location works only on an Android emulator, not on Galaxy S23');
    expect(tr('flow.sdk.missing', sample('flow.sdk.missing'))).toBe('com.mykynk.pati Dürbün SDK’sıyla bağlı değil; bu adım ağ isteklerini SDK üzerinden görür');

    // The automation notice says why in Turkish (the reason code), in English the server's own text.
    expect(tr('flow.automation.failed', sample('flow.automation.failed', 1))).toBe(
      '“Çökme raporu” otomatik akışı başlatılamadı: Aynı anda çalışabilecek akış sınırına ulaşıldı; birinin bitmesini bekleyin',
    );
    expect(tcodeEn('flow.automation.failed', sample('flow.automation.failed', 1))).toBe('The automatic flow “Çökme raporu” could not start: At most 10 runs at once');

    // REST errors go through errorText (`detail` = the specific part of the English message).
    setLanguage('tr');
    expect(errorText({ code: 'package.passphrase.wrong', message: 'The passphrase is wrong, or the file was changed after it was saved' })).toBe('Parola yanlış ya da dosya kaydedildikten sonra değiştirilmiş');
    expect(errorText({ code: 'backup.folder.unavailable', message: 'The backup folder is not available: /Volumes/Yedek/Dürbün' })).toBe(
      'Yedek klasörüne ulaşılamıyor (/Volumes/Yedek/Dürbün); disk takılı değil ya da eşitleme hesabından çıkılmış olabilir',
    );
    expect(errorText({ code: 'package.tooLarge', message: 'The file is too large (limit 256 MB)' })).toBe('Dosya çok büyük (en fazla 256 MB)');
    expect(errorText({ code: 'backup.folder.unwritable', message: "Dürbün cannot write to /Volumes/Yedek/Durbun: EACCES: permission denied, mkdir '/Volumes/Yedek/Durbun'" })).toBe(
      "Dürbün bu klasöre yazamıyor: EACCES: permission denied, mkdir '/Volumes/Yedek/Durbun'",
    );
    expect(errorText({ code: 'flow.id.invalid', message: 'Invalid flow id "Login Flow"' })).toBe('Geçersiz akış kimliği: Login Flow');
    setLanguage('en');
    expect(errorText({ code: 'package.passphrase.wrong', message: 'The passphrase is wrong, or the file was changed after it was saved' })).toBe(
      'The passphrase is wrong, or the file was changed after it was saved',
    );
    expect(errorText({ code: 'backup.folder.unwritable', message: "Dürbün cannot write to /Volumes/Yedek/Durbun: EACCES: permission denied, mkdir '/Volumes/Yedek/Durbun'" })).toBe(
      "Dürbün cannot write to this folder: EACCES: permission denied, mkdir '/Volumes/Yedek/Durbun'",
    );
  });
});

function tcodeEn(code: string, params: Record<string, string | number>): string {
  return tCodeIn('en', code, params, FALLBACK);
}
