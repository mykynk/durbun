/** Contract with dist/server.mjs (built by `npm run build`): what the app imports must be there. */
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const bundle = path.resolve(__dirname, '..', '..', '..', 'dist', 'server.mjs');
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

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
});
