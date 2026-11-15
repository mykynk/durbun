import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrefsStore, parseDesktopPrefs, parsePrefsPatch, prefsView, readDesktopPrefs } from '../src/desktopPrefs';
import { resolveConfig } from '../src/appConfig';
import { parseSummary, sameSummary } from '../src/summary';
import { diagnosticsText, doctorLines, issueUrl, lastLines, maskSecrets, shortLocation } from '../src/diagnostics';
import { STRINGS } from '../src/i18n';
import { installFileLog, pruneCrashDumps, rotatedName } from '../src/log';
import { createOpenQueue, isOpenable, OPEN_EXTENSIONS, readOpened } from '../src/openFiles';
import { badgedInside, renderTrayBitmap } from '../src/trayIcon';

const tmp = (name: string) => mkdtempSync(path.join(os.tmpdir(), `durbun-${name}-`));
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('desktop.json', () => {
  it('keeps only valid fields', () => {
    expect(parseDesktopPrefs({ autoUpdateCheck: 'yes', launches: 3.7, skippedVersion: '0.3.0', closeNoteShown: true, junk: 1 })).toEqual({ launches: 3, skippedVersion: '0.3.0', closeNoteShown: true });
    expect(parseDesktopPrefs([1])).toEqual({});
    expect(parseDesktopPrefs({ skippedVersion: '../x', lastUpdateCheck: -5 })).toEqual({});
  });
  it('writes changes in order and reads them back; a broken file means nothing chosen', async () => {
    const file = path.join(tmp('prefs'), 'desktop.json');
    const store = createPrefsStore(file);
    void store.update({ launches: 1 });
    await store.update({ autoUpdateCheck: true, launches: 2 });
    expect(readDesktopPrefs(file)).toEqual({ autoUpdateCheck: true, launches: 2 });
    writeFileSync(file, '{ not json');
    expect(readDesktopPrefs(file)).toEqual({});
  });
});

describe('files opened from Finder', () => {
  it('accepts Dürbün packages, backups, session recordings and HAR files', () => {
    expect(isOpenable('/x/team.durbun')).toBe(true);
    expect(isOpenable('/x/durbun-2026.durbun.json')).toBe(true);
    expect(isOpenable('/x/trace.HAR')).toBe(true);
    expect(OPEN_EXTENSIONS).toEqual(['durbun', 'json', 'har']);
    expect(isOpenable('/x/notes.txt')).toBe(false);
    expect(isOpenable('/x/app.ipa')).toBe(false);
  });
  it('queues paths once each, oldest first, bounded', () => {
    const q = createOpenQueue(3);
    for (const f of ['a', 'b', 'a', 'c', 'd']) q.add(f);
    expect(q.size).toBe(3);
    expect(q.take()).toEqual(['b', 'c', 'd']);
    expect(q.take()).toEqual([]);
  });
  it('reads a file for the UI and turns problems into a reason', async () => {
    const fs = (size: number, text: string | Error) => ({
      size: async () => size,
      read: async () => {
        if (text instanceof Error) throw text;
        return text;
      },
    });
    expect(await readOpened('/a/s.durbun.json', fs(10, '{"format":"durbun-session"}'))).toEqual({ name: 's.durbun.json', text: '{"format":"durbun-session"}' });
    expect(await readOpened('/a/big.durbun', fs(600 * 1024 * 1024, ''))).toEqual({ name: 'big.durbun', error: 'tooLarge' });
    expect(await readOpened('/a/gone.durbun', fs(1, new Error('ENOENT')))).toEqual({ name: 'gone.durbun', error: 'unreadable' });
    expect(await readOpened('/a/x.har', fs(1, '{"log":{}}'))).toEqual({ name: 'x.har', text: '{"log":{}}' });
    expect(await readOpened('/a/x.zip', fs(1, ''))).toEqual({ name: 'x.zip', error: 'unsupported' });
  });
  it('every problem has a Turkish and an English message', () => {
    for (const t of [STRINGS.tr, STRINGS.en]) for (const p of ['tooLarge', 'unreadable', 'unsupported'] as const) expect(t.openFailedMessage('a.durbun', p)).toContain('a.durbun');
  });
});

