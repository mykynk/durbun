import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { androidActionsFor, escapeInputText, runAndroidAction, type AndroidActionTarget } from '../../src/platform/android/actions';
import type { Adb } from '../../src/platform/android/adb';
import type { RunResult } from '../../src/platform/exec';
import { createCtx } from './helpers';

function ok(stdout = '', stderr = ''): RunResult<string> {
  return { ok: true, code: 0, signal: null, stdout, stderr, timedOut: false };
}
function bad(stderr: string, code = 1): RunResult<string> {
  return { ok: false, code, signal: null, stdout: '', stderr, timedOut: false };
}

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function fakeAdb(handlers: { shell?: (cmd: string) => RunResult<string>; run?: (args: string[]) => RunResult<string> }) {
  const calls: string[] = [];
  const adb = {
    path: '/fake/adb',
    tool: { path: '/fake/adb', source: 'path' },
    async shell(_serial: string, cmd: string) {
      calls.push(`shell ${cmd}`);
      return handlers.shell ? handlers.shell(cmd) : ok();
    },
    async run(args: string[]) {
      calls.push(args.join(' '));
      return handlers.run ? handlers.run(args) : ok();
    },
    async runBuffer(args: string[]) {
      calls.push(args.join(' '));
      return { ok: true, code: 0, signal: null, stdout: PNG, stderr: '', timedOut: false } as RunResult<Buffer>;
    },
  } as unknown as Adb;
  return { adb, calls };
}

function target(adb: Adb, extra: Partial<AndroidActionTarget> = {}): AndroidActionTarget {
  return {
    adb,
    serial: 'R58M123ABC',
    deviceId: 'android:R58M123ABC',
    label: 'Galaxy S21',
    isEmulator: false,
    apiLevel: 34,
    ctx: createCtx(),
    restartLogs: async () => {},
    ...extra,
  };
}

describe('androidActionsFor', () => {
  it('lists only what works for the device', () => {
    expect(androidActionsFor({ online: false, isEmulator: false })).toEqual([]);
    const phone = androidActionsFor({ online: true, isEmulator: false, apiLevel: 34 });
    expect(phone).toContain('screenshot');
    expect(phone).toContain('appearance');
    expect(phone).not.toContain('location');
    expect(phone).not.toContain('push-notification');
    expect(androidActionsFor({ online: true, isEmulator: true, apiLevel: 34 })).toContain('location');
    expect(androidActionsFor({ online: true, isEmulator: false, apiLevel: 28 })).not.toContain('appearance');
  });
});

