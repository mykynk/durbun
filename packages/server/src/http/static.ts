/**
 * Static file serving: the built UI (SPA with history fallback, immutable caching for Vite's hashed
 * /assets/*), files from the temp directory (screenshots, recordings), and a bilingual placeholder page
 * when no UI build exists. Paths are decoded once, dot segments are refused and the final real path must
 * stay inside the served root (no traversal, no symlink escapes). Supports ETag/304, HEAD and single
 * byte ranges (video seeking).
 */
import { createReadStream, promises as fsp, realpathSync, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from '../config';
import { isActiveContent, mimeType } from './mime';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** Sandbox for captured/temp content a browser might execute (HTML, SVG, JS). */
export const SANDBOX_CSP =
  "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:";

export interface UiDirResolution {
  /** Directory containing index.html, or null when no build was found. */
  dir: string | null;
  /** Every candidate checked, in order. */
  tried: string[];
  /** The explicit --ui-dir, when it was given but contains no index.html. */
  explicitInvalid?: string;
}

/** Directory of the running module: dist/ in the bundle, src/http/ when run from source. */
export function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function hasIndex(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

/** UI directory resolution order (SPEC §5.4): --ui-dir → <bundle dir>/ui → <repo>/dist/ui. */
export function resolveUiDir(explicit?: string, fromDir: string = moduleDir()): UiDirResolution {
  const tried: string[] = [];
  const check = (dir: string) => {
    tried.push(dir);
    return hasIndex(dir);
  };
  let explicitInvalid: string | undefined;
  if (explicit) {
    const dir = path.resolve(expandHome(explicit));
    if (check(dir)) return { dir, tried };
    explicitInvalid = dir;
  }
  const bundled = path.join(fromDir, 'ui');
  if (check(bundled)) return { dir: bundled, tried, explicitInvalid };
  // <repo>/dist/ui: walk up from the module (src/http → repo root, or dist → repo root).
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'dist', 'ui');
    if (!tried.includes(candidate) && check(candidate)) return { dir: candidate, tried, explicitInvalid };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: null, tried, explicitInvalid };
}

export function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export async function statFile(p: string): Promise<Stats | undefined> {
  try {
    return await fsp.stat(p);
  } catch {
    return undefined;
  }
}

export interface SendFileOptions {
  cacheControl: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Add the sandbox CSP when the content type could execute (HTML/SVG/XML/JS). */
  sandboxActive?: boolean;
}

function sendPlain(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/** Stream a file with ETag/304, HEAD and single-range (206/416) support. */
export function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, stat: Stats, opts: SendFileOptions): void {
  const size = stat.size;
  const etag = `W/"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const type = opts.contentType ?? mimeType(filePath);
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': opts.cacheControl,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ...opts.headers,
  };
  if (opts.sandboxActive && isActiveContent(type)) headers['Content-Security-Policy'] = SANDBOX_CSP;

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': opts.cacheControl });
    res.end();
    return;
  }

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    // Multi-range or malformed headers are ignored (full response), as RFC 9110 allows.
  }
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(filePath, { start, end });
  stream.on('error', (err) => res.destroy(err));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export interface FallbackInfo {
  version: string;
}

export function fallbackPageHtml(info: FallbackInfo): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dürbün</title>
<style>
:root { color-scheme: dark light; --bg:#0B0D12; --panel:#11141B; --text:#E6E9F0; --muted:#9AA3B5; --accent:#7C6CF2; --border:#232937; --code:rgba(124,108,242,.16); }
@media (prefers-color-scheme: light) { :root { --bg:#F5F6F9; --panel:#FFFFFF; --text:#161A23; --muted:#5B6476; --accent:#5B4BE0; --border:#E3E6EE; --code:rgba(91,75,224,.10); } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width:min(600px, calc(100vw - 32px)); padding:28px 32px; background:var(--panel); border:1px solid var(--border); border-radius:10px; }
h1 { font-size:18px; margin:0 0 2px; } h1 span { color:var(--accent); }
p { margin:12px 0; } .en { color:var(--muted); margin-top:2px; }
code { font-family:"SF Mono", ui-monospace, Menlo, monospace; font-size:13px; background:var(--code); padding:2px 7px; border-radius:4px; }
a { color:var(--accent); } footer { margin-top:20px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<main>
<h1><span>◉◉</span> Dürbün çalışıyor</h1>
<p class="en">Dürbün is running — but its web interface has not been built yet.</p>
<p>Arayüzü derlemek için depo klasöründe çalıştırın, sonra bu sayfayı yenileyin:<br>
<span class="en">Build the UI from the repository root, then reload this page:</span></p>
<p><code>npm run build</code></p>
<p>Geliştirme modu (canlı yenileme): <code>npm run dev</code> → <a href="http://localhost:5173">http://localhost:5173</a><br>
<span class="en">Development mode with hot reload.</span></p>
<footer>Sunucu / server v${info.version} · <a href="/api/health">/api/health</a></footer>
</main>
</body>
</html>
`;
}

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;

/** Serve the UI build from `uiDir` (or the placeholder page when null). */
export function createStaticHandler(uiDir: string | null, info: () => FallbackInfo): StaticHandler {
  let root: string | null = null;
  if (uiDir) {
    try {
      root = realpathSync(uiDir);
    } catch {
      root = null;
    }
  }

  return async (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlain(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendPlain(res, 400, 'Bad request');
      return;
    }
    if (decoded.includes('\0')) {
      sendPlain(res, 400, 'Bad request');
      return;
    }
    const segments = decoded.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.') || s.includes('\\'))) {
      sendPlain(res, 404, 'Not found');
      return;
    }
    const isAsset = segments[0] === 'assets';
    const last = segments[segments.length - 1] ?? '';
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    const spaRoute = !isAsset && (!last.includes('.') || wantsHtml);

    if (!root) {
      if (spaRoute || last === 'index.html') {
        const html = fallbackPageHtml(info());
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(html)),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : html);
      } else {
        sendPlain(res, 404, 'Not found (the UI is not built: npm run build)');
      }
      return;
    }

    let filePath = segments.length > 0 ? path.join(root, ...segments) : path.join(root, 'index.html');
    if (!isInside(root, filePath)) {
      sendPlain(res, 404, 'Not found');
      return;
    }
    let stat = await statFile(filePath);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await statFile(filePath);
    }
    if (stat?.isFile()) {
      const real = await fsp.realpath(filePath).catch(() => null);
      if (real && isInside(root, real)) {
        sendFile(req, res, real, stat, { cacheControl: isAsset ? IMMUTABLE_CACHE : 'no-cache' });
        return;
      }
      sendPlain(res, 404, 'Not found');
      return;
    }
    if (spaRoute) {
      const index = path.join(root, 'index.html');
      const indexStat = await statFile(index);
      if (indexStat?.isFile()) {
        sendFile(req, res, index, indexStat, { cacheControl: 'no-cache' });
        return;
      }
    }
    sendPlain(res, 404, 'Not found');
  };
}