describe('diagnostic info', () => {
  it('masks tokens, cookies, passwords and URL query values', () => {
    const masked = maskSecrets(
      [
        'GET https://api.example.com/v1/me?token=abc123&page=2 200',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        'cookie=session=xyz; other=1',
        '{"password": "hunter2", "user": "ok"}',
        'https://user:pw@host/path',
        'https://hooks.slack.com/services/T000/B000/XXXX',
      ].join('\n'),
    );
    for (const secret of ['abc123', 'eyJhbGci', 'xyz', 'hunter2', 'user:pw', 'T000/B000']) expect(masked).not.toContain(secret);
    expect(masked).toContain('page=••••');
    expect(masked).toContain('"user": "ok"');
  });
  it('keeps the last lines of a tail read', () => {
    expect(lastLines('cut line\na\nb\nc\n', 2, true)).toBe('b\nc');
    expect(lastLines('a\nb', 5)).toBe('a\nb');
  });
  it('summarizes the tool check, with details only for problems', () => {
    expect(doctorLines([{ id: 'adb', label: 'adb', status: 'ok', version: '35.0.2', detail: 'fine' }, { id: 'ios', label: 'idevicesyslog', status: 'missing', detail: 'not found' }, 7])).toEqual([
      '✓ adb 35.0.2',
      '✖ idevicesyslog: not found',
    ]);
    expect(doctorLines(undefined)).toEqual([]);
  });
  it('builds one text with versions, environment, warnings, tools and the log', () => {
    const text = diagnosticsText({
      app: '0.3.0',
      electron: '45.2.1',
      chrome: '142.0',
      node: '22.20.0',
      server: '0.3.0',
      macos: '15.1',
      arch: 'x64',
      translated: true,
      packaged: true,
      mode: 'running',
      httpPort: 9750,
      sdkPort: 9751,
      lan: false,
      signature: 'developerId',
      location: '/Applications/Dürbün.app',
      warnings: ['SDK port 9751 is in use'],
      doctor: [{ id: 'adb', label: 'adb', status: 'ok' }],
      logTail: 'line with ?key=secret',
    });
    expect(text).toContain('- Mac app: 0.3.0 (packaged, developerId)');
    expect(text).toContain('- Server: 0.3.0 · running · HTTP 9750 · SDK 9751 · LAN off');
    expect(text).toContain('macOS 15.1 · x64 under Rosetta on arm64');
    expect(text).toContain('- SDK port 9751 is in use');
    expect(text).toContain('- ✓ adb');
    expect(text).toContain('?key=••••');
  });
  it('prefills the bug report form with short values only', () => {
    const url = new URL(issueUrl({ app: '0.3.0', macos: '15.1', arch: 'arm64', translated: false }));
    expect(url.origin + url.pathname).toBe('https://github.com/mykynk/durbun/issues/new');
    expect(Object.fromEntries(url.searchParams)).toEqual({ template: 'bug_report.yml', area: 'Mac app', version: '0.3.0', environment: 'macOS 15.1 · arm64' });
  });
  it('says where the app runs without the home folder name', () => {
    expect(shortLocation('/Users/someone/Downloads/Dürbün.app', '/Users/someone')).toBe('~/Downloads/Dürbün.app');
    expect(shortLocation('/private/var/folders/a/T/AppTranslocation/X/d/Dürbün.app', '/Users/someone')).toMatch(/^App Translocation/);
    expect(shortLocation('/Volumes/Dürbün 0.3.0/Dürbün.app', '/Users/someone')).toBe('a disk image or external volume');
  });
});

describe('diagnostic log rotation', () => {
  it('rotates while writing and keeps two older files', async () => {
    const file = path.join(tmp('log'), 'logs', 'main.log');
    const log = installFileLog(file, { maxBytes: 2_000, keep: 2 });
    for (let i = 0; i < 120; i++) {
      log.info(`line ${i} ${'x'.repeat(60)}`);
      if (i % 20 === 19) await settle(20);
    }
    await settle();
    const names = readdirSync(path.dirname(file)).sort();
    expect(names).toEqual(['main.1.log', 'main.2.log', 'main.log']);
    for (const n of names) expect(statSync(path.join(path.dirname(file), n)).size).toBeLessThanOrEqual(2_200);
    expect(readFileSync(file, 'utf8')).toContain('line 119');
    expect(rotatedName('/a/main.log', 2)).toBe('/a/main.2.log');
  });
  it('a log already over the limit at start moves aside', async () => {
    const dir = tmp('log');
    const file = path.join(dir, 'main.log');
    writeFileSync(file, 'x'.repeat(5_000));
    installFileLog(file, { maxBytes: 1_000 }).info('fresh');
    await settle();
    expect(readFileSync(path.join(dir, 'main.1.log'), 'utf8')).toHaveLength(5_000);
    expect(readFileSync(file, 'utf8')).toContain('fresh');
  });
});

describe('crash dumps', () => {
  it('drops dumps older than 30 days and all but the newest 20', async () => {
    const dir = tmp('crashpad');
    const completed = path.join(dir, 'completed');
    mkdirSync(completed);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 25; i++) {
      const f = path.join(completed, `${String(i).padStart(2, '0')}.dmp`);
      writeFileSync(f, 'dump');
      const t = (now - i * 60_000) / 1000;
      utimesSync(f, t, t);
    }
    const old = path.join(completed, 'old.dmp');
    writeFileSync(old, 'dump');
    writeFileSync(path.join(completed, 'old.meta'), 'meta');
    utimesSync(old, (now - 40 * day) / 1000, (now - 40 * day) / 1000);
    writeFileSync(path.join(completed, 'settings.dat'), 'keep');
    expect(await pruneCrashDumps(dir, { now })).toBe(6);
    const left = readdirSync(completed);
    expect(left.filter((n) => n.endsWith('.dmp'))).toHaveLength(20);
    expect(left).toContain('00.dmp');
    expect(left).not.toContain('24.dmp');
    expect(left).not.toContain('old.meta');
    expect(left).toContain('settings.dat');
    expect(await pruneCrashDumps(path.join(dir, 'missing'))).toBe(0);
  });
});

