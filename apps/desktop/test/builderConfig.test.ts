import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateConfiguration } = require('app-builder-lib/out/util/config/config') as {
  validateConfiguration(config: unknown, logger: unknown): Promise<void>;
};
const { DebugLogger } = require('builder-util') as { DebugLogger: new (enabled?: boolean) => unknown };

const appDir = path.resolve(__dirname, '..');
const configPath = path.join(appDir, 'electron-builder.config.cjs');
const SIGNING_ENV = ['CSC_NAME', 'CSC_LINK', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

/** The config reads the signing environment when it is loaded: load a fresh copy per case. */
function loadConfig(env: Record<string, string>): Record<string, any> {
  for (const k of SIGNING_ENV) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[configPath];
  return require(configPath) as Record<string, any>;
}

describe('electron-builder.config.cjs', () => {
  const saved = Object.fromEntries(SIGNING_ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of SIGNING_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[configPath];
  });

  // An unknown key only fails at `npm run app:dist` time, after the whole build ran.
  it.each([
    ['unsigned (ad-hoc)', {}],
    ['Developer ID + notarization', { CSC_NAME: 'Developer ID Application: Test', APPLE_API_KEY: 'k.p8', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' }],
  ])('passes the installed electron-builder schema: %s', async (_name, env) => {
    const config = loadConfig(env);
    await expect(validateConfiguration(structuredClone(config), new DebugLogger(false))).resolves.toBeUndefined();
    expect(config.mac.notarize).toBe(Object.keys(env).length > 0);
    expect(config.mac.hardenedRuntime).toBe(Object.keys(env).length > 0);
  });

  it('every file it points at exists (icon, entitlements, license)', () => {
    const config = loadConfig({ CSC_NAME: 'Developer ID Application: Test' });
    const files = [config.mac.icon, config.mac.entitlements, config.mac.entitlementsInherit, ...config.extraResources.map((r: { from: string }) => r.from)];
    // out/ is produced by scripts/build.mjs; the rest are sources in the repository.
    for (const f of files.filter((f: string) => !f.startsWith('out/'))) expect(existsSync(path.join(appDir, f)), f).toBe(true);
  });

  it('every permission prompt text has a Turkish twin, and Dürbün files, recordings and HAR open from Finder', () => {
    const info = loadConfig({}).mac.extendInfo as Record<string, any>;
    const keys = Object.keys(info).filter((k) => /^NS\w+UsageDescription$/.test(k) && typeof info[k] === 'string');
    expect(keys.sort()).toEqual(['NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription', 'NSLocalNetworkUsageDescription']);
    const tr = readFileSync(path.join(appDir, 'build', 'tr.lproj', 'InfoPlist.strings'), 'utf8');
    for (const k of keys) expect(tr, k).toMatch(new RegExp(`^"${k}" = ".+";$`, 'm'));
    const types = info.CFBundleDocumentTypes.flatMap((d: { LSItemContentTypes: string[] }) => d.LSItemContentTypes);
    expect(types).toEqual(['dev.durbun.package', 'public.json', 'dev.durbun.har']);
  });
});
