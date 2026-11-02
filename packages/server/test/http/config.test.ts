import { readdir, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MockRule, type ServerSettings } from '@durbun/protocol';
import {
  cleanTempDir,
  ConfigValidationError,
  expandHome,
  loadConfig,
  normalizeSettings,
  validateMockRules,
  validateSettingsPatch,
  writeFileAtomic,
} from '../../src/config';
import { makeTempDir } from './fakes';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('durbun-config-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;

describe('loadConfig', () => {
  it('creates the data and temp directories and starts from the defaults without writing anything', async () => {
    const dataDir = path.join(dir, 'nested', '.durbun');
    const config = await loadConfig(dataDir);
    expect(config.dataDir).toBe(dataDir);
    expect(config.tempDir).toBe(path.join(dataDir, 'tmp'));
    expect((await stat(config.tempDir)).isDirectory()).toBe(true);
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
    expect(config.mocks).toEqual([]);
    expect(config.warnings).toEqual([]);
    expect(await readdir(dataDir)).toEqual(['tmp']);
  });

  it('merges settings.json over the defaults, clamping and rejecting bad values', async () => {
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        maxLogEntries: 50_000,
        maxBodyBytes: 999_999_999,
        logcatTail: '300',
        iosSimLogScope: 'everything',
        captureBodies: 'false',
        watchedApps: 'com.pati, com.pati.dev',
        adbPath: '~/Library/Android/sdk/platform-tools/adb',
        theme: 'dark',
      }),
    );
    const config = await loadConfig(dir);
    expect(config.settings).toMatchObject({
      maxLogEntries: 50_000,
      maxBodyBytes: 10 * 1024 * 1024,
      logcatTail: 300,
      iosSimLogScope: 'apps',
      captureBodies: false,
      watchedApps: ['com.pati', 'com.pati.dev'],
      adbPath: expandHome('~/Library/Android/sdk/platform-tools/adb'),
    });
    expect(config.warnings.join('\n')).toMatch(/maxBodyBytes 999999999 → 10485760/);
    expect(config.warnings.join('\n')).toMatch(/iosSimLogScope must be one of apps, all/);
    expect(config.warnings.join('\n')).toMatch(/unknown setting "theme"/);
  });

  it('keeps a copy of a corrupt settings.json and falls back to defaults', async () => {
    await writeFile(path.join(dir, 'settings.json'), '{ "maxLogEntries": 5000, ');
    const config = await loadConfig(dir);
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
    expect(config.warnings[0]).toMatch(/settings\.json could not be read/);
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  it('loads valid mock rules and skips broken ones', async () => {
    await writeFile(
      path.join(dir, 'mocks.json'),
      JSON.stringify([
        { id: 'a', enabled: true, method: 'get', url: '/v1/pets', match: 'contains', action: { type: 'respond', status: 200, body: '[]' }, createdAt: 1 },
        { id: 'b', url: '/x', action: { type: 'explode' } },
      ]),
    );
    const config = await loadConfig(dir);
    expect(config.mocks.map((r) => r.id)).toEqual(['a']);
    expect(config.mocks[0]!.method).toBe('GET');
    expect(config.warnings.join('\n')).toMatch(/rule #2: action type must be respond, delay or fail — rule skipped/);
  });

  it('removes temp entries older than 24 hours at start', async () => {
    const tmp = path.join(dir, 'tmp');
    await mkdir(path.join(tmp, 'old-extracted.app'), { recursive: true });
    await writeFile(path.join(tmp, 'old-shot.png'), 'x');
    await writeFile(path.join(tmp, 'fresh-shot.png'), 'y');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(path.join(tmp, 'old-shot.png'), old, old);
    await utimes(path.join(tmp, 'old-extracted.app'), old, old);
    await loadConfig(dir);
    expect((await readdir(tmp)).sort()).toEqual(['fresh-shot.png']);
  });
});

describe('ConfigStore.updateSettings', () => {
  it('persists only explicitly set keys, atomically, and notifies listeners', async () => {
    const config = await loadConfig(dir);
    const seen: [ServerSettings, ServerSettings][] = [];
    config.onSettings((s, prev) => seen.push([s, prev]));
    const result = config.updateSettings({ maxLogEntries: 300_000, iosSimLogLevel: 'debug', unknownKey: 1 });
    expect(result.changed.sort()).toEqual(['iosSimLogLevel', 'maxLogEntries']);
    expect(result.ignored).toEqual(['unknownKey']);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0].maxLogEntries).toBe(300_000);
    expect(seen[0]![1].maxLogEntries).toBe(200_000);
    await config.flush();
    expect(await readJson(path.join(dir, 'settings.json'))).toEqual({ maxLogEntries: 300_000, iosSimLogLevel: 'debug' });
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await stat(path.join(dir, 'settings.json'))).mode & 0o777).toBe(0o600);

    // No-op patch: no event, no change.
    config.updateSettings({ maxLogEntries: 300_000 });
    expect(seen).toHaveLength(1);

    // Clearing an optional path removes it from the file.
    config.updateSettings({ adbPath: '/opt/homebrew/bin/adb' });
    config.updateSettings({ adbPath: '' });
    await config.flush();
    expect(await readJson(path.join(dir, 'settings.json'))).not.toHaveProperty('adbPath');
    expect(config.settings.adbPath).toBeUndefined();

    // Reload sees the persisted values.
    const reloaded = await loadConfig(dir);
    expect(reloaded.settings.maxLogEntries).toBe(300_000);
    expect(reloaded.settings.iosSimLogLevel).toBe('debug');
  });

  it('rejects type errors as a whole', async () => {
    const config = await loadConfig(dir);
    expect(() => config.updateSettings({ maxLogEntries: 'lots', allowLan: true })).toThrow(ConfigValidationError);
    expect(config.settings.allowLan).toBe(false);
    expect(() => config.updateSettings('nope')).toThrow(/settings must be an object/);
  });

  it('serializes concurrent writes so the file ends with the last state', async () => {
    const config = await loadConfig(dir);
    for (let i = 1; i <= 25; i++) config.updateSettings({ logcatTail: i * 100 });
    await config.flush();
    expect(await readJson(path.join(dir, 'settings.json'))).toEqual({ logcatTail: 2_500 });
  });

  it('treats --lan as a per-run override until the user changes allowLan', async () => {
    const config = await loadConfig(dir, { lanOverride: true });
    expect(config.settings.allowLan).toBe(true);
    expect(config.storedSettings.allowLan).toBe(false);
    // Echoing the effective value (UI sends full settings) must not persist the override.
    config.updateSettings({ allowLan: true, logcatTail: 10 });
    await config.flush();
    expect(await readJson(path.join(dir, 'settings.json'))).toEqual({ logcatTail: 10 });
    // An explicit change wins and is persisted.
    const r = config.updateSettings({ allowLan: false });
    expect(r.changed).toEqual(['allowLan']);
    expect(config.settings.allowLan).toBe(false);
    await config.flush();
    expect(await readJson(path.join(dir, 'settings.json'))).toEqual({ logcatTail: 10, allowLan: false });
  });

  it('reports write failures to listeners instead of throwing', async () => {
    const dataDir = path.join(dir, 'ro');
    const config = await loadConfig(dataDir);
    const errors: string[] = [];
    config.onWriteError((err, file) => errors.push(`${path.basename(file)}: ${err.message}`));
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, 'now a file, not a directory');
    config.updateSettings({ logcatTail: 1 });
    await config.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^settings\.json: /);
  });
});

