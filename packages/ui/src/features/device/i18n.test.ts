import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setLanguage } from '../../i18n';
import { messageKeys } from '../../i18n/core';
import './i18n';
import '../perf/i18n';
import { codeText, describeError, fixHint, logStreamText, stateText } from './codes';
import { ACTION_GROUP_ORDER, ANDROID_FONT_PRESETS, ANDROID_KEYS, BUILTIN_APP_ACTIONS, IOS_CONTENT_SIZES, LOCATION_PRESETS, APNS_TEMPLATES } from './model';
import { PERF_WINDOWS } from '../perf/model';

const FEATURES = ['device', 'perf'];

function sources(): string[] {
  const out: string[] = [];
  const src = existsSync(join(process.cwd(), 'src/features')) ? join(process.cwd(), 'src') : join(process.cwd(), 'packages/ui/src');
  for (const f of FEATURES) {
    const dir = join(src, 'features', f);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isFile() && /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  }
  return out;
}

afterEach(() => setLanguage('en'));

describe('device + perf dictionaries', () => {
  it('Turkish and English define the same keys', () => {
    const own = (k: string) => k.startsWith('device.') || k.startsWith('perf.');
    const tr = new Set(messageKeys('tr').filter(own));
    const en = new Set(messageKeys('en').filter(own));
    expect(tr.size).toBeGreaterThan(300);
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
  });

  it('every literal key used in the source exists in both languages', () => {
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const keys = new Set<string>();
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b(?:t|tNow)\(\s*'((?:device|perf|common|code)\.[A-Za-z0-9_.-]+)'/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(150);
    expect([...keys].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, readonly string[]> = {
      'device.tools.action': [...BUILTIN_APP_ACTIONS],
      'device.tools.group': [...ACTION_GROUP_ORDER],
      'device.tools.option': ['system', 'light', 'dark', 'default', 'android', 'iOS', 'macOS'],
      'device.look.size': IOS_CONTENT_SIZES.map((s) => s.id),
      'device.look.font': ANDROID_FONT_PRESETS.map((p) => p.key),
      'device.input.key': [...ANDROID_KEYS],
      'device.loc.city': LOCATION_PRESETS.map((p) => p.id),
      'device.info.connectionType': ['usb', 'wifi', 'local', 'unknown'],
      'device.info.kindType': ['physical', 'emulator', 'simulator', 'virtual'],
      'device.apps.done': ['launch', 'stop', 'restart', 'clearData', 'uninstall'],
      'device.apps.failed': ['launch', 'stop', 'restart', 'clearData', 'uninstall'],
      'device.apps': ['launch', 'stop', 'restart', 'clearData', 'uninstall'],
      'device.apps.install': ['aab', 'wrongPlatform', 'unknownType', 'empty'],
      'device.push.templates': Object.keys(APNS_TEMPLATES),
      'device.push.error': ['notObject', 'noAps'],
      'device.url.problem': ['spaces', 'noScheme'],
      'device.look.done': ['dark', 'light'],
      'device.bar.done': ['clean', 'reset'],
      'perf.window': [...PERF_WINDOWS],
      'perf.table.cols': ['cpu', 'memory', 'heap', 'fps', 'jank', 'logs', 'errorLogs', 'requests', 'failed'],
      'perf.events': ['crash', 'anr', 'marker', 'connect', 'reconnect'],
      'code.state': ['online', 'offline', 'unauthorized', 'disconnected'],
      'code.logStatus': ['starting', 'streaming', 'unavailable', 'stopped', 'error'],
    };
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const missing: string[] = [];
    for (const [prefix, ids] of Object.entries(families)) for (const id of ids) if (!tr.has(`${prefix}.${id}`) || !en.has(`${prefix}.${id}`)) missing.push(`${prefix}.${id}`);
    expect(missing).toEqual([]);
  });

  it('every SPEC §9.3 code the views can meet is localized', () => {
    const codes = [
      'command.invalid', 'command.unknown', 'command.failed', 'command.timeout', 'command.disconnected', 'command.aborted',
      'device.unknown', 'device.readOnly', 'device.noActions', 'device.networkOnly',
      'action.failed', 'action.timeout', 'action.invalidResult', 'action.invalidParams', 'action.unsupported', 'action.deviceOffline',
      'action.deviceNotFound', 'action.toolMissing', 'action.screenshotRefused', 'action.unsupportedFile', 'action.launchFailed',
      'action.uninstallFailed', 'action.openUrlFailed', 'action.installFailed', 'action.fileNotFound', 'action.appNotFound', 'action.inputTextAscii',
      'app.unknown', 'app.disconnected', 'app.timeout', 'app.notConnected', 'app.commandTimeout', 'app.commandsUnsupported', 'app.notInstalled',
      'server.shutdown', 'config.invalid', 'vm.unavailable', 'vm.timeout', 'vm.noServiceUrl', 'vm.attachFailed', 'metrics.unsupported',
      'demo.unavailable', 'demo.timeout', 'demo.inactive', 'demo.unsupportedAction', 'demo.actionFailed', 'demo.stopped',
      'params.invalid', 'screenshot.writeFailed', 'sdk.unavailable',
      'device.unauthorized', 'device.authorizing', 'device.noPermissions', 'device.notBooted', 'device.offline', 'device.untrusted',
      'device.simulatorShutdown', 'device.driverStopped', 'device.imported', 'device.networkIdle',
      'logs.adbMissing', 'logs.deviceOffline', 'logs.processExited', 'logs.idevicesyslogMissing', 'logs.usbmuxdUnavailable', 'logs.simctlMissing', 'logs.networkOnly',
    ];
    for (const lang of ['tr', 'en'] as const) {
      setLanguage(lang);
      expect(codes.filter((c) => !codeText(c))).toEqual([]);
    }
  });
});

describe('code localization helpers', () => {
  it('prefers the foundation dictionary, falls back to the view dictionary', () => {
    setLanguage('tr');
    expect(codeText('command.timeout')).toBeTruthy();
    expect(codeText('action.inputTextAscii')).toMatch(/ASCII/);
    expect(codeText('does.not.exist')).toBeUndefined();
    expect(codeText(undefined)).toBeUndefined();
    // State headlines use the short wording; the fix hint is separate.
    expect(stateText({ state: 'unauthorized', stateCode: 'device.unauthorized' })).toBe('USB hata ayıklama izni bekleniyor');
    expect(stateText({ state: 'online' })).toBe('Bağlı');
    expect(fixHint('device.untrusted')).toMatch(/Güven/);
    expect(fixHint('device.whatever')).toBeUndefined();
    expect(logStreamText({ logs: { status: 'unavailable', code: 'logs.idevicesyslogMissing' } })).toBe('idevicesyslog bulunamadı');
    expect(logStreamText({ logs: { status: 'streaming' } })).toBe('Loglar akıyor');
  });

  it('describes errors: localized text + server detail; generic codes keep the specific server message', () => {
    setLanguage('tr');
    expect(describeError({ code: 'app.notInstalled', message: 'com.x is not installed on this device' })).toEqual({
      text: codeText('app.notInstalled'),
      detail: 'com.x is not installed on this device',
      code: 'app.notInstalled',
    });
    expect(codeText('app.notInstalled')).toMatch(/yüklü değil/);
    // Generic codes keep the specific part of the server message in the localized text.
    const generic = describeError({ code: 'action.failed', message: 'Could not stop com.x: adb: device offline' });
    expect(generic.text).toContain('adb: device offline');
    expect(generic.detail).toBeUndefined();
    expect(describeError(new Error('boom'))).toEqual({ text: 'boom', code: undefined });
    expect(describeError({ code: 'command.timeout', message: '' }).text).toBe(codeText('command.timeout'));
    expect(describeError({ code: 'weird.code', message: '' }).text).toBe('Bilinmeyen bir hata oluştu');
    setLanguage('en');
    const d = describeError({ code: 'metrics.unsupported', message: 'raw server text' });
    expect(d.text).toBe(codeText('metrics.unsupported'));
    expect(d.text).toMatch(/not available/);
    expect(d.detail).toBe('raw server text');
  });
});