describe('runAndroidAction', () => {
  it('quotes URLs for the device shell', async () => {
    const { adb, calls } = fakeAdb({ shell: () => ok('Starting: Intent { act=android.intent.action.VIEW }') });
    const r = await runAndroidAction(target(adb), 'open-url', { url: "pati://item?id=1&ref=it's" });
    expect(r.ok).toBe(true);
    expect(calls[0]).toBe(
      "shell am start -a android.intent.action.VIEW -d 'pati://item?id=1&ref=it'\\''s'",
    );
  });

  it('reports am start errors', async () => {
    const { adb } = fakeAdb({
      shell: () => ok('Starting: Intent { ... }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=foo:// }'),
    });
    const r = await runAndroidAction(target(adb), 'open-url', { url: 'foo://' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('action.openUrlFailed');
    expect(r.message).toContain('unable to resolve Intent');
  });

  it('saves screenshots into tempDir and returns the file URL', async () => {
    const { adb, calls } = fakeAdb({});
    const t = target(adb);
    const r = await runAndroidAction(t, 'screenshot', {});
    expect(r.ok).toBe(true);
    expect(calls[0]).toBe('-s R58M123ABC exec-out screencap -p');
    const data = r.data as { url: string; file: string; width: number; height: number };
    expect(data.width).toBe(1);
    expect(data.height).toBe(1);
    expect(path.dirname(data.file)).toBe(t.ctx.tempDir);
    expect(data.url).toBe(t.ctx.fileUrl(path.basename(data.file)));
    expect(fs.readFileSync(data.file).equals(PNG)).toBe(true);
  });

  it('lists apps with version / debuggable metadata', async () => {
    const { adb } = fakeAdb({
      shell: (cmd) => {
        if (cmd === 'pm list packages -3') return ok('package:com.mykynk.pati\npackage:com.whatsapp\n');
        if (cmd === 'pm list packages') return ok('package:com.mykynk.pati\npackage:com.whatsapp\npackage:com.android.settings\n');
        if (cmd.startsWith('dumpsys package packages'))
          return ok(
            '  Package [com.mykynk.pati] (1):\n    versionName=1.4.2\n    flags=[ DEBUGGABLE HAS_CODE ]\n  Package [com.whatsapp] (2):\n    versionName=2.24.1\n    flags=[ HAS_CODE ]\n',
          );
        return bad('unknown');
      },
    });
    const r = await runAndroidAction(target(adb), 'list-apps', { includeSystem: true });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([
      { id: 'com.android.settings', system: true },
      { id: 'com.mykynk.pati', system: false, version: '1.4.2', debuggable: true },
      { id: 'com.whatsapp', system: false, version: '2.24.1', debuggable: false },
    ]);
  });

  it('detects monkey launch failures and validates package names', async () => {
    const { adb } = fakeAdb({
      shell: () => ok('  bash arg: -p\n  bash arg: com.nope\n** No activities found to run, monkey aborted.'),
    });
    const r = await runAndroidAction(target(adb), 'app-launch', { appId: 'com.nope' });
    expect(r).toMatchObject({ ok: false, code: 'action.launchFailed' });
    expect(r.message).toContain('no launcher activity');
    const r2 = await runAndroidAction(target(adb), 'app-launch', { appId: '-k; reboot' });
    expect(r2).toMatchObject({ ok: false, code: 'action.invalidParams' });
  });

  it('restarts an app with force-stop + monkey', async () => {
    const { adb, calls } = fakeAdb({
      shell: (cmd) => (cmd.startsWith('monkey') ? ok('Events injected: 1\n## Network stats: elapsed time=12ms') : ok()),
    });
    const r = await runAndroidAction(target(adb), 'app-restart', { appId: 'com.mykynk.pati' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      'shell am force-stop com.mykynk.pati',
      'shell monkey -p com.mykynk.pati -c android.intent.category.LAUNCHER 1',
    ]);
  });

  it('parses install failures', async () => {
    const dir = createCtx().tempDir;
    const apk = path.join(dir, 'app-debug.apk');
    fs.writeFileSync(apk, 'PK');
    const { adb } = fakeAdb({
      run: () => bad('adb: failed to install app-debug.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'),
    });
    const r = await runAndroidAction(target(adb), 'app-install', { file: apk });
    expect(r).toMatchObject({ ok: false, code: 'action.installFailed' });
    expect(r.message).toBe('Install failed: INSTALL_FAILED_INSUFFICIENT_STORAGE');
    const missing = await runAndroidAction(target(adb), 'app-install', { file: path.join(dir, 'nope.apk') });
    expect(missing.code).toBe('action.fileNotFound');
  });

  it('builds settings/uimode/input commands', async () => {
    const { adb, calls } = fakeAdb({});
    await runAndroidAction(target(adb), 'appearance', { mode: 'dark' });
    await runAndroidAction(target(adb), 'font-scale', { scale: 1.3 });
    await runAndroidAction(target(adb), 'animations', { enabled: false });
    await runAndroidAction(target(adb), 'key-event', { key: 'back' });
    await runAndroidAction(target(adb), 'input-text', { text: "hello world it's\nnext" });
    expect(calls).toEqual([
      'shell cmd uimode night yes',
      'shell settings put system font_scale 1.3',
      'shell settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0',
      'shell input keyevent 4',
      "shell input text 'hello%sworld%sit'\\''s' && input keyevent 66 && input text next",
    ]);
    const tr = await runAndroidAction(target(adb), 'input-text', { text: 'Günaydın' });
    expect(tr).toMatchObject({ ok: false, code: 'action.inputTextAscii' });
    expect(escapeInputText('a b')).toBe('a%sb');
  });

  it('sets the location only on emulators (lon before lat for the console)', async () => {
    const { adb, calls } = fakeAdb({ run: () => ok('OK\n') });
    const phone = await runAndroidAction(target(adb), 'location', { lat: 41.0082, lon: 28.9784 });
    expect(phone.code).toBe('action.unsupported');
    const emu = await runAndroidAction(target(adb, { serial: 'emulator-5554', isEmulator: true }), 'location', {
      lat: 41.0082,
      lon: 28.9784,
    });
    expect(emu.ok).toBe(true);
    expect(calls).toEqual(['-s emulator-5554 emu geo fix 28.9784 41.0082']);
  });
});
