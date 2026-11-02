import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inlineScriptHashes, resolveUiDir, uiContentSecurityPolicy } from '../../src/http/static';
import { makeTempDir, startTestApp, type TestApp } from './fakes';

let root: string;
let uiDir: string;
let t: TestApp | undefined;

const INDEX = '<!doctype html><html lang="tr"><head><title>Dürbün</title><script type="module" src="/assets/index-B4x9Qk2a.js"></script></head><body><div id="root"></div></body></html>';

beforeAll(async () => {
  root = await makeTempDir('durbun-static-');
  uiDir = path.join(root, 'dist', 'ui');
  await mkdir(path.join(uiDir, 'assets'), { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), INDEX);
  await writeFile(path.join(uiDir, 'assets', 'index-B4x9Qk2a.js'), 'console.log("dürbün")');
  await writeFile(path.join(uiDir, 'assets', 'index-C1d2e3f4.css'), ':root{--bg-app:#0B0D12}');
  await writeFile(path.join(uiDir, 'assets', 'jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  await writeFile(path.join(uiDir, 'manifest.webmanifest'), '{"name":"Dürbün"}');
  await writeFile(path.join(uiDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(uiDir, '.env'), 'SECRET=1');
  await writeFile(path.join(root, 'secret.txt'), 'top secret');
  await symlink(path.join(root, 'secret.txt'), path.join(uiDir, 'escape.txt'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await t?.close();
  t = undefined;
});

function get(port: number, pathName: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static UI', () => {
  it('serves index.html and assets with correct types and caching', async () => {
    t = await startTestApp({ uiDir });
    const index = await get(t.port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toBe(INDEX);

    const js = await get(t.port, '/assets/index-B4x9Qk2a.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get(t.port, '/assets/index-C1d2e3f4.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await get(t.port, '/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2')).headers['content-type']).toBe('font/woff2');
    const manifest = await get(t.port, '/manifest.webmanifest');
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    expect((await get(t.port, '/favicon.svg')).headers['content-type']).toBe('image/svg+xml');
  });

  it('falls back to index.html for client-side routes but not for missing assets', async () => {
    t = await startTestApp({ uiDir });
    for (const route of ['/logs', '/network/app:1:7', '/devices/android%3AR5CT1234/']) {
      const res = await get(t.port, route);
      expect(res.status, route).toBe(200);
      expect(res.body).toBe(INDEX);
    }
    const dotted = await get(t.port, '/apps/com.mykynk.pati', { Accept: 'text/html,application/xhtml+xml' });
    expect(dotted.body).toBe(INDEX);
    expect((await get(t.port, '/assets/missing-123.js')).status).toBe(404);
    expect((await get(t.port, '/missing.js', { Accept: '*/*' })).status).toBe(404);
    expect((await get(t.port, '/assets/missing-page', { Accept: 'text/html' })).status).toBe(404);
  });

  it('never serves files outside the UI directory', async () => {
    t = await startTestApp({ uiDir });
    for (const attempt of [
      '/../secret.txt',
      '/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/.env',
      '/escape.txt',
      '/%00index.html',
    ]) {
      const res = await get(t.port, attempt, { Accept: '*/*' });
      expect(res.body, attempt).not.toContain('top secret');
      expect(res.body, attempt).not.toContain('SECRET=1');
      expect(res.status, attempt).toBeGreaterThanOrEqual(400);
    }
    expect((await get(t.port, '/%E0%A4%A')).status).toBe(400);
  });

  it('supports ETag revalidation, HEAD and byte ranges', async () => {
    t = await startTestApp({ uiDir });
    const first = await get(t.port, '/assets/index-B4x9Qk2a.js');
    const etag = first.headers.etag!;
    expect(etag).toMatch(/^W\/"/);
    const again = await get(t.port, '/assets/index-B4x9Qk2a.js', { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    const head = await get(t.port, '/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(INDEX)));
    expect(head.body).toBe('');
    const range = await get(t.port, '/assets/index-C1d2e3f4.css', { Range: 'bytes=0-4' });
    expect(range.status).toBe(206);
    expect(range.body).toBe(':root');
    expect((await get(t.port, '/assets/index-C1d2e3f4.css', { Range: 'bytes=999-' })).status).toBe(416);
    expect((await get(t.port, '/', {}, 'POST')).status).toBe(405);
  });

  it('sends a Content-Security-Policy with the inline scripts hashed (never unsafe-inline scripts)', async () => {
    // a Vite-like index: one inline pre-paint script (CRLF line endings), the module bundle by src
    const inline = '\r\n      (function () { document.documentElement.setAttribute("data-theme", "dark"); })();\r\n    ';
    const dir = path.join(root, 'csp-ui');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><head><script>${inline}</script><script type="module" crossorigin src="/assets/a.js"></script></head><body></body></html>`);
    await writeFile(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
    const sha = createHash('sha256').update(inline.replace(/\r\n/g, '\n'), 'utf8').digest('base64');
    expect(inlineScriptHashes(await readFile(path.join(dir, 'index.html'), 'utf8'))).toEqual([`'sha256-${sha}'`]);

    t = await startTestApp({ uiDir: dir });
    const page = await get(t.port, '/', { Host: `localhost:${t.port}` });
    const csp = page.headers['content-security-policy'] as string;
    const directives = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
    expect(directives['script-src']).toEqual(["'self'", `'sha256-${sha}'`]);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(directives['connect-src']).toEqual(["'self'", `ws://localhost:${t.port}`]);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(directives['media-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    // client routes, assets and a revalidated (304) document carry it too
    expect((await get(t.port, '/logs', { Accept: 'text/html' })).headers['content-security-policy']).toBe((await get(t.port, '/')).headers['content-security-policy']);
    expect((await get(t.port, '/assets/a.js')).headers['content-security-policy']).toContain(`'sha256-${sha}'`);
    const revalidated = await get(t.port, '/', { 'If-None-Match': page.headers.etag! });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers['content-security-policy']).toContain(`'sha256-${sha}'`);

    // a Host header that is not a plain host[:port] never reaches the policy
    expect(uiContentSecurityPolicy([], 'evil.example; script-src *')).toContain("connect-src 'self'; ");
    expect(uiContentSecurityPolicy([], '[::1]:9750')).toContain("connect-src 'self' ws://[::1]:9750;");

    // a rebuild while the server runs: the new inline script is allowed on the next document request
    const rebuilt = 'window.rebuilt = true;';
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><head><script>${rebuilt}</script></head><body></body></html>`);
    const sha2 = createHash('sha256').update(rebuilt, 'utf8').digest('base64');
    expect((await get(t.port, '/')).headers['content-security-policy']).toContain(`script-src 'self' 'sha256-${sha2}';`);
  });

  it('shows a bilingual "please build" page when there is no UI build', async () => {
    t = await startTestApp({ uiDir: null });
    const page = await get(t.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain('npm run build');
    expect(page.body).toContain('Dürbün çalışıyor');
    expect(page.body).toContain('has not been built yet');
    expect((await get(t.port, '/logs')).body).toContain('npm run build');
    expect((await get(t.port, '/assets/index-x.js', { Accept: '*/*' })).status).toBe(404);
    // its inline <style> is allowed, scripts are not
    expect(page.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    expect(page.headers['content-security-policy']).toContain("script-src 'self';");
  });
});

describe('resolveUiDir', () => {
  it('prefers --ui-dir, then <module dir>/ui, then <repo>/dist/ui', async () => {
    const moduleDir = path.join(root, 'packages', 'server', 'src', 'http');
    await mkdir(moduleDir, { recursive: true });
    expect(resolveUiDir(uiDir, moduleDir)).toMatchObject({ dir: uiDir });
    // Walks up from the module to <repo>/dist/ui.
    expect(resolveUiDir(undefined, moduleDir).dir).toBe(uiDir);
    // Bundle layout: dist/durbun.mjs next to dist/ui.
    expect(resolveUiDir(undefined, path.join(root, 'dist')).dir).toBe(uiDir);
    // An invalid explicit dir falls back and is reported.
    const r = resolveUiDir(path.join(root, 'nope'), moduleDir);
    expect(r.dir).toBe(uiDir);
    expect(r.explicitInvalid).toBe(path.join(root, 'nope'));
    // Nothing found.
    const empty = await makeTempDir('durbun-noui-');
    expect(resolveUiDir(undefined, empty).dir).toBeNull();
    await rm(empty, { recursive: true, force: true });
  });
});