describe('mock rules', () => {
  it('normalizes rules and gives duplicate ids a fresh id', () => {
    const { rules, problems } = validateMockRules(
      [
        { id: 'r1', method: ' post ', url: '*/login', match: 'glob', apps: [' com.pati ', ''], action: { type: 'respond', status: '503', headers: [['Retry-After', 30]], delayMs: -5 } },
        { id: 'r1', method: '', url: 'cdn', action: { type: 'fail', error: 'dns', message: '  ' } },
        { url: '/slow', action: { type: 'delay', delayMs: 99_999_999 } },
      ],
      1_000,
    );
    expect(problems).toEqual([]);
    expect(rules[0]).toEqual({
      id: 'r1',
      enabled: true,
      method: 'POST',
      url: '*/login',
      match: 'glob',
      apps: ['com.pati'],
      action: { type: 'respond', status: 503, headers: [['Retry-After', '30']] },
      createdAt: 1_000,
    });
    expect(rules[1]!.id).not.toBe('r1');
    expect(rules[1]).toMatchObject({ method: '*', match: 'contains', action: { type: 'fail', error: 'dns' } });
    expect(rules[1]!.action).not.toHaveProperty('message');
    expect(rules[2]!.action).toEqual({ type: 'delay', delayMs: 600_000 });
    expect(rules[2]!.id).toMatch(/^mock-/);
  });

  it('reports invalid rules with their position and name', () => {
    const { rules, problems } = validateMockRules([
      { name: 'Login 500', url: '/login', action: { type: 'respond', status: 700 } },
      { url: '/x', method: 'GET /x', action: { type: 'delay', delayMs: 1 } },
      { url: '/b64', action: { type: 'respond', status: 200, body: 'not base64!!', bodyEncoding: 'base64' } },
      'nope',
    ]);
    expect(rules).toEqual([]);
    expect(problems).toEqual([
      'rule #1 (Login 500): status must be an integer between 100 and 599',
      "rule #2: method must be '*' or an HTTP method",
      'rule #3: body is not valid base64',
      'rule #4: must be an object',
    ]);
    expect(validateMockRules({}).problems).toEqual(['mock rules must be a list']);
  });

  it('setMocks persists valid rules and rejects the whole list on any problem', async () => {
    const config = await loadConfig(dir);
    const seen: MockRule[][] = [];
    config.onMocks((r) => seen.push(r));
    const saved = config.setMocks([{ id: 'ok', url: '/a', action: { type: 'respond', status: 204 } }]);
    expect(() => config.setMocks([{ id: 'bad', url: 5, action: { type: 'respond', status: 204 } }])).toThrow(/rule #1: url must be a string/);
    expect(config.mocks).toEqual(saved);
    expect(seen).toEqual([saved]);
    await config.flush();
    expect(await readJson(path.join(dir, 'mocks.json'))).toEqual(saved);
  });
});

describe('helpers', () => {
  it('validateSettingsPatch separates problems, adjustments and unknown keys', () => {
    const v = validateSettingsPatch({ metricsIntervalMs: 10, allowLan: 'maybe', foo: 1, idevicesyslogPath: null });
    expect(v.values).toEqual({ metricsIntervalMs: 250, idevicesyslogPath: undefined });
    expect(v.problems).toEqual(['allowLan must be true or false']);
    expect(v.adjusted).toEqual(['metricsIntervalMs 10 → 250 (allowed 250–60000)']);
    expect(v.unknown).toEqual(['foo']);
  });

  it('normalizeSettings never mutates the base', () => {
    const base = { ...DEFAULT_SETTINGS, watchedApps: ['a'] };
    const { settings } = normalizeSettings({ watchedApps: ['b'] }, base);
    expect(settings.watchedApps).toEqual(['b']);
    expect(base.watchedApps).toEqual(['a']);
  });

  it('writeFileAtomic replaces content and leaves no temp files', async () => {
    const file = path.join(dir, 'x.json');
    await writeFileAtomic(file, '1');
    await writeFileAtomic(file, '2');
    expect(await readFile(file, 'utf8')).toBe('2');
    expect(await readdir(dir)).toEqual(['x.json']);
    await expect(writeFileAtomic(path.join(dir, 'missing', 'y.json'), '1')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['x.json']);
  });

  it('cleanTempDir returns how many entries it removed', async () => {
    await writeFile(path.join(dir, 'a'), '1');
    expect(await cleanTempDir(dir, 1_000, Date.now() + 10_000)).toBe(1);
    expect(await cleanTempDir(path.join(dir, 'nope'))).toBe(0);
  });
});
