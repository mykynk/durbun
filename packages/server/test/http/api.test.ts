import { readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionExport } from '@durbun/protocol';
import { bodyFileName, importLabel, safeUploadName, validateSessionExport } from '../../src/http/api';
import { sampleApp, sampleDevice, sampleNetwork, startTestApp, type TestApp } from './fakes';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// 1×1 transparent PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Raw request (no client-side path normalization, custom headers). */
function raw(port: number, method: string, pathName: string, headers: Record<string, string> = {}, body?: Buffer | string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('REST API', () => {
  it('GET /api/health identifies the server', async () => {
    t = await startTestApp();
    const res = await fetch(`${t.base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, name: 'durbun', version: '0.1.0' });
  });

  it('GET /api/network/:id returns the detail with bodies; unknown ids are 404', async () => {
    t = await startTestApp();
    t.hub.network.set('app:1:7', sampleNetwork());
    const res = await fetch(`${t.base}/api/network/${encodeURIComponent('app:1:7')}`);
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail).toMatchObject({ id: 'app:1:7', status: 200, responseBody: { encoding: 'utf8' } });
    const missing = await fetch(`${t.base}/api/network/app:1:99`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'net.unknown' });
  });

  it('serves raw bodies with the original content type, sandboxed, optionally as a download', async () => {
    t = await startTestApp();
    t.hub.network.set('app:1:7', sampleNetwork());
    t.hub.network.set(
      'app:1:8',
      sampleNetwork('app:1:8', {
        url: 'https://cdn.pati.app/img/karabas.png?w=64',
        responseContentType: 'image/png',
        responseHeaders: [['content-type', 'image/png']],
        responseBody: { encoding: 'base64', data: PNG_BASE64, size: 70 },
      }),
    );
    t.hub.network.set('app:1:9', sampleNetwork('app:1:9', { responseBody: undefined, bodyEvicted: true }));
    t.hub.network.set(
      'app:1:10',
      sampleNetwork('app:1:10', {
        responseContentType: 'text/html; charset=ISO-8859-9',
        responseBody: { encoding: 'utf8', data: '<h1>Merhaba dünya</h1>', size: 4_000, truncated: true },
      }),
    );

    const json = await fetch(`${t.base}/api/network/app:1:7/body/response`);
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(json.headers.get('content-security-policy')).toContain('sandbox');
    expect(json.headers.get('content-disposition')).toBeNull();
    expect(await json.json()).toMatchObject({ total: 2 });

    const png = await fetch(`${t.base}/api/network/app:1:8/body/response?download=1`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toContain('filename="karabas.png"');
    expect(Buffer.from(await png.arrayBuffer())).toEqual(Buffer.from(PNG_BASE64, 'base64'));

    const html = await fetch(`${t.base}/api/network/app:1:10/body/response`);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('x-durbun-truncated')).toBe('1');
    expect(html.headers.get('x-durbun-body-size')).toBe('4000');
    expect(await html.text()).toBe('<h1>Merhaba dünya</h1>');

    expect((await fetch(`${t.base}/api/network/app:1:9/body/response`)).status).toBe(410);
    const none = await fetch(`${t.base}/api/network/app:1:7/body/request`);
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ code: 'body.none' });
    const head = await fetch(`${t.base}/api/network/app:1:7/body/response`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('POST /api/network/search searches URL, headers and bodies', async () => {
    t = await startTestApp();
    t.hub.network.set('app:1:7', sampleNetwork());
    t.hub.network.set('app:1:8', sampleNetwork('app:1:8', { url: 'https://api.pati.app/v1/users/me', responseBody: { encoding: 'utf8', data: '{"name":"Yusuf"}', size: 16 } }));
    const search = async (body: unknown) => {
      const res = await fetch(`${t!.base}/api/network/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { ids?: string[] } };
    };
    expect((await search({ text: 'karabaş' })).body.ids).toEqual(['app:1:7']);
    expect((await search({ text: 'YUSUF', caseSensitive: true })).body.ids).toEqual([]);
    expect((await search({ text: 'pati', ids: ['app:1:8'] })).body.ids).toEqual(['app:1:8']);
    expect((await search({ text: '' })).body.ids).toEqual(['app:1:7', 'app:1:8']);
    expect((await search({ nope: 1 })).status).toBe(400);
  });

  it('POST /api/har returns a HAR 1.2 download (all or selected ids)', async () => {
    t = await startTestApp();
    t.hub.network.set('app:1:7', sampleNetwork());
    t.hub.network.set('app:1:8', sampleNetwork('app:1:8', { startTs: 1_762_070_000_500, method: 'POST' }));
    const all = await fetch(`${t.base}/api/har`, { method: 'POST' });
    expect(all.status).toBe(200);
    expect(all.headers.get('content-disposition')).toMatch(/attachment; filename="durbun-\d{4}-\d{2}-\d{2}-\d{6}\.har"/);
    const har = (await all.json()) as { log: { version: string; creator: unknown; entries: { request: { method: string } }[] } };
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Dürbün', version: '0.1.0' });
    expect(har.log.entries.map((e) => e.request.method)).toEqual(['POST', 'GET']);

    const one = await fetch(`${t.base}/api/har`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['app:1:7', 'missing'] }) });
    expect(((await one.json()) as { log: { entries: unknown[] } }).log.entries).toHaveLength(1);
    expect((await fetch(`${t.base}/api/har`)).status).toBe(405);
    expect((await fetch(`${t.base}/api/har`, { method: 'POST', body: '{"ids":"x"}' })).status).toBe(400);
  });

  it('GET /api/export streams the session export as a download', async () => {
    t = await startTestApp();
    t.hub.upsertDevice(sampleDevice());
    t.hub.apps.set('app:1', sampleApp());
    t.hub.addLogs(3_000);
    t.hub.network.set('app:1:7', sampleNetwork());
    const res = await fetch(`${t.base}/api/export?deviceId=android:R5CT1234`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="durbun-.*\.durbun\.json"/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(t.hub.exportSession({ deviceId: 'android:R5CT1234' }))));
    expect(text).toBe(JSON.stringify(t.hub.exportSession({ deviceId: 'android:R5CT1234' })));
  });

  it('POST /api/import validates and hands the session to the hub', async () => {
    t = await startTestApp();
    const data: SessionExport = {
      format: 'durbun-session',
      version: 1,
      exportedAt: 1_762_070_100_000,
      server: { version: '0.1.0' },
      devices: [sampleDevice()],
      apps: [sampleApp()],
      logs: t.hub.addLogs(10),
      network: [sampleNetwork()],
    };
    const res = await fetch(`${t.base}/api/import?name=pati-bug-1234.durbun.json`, { method: 'POST', body: JSON.stringify(data) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceIds: ['import:1'] });
    expect(t.hub.imported[0]!.label).toBe('pati-bug-1234');
    expect(t.hub.imported[0]!.data.logs).toHaveLength(10);

    const bad = await fetch(`${t.base}/api/import`, { method: 'POST', body: JSON.stringify({ format: 'har' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'import.invalid' });
    const broken = await fetch(`${t.base}/api/import`, { method: 'POST', body: '{"format":' });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ code: 'body.invalidJson' });
  });

  it('GET /api/doctor returns tool checks', async () => {
    t = await startTestApp();
    const res = await fetch(`${t.base}/api/doctor`);
    const checks = (await res.json()) as { id: string }[];
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(['node', 'port-http', 'flutter']));
  });

  it('POST /api/upload streams into the temp dir with a safe name; /api/files serves it back', async () => {
    t = await startTestApp();
    const payload = Buffer.alloc(300_000, 7);
    const res = await fetch(`${t.base}/api/upload?name=${encodeURIComponent('../../Uygulama Sürümü (1).apk')}`, { method: 'POST', body: payload });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: string; name: string; size: number };
    expect(body.name).toBe('Uygulama_Surumu_1_.apk');
    expect(body.size).toBe(300_000);
    expect(path.dirname(body.file)).toBe(path.resolve(t.config.tempDir));
    expect(path.basename(body.file)).toMatch(/^[a-z0-9]+-[0-9a-f]{6}-Uygulama_Surumu_1_\.apk$/);
    expect(await readFile(body.file)).toEqual(payload);
    expect((await readdir(t.config.tempDir)).some((f) => f.endsWith('.part'))).toBe(false);

    const back = await fetch(`${t.base}/api/files/${encodeURIComponent(path.basename(body.file))}?download=1`);
    expect(back.status).toBe(200);
    expect(back.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(back.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await back.arrayBuffer())).toEqual(payload);
  });

  it('rejects uploads over the limit and leaves nothing behind', async () => {
    t = await startTestApp({ uploadLimitBytes: 1_000 });
    const res = await fetch(`${t.base}/api/upload?name=big.ipa`, { method: 'POST', body: Buffer.alloc(5_000) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'upload.tooLarge' });
    // Chunked upload without Content-Length: limit enforced while streaming.
    const chunked = await raw(t.port, 'POST', '/api/upload?name=big2.ipa', { 'Transfer-Encoding': 'chunked' }, Buffer.alloc(5_000));
    expect(chunked.status).toBe(413);
    await new Promise((r) => setTimeout(r, 50));
    expect(await readdir(t.config.tempDir)).toEqual([]);
  });

  it('serves temp files with range support and refuses traversal', async () => {
    t = await startTestApp();
    await writeFile(path.join(t.config.tempDir, 'screen-android-1.mp4'), Buffer.from('0123456789'));
    await writeFile(path.join(t.config.dataDir, 'secret.txt'), 'top secret');
    await writeFile(path.join(t.config.tempDir, '.hidden'), 'hidden');
    await writeFile(path.join(t.config.tempDir, 'shot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const partial = await raw(t.port, 'GET', '/api/files/screen-android-1.mp4', { Range: 'bytes=2-5' });
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 2-5/10');
    expect(partial.body.toString()).toBe('2345');
    expect(partial.headers['content-type']).toBe('video/mp4');

    const svg = await raw(t.port, 'GET', '/api/files/shot.svg');
    expect(svg.headers['content-security-policy']).toContain('sandbox');

    for (const attempt of ['/api/files/..%2Fsecret.txt', '/api/files/%2e%2e%2fsecret.txt', '/api/files/..', '/api/files/.hidden', '/api/files/..%5Csecret.txt', '/api/files/a/../../secret.txt']) {
      const res = await raw(t.port, 'GET', attempt);
      expect(res.status, attempt).toBeGreaterThanOrEqual(400);
      expect(res.body.toString()).not.toContain('top secret');
    }
  });

  it('applies loopback/origin/fetch-metadata/host checks to every /api route', async () => {
    t = await startTestApp();
    const ok = await raw(t.port, 'GET', '/api/health', { Origin: `http://localhost:${t.port}`, 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    const dev = await raw(t.port, 'GET', '/api/health', { Origin: 'http://127.0.0.1:5173' });
    expect(dev.status).toBe(200);
    const blocked: Record<string, string>[] = [
      { Origin: 'https://evil.example' },
      { Origin: `http://localhost:${t.port + 1}` },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { Host: 'rebind.attacker.example' },
    ];
    for (const headers of blocked) {
      const res = await raw(t.port, 'GET', '/api/health', headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(JSON.parse(res.body.toString())).toEqual({ error: 'Forbidden', code: 'access.denied' });
    }
  });

  it('answers unknown routes with 404 and wrong methods with 405', async () => {
    t = await startTestApp();
    expect((await fetch(`${t.base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${t.base}/api/network/x/body/sideways`)).status).toBe(404);
    const res = await fetch(`${t.base}/api/doctor`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect((await raw(t.port, 'GET', '/api/network/%E0%A4%A')).status).toBe(400);
  });
});

describe('API helpers', () => {
  it('safeUploadName keeps a readable ASCII name and the extension', () => {
    expect(safeUploadName('../../etc/passwd')).toBe('passwd');
    expect(safeUploadName('C:\\Users\\yusuf\\app-release.apk')).toBe('app-release.apk');
    expect(safeUploadName('Runner.app.zip')).toBe('Runner.app.zip');
    expect(safeUploadName('...')).toBe('upload.bin');
    expect(safeUploadName('çğıöşü İÖ.ipa')).toBe('cg_osu_IO.ipa');
    expect(safeUploadName(`${'a'.repeat(300)}.apk`)).toHaveLength(120);
    expect(safeUploadName(`${'a'.repeat(300)}.apk`).endsWith('.apk')).toBe(true);
  });

  it('validateSessionExport rejects foreign JSON and keeps object entries only', () => {
    expect(() => validateSessionExport([])).toThrow(/session file/);
    expect(() => validateSessionExport({ format: 'durbun-session', version: 2, devices: [], apps: [], logs: [], network: [] })).toThrow(/version 2/);
    expect(() => validateSessionExport({ format: 'durbun-session', version: 1, devices: [], apps: [], logs: 'x', network: [] })).toThrow(/"logs"/);
    const v = validateSessionExport({ format: 'durbun-session', version: 1, exportedAt: 5, server: { version: '0.1.0' }, devices: [{ id: 'a' }, 3], apps: [], logs: [null], network: [] });
    expect(v.devices).toEqual([{ id: 'a' }]);
    expect(v.logs).toEqual([]);
  });

  it('importLabel and bodyFileName produce friendly names', () => {
    expect(importLabel('C:/x/oturum.durbun.json', 0)).toBe('oturum');
    expect(importLabel(undefined, new Date(2026, 10, 2, 9, 5).getTime())).toBe('2026-11-02 09:05');
    const d = sampleNetwork();
    expect(bodyFileName(d, 'response', 'application/json')).toBe('pets-response.json');
    expect(bodyFileName({ ...d, url: 'https://cdn.pati.app/a/logo.svg' }, 'response', 'image/svg+xml')).toBe('logo.svg');
    expect(bodyFileName({ ...d, url: 'https://cdn.pati.app/' }, 'request', undefined)).toBe('cdn.pati.app-request.bin');
  });
});