describe('menu-bar icon attention dot', () => {
  it('adds a dot in the top-right corner, separated from the glyph', () => {
    const plain = renderTrayBitmap(36, 3);
    const badged = renderTrayBitmap(36, 3, true);
    const alpha = (b: Buffer, x: number, y: number) => b[(y * 36 + x) * 4 + 3]!;
    expect(alpha(plain, 31, 6)).toBe(0);
    expect(alpha(badged, 31, 6)).toBe(255);
    expect(badgedInside(23.8, 8.4)).toBe(true);
    expect(badgedInside(23.8, 8.4 + 4.6)).toBe(false); // the clear ring
    // the dot stays inside the bitmap (no cut edge): the outermost column and row are empty
    for (let i = 0; i < 36; i++) {
      expect(alpha(badged, 35, i)).toBe(0);
      expect(alpha(badged, i, 0)).toBe(0);
    }
  });
});

describe('Settings bridge values', () => {
  it('null until asked; Open at Login only where it works', () => {
    expect(prefsView({}, { openAtLogin: false, available: true })).toEqual({ autoUpdateCheck: null, openAtLogin: false, openAtLoginAvailable: true });
    expect(prefsView({ autoUpdateCheck: false }, { openAtLogin: true, available: true })).toEqual({ autoUpdateCheck: false, openAtLogin: true, openAtLoginAvailable: true });
    expect(prefsView({ autoUpdateCheck: true }, { openAtLogin: true, available: false })).toEqual({ autoUpdateCheck: true, openAtLogin: false, openAtLoginAvailable: false });
  });
  it('a patch keeps only known boolean keys', () => {
    expect(parsePrefsPatch({ autoUpdateCheck: true, openAtLogin: 'yes', httpPort: 1 })).toEqual({ autoUpdateCheck: true });
    expect(parsePrefsPatch(null)).toEqual({});
    expect(parsePrefsPatch([true])).toEqual({});
  });
});

describe('ports and verbose logging for an app started from Finder', () => {
  const defaults = { httpPort: 9750, sdkPort: 9751 };
  it('environment first, then desktop.json, then the defaults', () => {
    expect(resolveConfig({}, {}, defaults)).toEqual({ httpPort: 9750, sdkPort: 9751, verbose: false, source: { httpPort: 'default', sdkPort: 'default', verboseLog: 'default' } });
    expect(resolveConfig({}, { httpPort: 9850, sdkPort: 9851, verboseLog: true }, defaults)).toMatchObject({ httpPort: 9850, sdkPort: 9851, verbose: true, source: { httpPort: 'file', verboseLog: 'file' } });
    expect(resolveConfig({ DURBUN_PORT: '9950', DURBUN_DEBUG: '1' }, { httpPort: 9850 }, defaults)).toMatchObject({ httpPort: 9950, sdkPort: 9751, verbose: true, source: { httpPort: 'env', sdkPort: 'default', verboseLog: 'env' } });
    // A broken variable falls through to the file.
    expect(resolveConfig({ DURBUN_SDK_PORT: 'abc' }, { sdkPort: 9851 }, defaults).sdkPort).toBe(9851);
  });
  it('desktop.json keeps only real ports', () => {
    expect(parseDesktopPrefs({ httpPort: 70000, sdkPort: 9751.5, verboseLog: 'yes' })).toEqual({});
    expect(parseDesktopPrefs({ httpPort: 9850, verboseLog: false })).toEqual({ httpPort: 9850, verboseLog: false });
  });
});

describe('menu-bar summary', () => {
  it('reads the counts, stops on 404, shows nothing on anything else', () => {
    expect(parseSummary(200, { devices: 2, apps: 3 })).toEqual({ devices: 2, apps: 3 });
    expect(parseSummary(404, null)).toBe('unsupported');
    expect(parseSummary(500, null)).toBeUndefined();
    expect(parseSummary(200, { devices: -1, apps: 3 })).toBeUndefined();
    expect(parseSummary(200, { devices: '2', apps: 3 })).toBeUndefined();
    expect(sameSummary({ devices: 1, apps: 1 }, { devices: 1, apps: 1 })).toBe(true);
    expect(sameSummary(undefined, { devices: 0, apps: 0 })).toBe(false);
  });
  it('says it in both languages, with English plurals', () => {
    expect(STRINGS.en.summaryLine(1, 1)).toBe('1 device · 1 app');
    expect(STRINGS.en.summaryLine(2, 0)).toBe('2 devices · 0 apps');
    expect(STRINGS.tr.summaryLine(2, 3)).toBe('2 cihaz · 3 uygulama');
  });
});
