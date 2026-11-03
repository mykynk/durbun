/** Contract with dist/server.mjs (built by `npm run build`): what the app imports must be there. */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STRINGS } from '../src/i18n';
import { serverWarnings } from '../src/notices';
import { proveDurbun } from '../src/ports';
import { startedOrigin } from '../src/startup';

// DURBUN_TEST_SERVER_BUNDLE: a bundle built elsewhere (e.g. from the current server sources into a temp folder).
const bundle = process.env.DURBUN_TEST_SERVER_BUNDLE
  ? path.resolve(process.env.DURBUN_TEST_SERVER_BUNDLE)
  : path.resolve(__dirname, '..', '..', '..', 'dist', 'server.mjs');
const distUi = path.resolve(__dirname, '..', '..', '..', 'dist', 'ui');
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** The bundle's exports this test uses (untyped JavaScript). */
type Bundle = Record<string, any>;

/** The real server with every device driver replaced by its "unavailable" stand-in (no adb / xcrun runs). */
async function startStubbed(mod: Bundle, opts: { uiDir?: string; moduleDir: string; dataDir?: string }) {
  const reason = 'desktop contract test';
  const factories = {
    ...mod.defaultFactories,
    createPlatform: () => ({ drivers: ['android', 'ios-sim', 'ios-device'].map((id) => mod.unavailableDriver(id, reason)), services: mod.unavailableServices(reason) }),
    createFlutterVmModule: () => mod.unavailableVm(reason),
  };
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-contract-'));
  return mod.startServerWith({ httpPort: 0, sdkPort: 0, demo: false, dataDir, uiDir: opts.uiDir, verbose: false }, factories, {
    logger: silent,
    moduleDir: opts.moduleDir,
    driverStartWaitMs: 0,
  });
}

function listen(server: net.Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)));
}

describe.skipIf(!existsSync(bundle))('dist/server.mjs', () => {
  it('exports startServer, probeServer and ServerStartError without side effects', async () => {
    const mod = await import(pathToFileURL(bundle).href);
    expect(typeof mod.startServer).toBe('function');
    expect(typeof mod.probeServer).toBe('function');
    expect(typeof mod.ServerStartError).toBe('function');
    expect(new mod.ServerStartError('busy', 'EADDRINUSE', 9750).code).toBe('EADDRINUSE');
  });

  it('a busy HTTP port rejects with code EADDRINUSE (the app moves on to the next port)', async () => {
    const mod = await import(pathToFileURL(bundle).href);
    const holder = net.createServer();
    const port = await listen(holder);
    try {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-contract-'));
      const err = await mod.startServer({ httpPort: port, sdkPort: 0, demo: false, dataDir, verbose: false }, { logger: silent }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: 'ServerStartError', code: 'EADDRINUSE', port });
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });

  it('probeServer tells a Dürbün from another program', async () => {
    const mod = await import(pathToFileURL(bundle).href);
    const fake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify({ ok: true, name: 'durbun', version: '9.9.9' }) : '{}');
    });
    const other = http.createServer((_req, res) => res.end('<html>vite</html>'));
    const [a, b] = [await listen(fake), await listen(other)];
    try {
      expect(await mod.probeServer(a)).toEqual({ version: '9.9.9' });
      expect(await mod.probeServer(b)).toBeUndefined();
    } finally {
      await Promise.all([fake, other].map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  });

  it('the real server proves it is Dürbün before it gets the window: with its UI, and without a UI build', async () => {
    const mod = await import(pathToFileURL(bundle).href);
    const health = (port: number) => mod.probeServer(port);
    const nowhere = mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-noui-'));
    const cases: { uiDir?: string; page: string }[] = [{ uiDir: undefined, page: 'placeholder' }];
    if (existsSync(path.join(distUi, 'index.html'))) cases.push({ uiDir: distUi, page: 'ui' });
    for (const c of cases) {
      const server = await startStubbed(mod, { uiDir: c.uiDir, moduleDir: nowhere });
      try {
        const { port, origin } = startedOrigin(server, 0);
        expect(origin).toBe(`http://127.0.0.1:${port}`);
        const version = (await health(port))?.version;
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
        expect(await proveDurbun(port, { health })).toEqual({ version, page: c.page });
      } finally {
        await server.stop();
      }
    }
  });

  it('every settings.json warning the real server sends gets the tray\'s own wording', async (ctx) => {
    const mod = await import(pathToFileURL(bundle).href);
    const nowhere = mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-noui-'));
    const files: [unknown, number][] = [
      // a refused value, a value outside its range, a cleaned-up list, an unknown key
      [{ captureBodies: 'yes', maxLogEntries: 5_000_000, watchedApps: [' com.a ', 'com.a'], noSuchSetting: 1 }, 4],
      [[1, 2], 1], // not an object
    ];
    for (const [content, expected] of files) {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-contract-'));
      writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(content));
      const server = await startStubbed(mod, { moduleDir: nowhere, dataDir });
      try {
        // bundles before StartedServer.notices: only the English warnings (shown as they are)
        if (!Array.isArray(server.notices)) ctx.skip();
        const notices = (server.notices as { code: string; params?: Record<string, unknown>; message: string }[]).filter(
          (n) => n.code === 'config.invalid' && n.params?.file === 'settings.json',
        );
        expect(notices).toHaveLength(expected);
        for (const t of [STRINGS.tr, STRINGS.en]) {
          for (const n of notices) {
            const own = t.serverNotice(n.code, n.params ?? {});
            expect(own, `${n.message} has no wording of its own`).toBeTruthy();
            expect(own).not.toBe(n.message);
          }
          expect(new Set(serverWarnings(t, { notices })).size).toBe(expected);
        }
      } finally {
        await server.stop();
      }
    }
  });
});
