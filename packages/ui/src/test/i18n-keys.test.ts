import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeys, translate } from '../i18n/core';
import '../i18n/foundation';
import '../i18n/codes';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'test') walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const FOUNDATION = /^(common|shell|code)\./;

describe('foundation dictionaries', () => {
  it('every literal t() key used in the UI source exists in Turkish and English', () => {
    const keys = new Set<string>();
    const srcDir = existsSync(join(process.cwd(), 'src/i18n')) ? join(process.cwd(), 'src') : join(process.cwd(), 'packages/ui/src');
    for (const f of walk(srcDir)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'((?:common|shell|code)\.[A-Za-z0-9_.-]+)'/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(200);
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    expect([...keys].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('Turkish and English define exactly the same keys', () => {
    const tr = new Set(messageKeys('tr').filter((k) => FOUNDATION.test(k)));
    const en = new Set(messageKeys('en').filter((k) => FOUNDATION.test(k)));
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });

  it('dynamic key families used by the shell are complete', () => {
    const families: Record<string, readonly string[]> = {
      'shell.tabs': ['logs', 'network', 'mocks', 'perf', 'device'],
      'shell.theme': ['system', 'dark', 'light'],
      'shell.settings.sections': ['appearance', 'logs', 'network', 'connection', 'about'],
      'shell.sdk.tabs': ['flutter', 'android', 'ios', 'react-native'],
      'shell.sdk.usb': ['flutter', 'android', 'ios', 'react-native'],
      'shell.sdk.wifi': ['flutter', 'android', 'ios', 'react-native'],
      'shell.sidebar.section': ['live', 'demo', 'import', 'other'],
      'shell.doctor.status': ['ok', 'warn', 'missing', 'error'],
      'shell.doctor.drivers': ['android', 'ios-sim', 'ios-device', 'flutter-vm', 'demo'],
      'code.state': ['online', 'offline', 'unauthorized', 'disconnected'],
      'code.logStatus': ['starting', 'streaming', 'unavailable', 'stopped', 'error'],
      'common.levelHint': ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'],
      'shell.sdk.releaseBy': ['flutter', 'android', 'ios', 'react-native'],
      'shell.attention.tips': ['unauthorized', 'untrusted', 'offline', 'noPermissions', 'notBooted'],
      'shell.doctor.groups': ['durbun', 'android', 'ios', 'flutter', 'other'],
      'shell.doctor.labels': ['node', 'data-dir', 'ui-build', 'port-http', 'port-sdk', 'adb', 'simctl', 'usbmuxd', 'idevicesyslog', 'devicectl', 'idevicescreenshot', 'flutter-vm', 'driver', 'driverChecks'],
      'shell.doctor.fix': ['installXcode', 'installUsbmuxd', 'then', 'whoUsesPort', 'buildUi', 'dataDir', 'restartUsbmuxd', 'selectXcode'],
      // Every key DETAILS in src/shell/doctorText.ts maps to.
      'shell.doctor.detail': [
        'listening',
        'available',
        'portInUse',
        'portUntested',
        'cannotListen',
        'nodeTooOld',
        'notWritable',
        'noUiBuild',
        'fromSettings',
        'fromAndroidHome',
        'fromAndroidSdk',
        'fromPath',
        'fromFlutterCache',
        'badConfiguredPath',
        'adbNotFound',
        'adbVersionFailed',
        'bootedSimulators',
        'xcodeMissing',
        'cltOnly',
        'xcrunMissing',
        'noDeveloperDir',
        'simctlNotFound',
        'macOnly',
        'devicesAttached',
        'syslogMissing',
        'syslogFailed',
        'devicectlCaps',
        'devicectlMissing',
        'screenshotNotNeeded',
        'notFound',
        'vmStatus',
        'checksFailed',
        'initFailed',
        'yes',
        'no',
        'autoOn',
        'autoOff',
      ],
      'code.part.sdk': ['flutter', 'android', 'ios', 'react-native', 'js', 'dart-vm', 'demo'],
      'code.part.transport': ['adb-reverse', 'usbmux', 'tcp', 'websocket', 'vm-service', 'demo', 'import'],
    };
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const missing: string[] = [];
    for (const [prefix, ids] of Object.entries(families))
      for (const id of ids) if (!tr.has(`${prefix}.${id}`) || !en.has(`${prefix}.${id}`)) missing.push(`${prefix}.${id}`);
    expect(missing).toEqual([]);
  });

  it('localizes the server codes listed in SPEC §4 with natural Turkish', () => {
    const codes = [
      'device.connected',
      'device.disconnected',
      'app.connected',
      'app.disconnected',
      'app.reconnected',
      'process.started',
      'process.died',
      'marker',
      'logs.streamStarted',
      'logs.streamStopped',
      'logs.streamError',
      'vm.attached',
      'vm.detached',
    ];
    for (const c of codes) {
      expect(messageKeys('tr')).toContain(`code.${c}`);
      expect(messageKeys('en')).toContain(`code.${c}`);
    }
    // Real server params (SPEC §9.2); see src/i18n/codes.test.ts for the exhaustive checks.
    expect(translate('tr', 'code.device.connected', { device: 'Pixel 8' })).toBe('Pixel 8 bağlandı');
    expect(translate('tr', 'code.process.died', { process: 'com.mykynk.pati', pid: 12345 })).toBe('com.mykynk.pati sonlandı · pid 12345');
    expect(translate('tr', 'code.app.connected', { app: 'Pati' })).toBe('Pati bağlandı');
    expect(translate('tr', 'code.marker')).toBe('İşaret');
    expect(translate('tr', 'code.marker', { label: '', n: 2 })).toBe('İşaret 2');
    expect(translate('tr', 'code.marker', { label: 'Ödeme testi', n: 2 })).toBe('Ödeme testi');
  });
});
