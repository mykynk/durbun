/**
 * Which HTTP port the app uses. 9750 by default (DURBUN_PORT overrides). If a Dürbün already answers
 * there (the CLI, an older app), the window just opens on it. If another program holds the port, a
 * fixed nearby port is tried before an OS-assigned one: the UI keeps its preferences per origin, so a
 * stable fallback keeps them.
 */
import net from 'node:net';

export const DEFAULT_HTTP_PORT = 9750;
export const DEFAULT_SDK_PORT = 9751;

/**
 * The one host the app talks to: health probes, the window and "Open in Browser" all use it. Never
 * "localhost": Chromium tries ::1 first, so the window could show a program on [::1]:port while the
 * probe checked the server on 127.0.0.1:port.
 */
export const APP_HOST = '127.0.0.1';

export function originFor(port: number): string {
  return `http://${APP_HOST}:${port}`;
}

/** What a Dürbün serves at "/": its UI, or its own "the UI is not built yet" page. */
export type DurbunPage = 'ui' | 'placeholder';

export interface DurbunProbe {
  version: string;
  /** Set by proveDurbun (the health check alone leaves it out). */
  page?: DurbunPage;
}

export type PortPlan =
  | { kind: 'attach'; port: number; version: string; page?: DurbunPage }
  | { kind: 'start'; port: number; fallback: boolean };

export interface PortDeps {
  probe(port: number): Promise<DurbunProbe | undefined>;
  isFree(port: number): Promise<boolean>;
}

export function parsePortEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d{1,5}$/.test(value.trim())) return fallback;
  const n = Number(value.trim());
  return n >= 1 && n <= 65_535 ? n : fallback;
}

/** Fallback HTTP ports, in order: preferred+10, +20, +30, then 0 (OS-assigned). */
export function fallbackPorts(preferred: number, sdkPort: number): number[] {
  const out: number[] = [];
  for (const step of [10, 20, 30]) {
    const p = preferred + step;
    if (p <= 65_535 && p !== sdkPort) out.push(p);
  }
  out.push(0);
  return out;
}

/**
 * `avoid`: ports where the server's own listen() already failed with EADDRINUSE during this start (for
 * example another program holds 0.0.0.0:port while the server binds the LAN address). They are skipped,
 * so a retry moves on instead of planning the same busy port again.
 */
export async function planHttpPort(preferred: number, sdkPort: number, deps: PortDeps, avoid: ReadonlySet<number> = new Set()): Promise<PortPlan> {
  const running = await deps.probe(preferred);
  if (running) return { kind: 'attach', port: preferred, version: running.version, ...(running.page ? { page: running.page } : {}) };
  if (!avoid.has(preferred) && (await deps.isFree(preferred))) return { kind: 'start', port: preferred, fallback: false };
  for (const p of fallbackPorts(preferred, sdkPort)) {
    if (p === 0 || (!avoid.has(p) && (await deps.isFree(p)))) return { kind: 'start', port: p, fallback: true };
  }
  return { kind: 'start', port: 0, fallback: true };
}

/** GET /api/health → { ok: true, name: 'durbun', version }. Fallback for bundles without probeServer. */
export async function probeDurbun(port: number, timeoutMs = 1_200): Promise<DurbunProbe | undefined> {
  try {
    const res = await fetch(`${originFor(port)}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; name?: unknown; version?: unknown };
    if (body && body.ok === true && body.name === 'durbun') return { version: String(body.version ?? '?') };
  } catch {
    /* nothing there, or not Dürbün */
  }
  return undefined;
}

/** Dürbün versions are semver (packages/server/src/version.ts); anything else is not a Dürbün. */
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
/** The UI's index.html is ~3 KB; its markers are in <head>. */
const PAGE_READ_LIMIT = 256 * 1024;

/**
 * Which Dürbün page is this? The UI build carries <meta name="application-name" content="Dürbün">
 * (packages/ui/index.html); a server without a UI build serves its own page that links /api/health.
 */
export function classifyDurbunPage(html: string): DurbunPage | undefined {
  const s = html.normalize('NFC');
  if (/<meta\s+name=["']application-name["']\s+content=["']Dürbün["']/i.test(s)) return 'ui';
  if (/<title>\s*Dürbün\s*<\/title>/i.test(s) && /href=["']\/api\/health["']/i.test(s)) return 'placeholder';
  return undefined;
}

async function readText(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

/** GET / → the Dürbün UI (or its placeholder page). Redirects are not followed. */
async function fetchDurbunPage(port: number, timeoutMs: number): Promise<DurbunPage | undefined> {
  try {
    const res = await fetch(`${originFor(port)}/`, { headers: { accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !/^text\/html\b/i.test(type)) {
      void res.body?.cancel().catch(() => {});
      return undefined;
    }
    return classifyDurbunPage(await readText(res, PAGE_READ_LIMIT));
  } catch {
    return undefined;
  }
}

/**
 * Before the window is handed to a server that already runs on the port, it must prove it is Dürbün:
 * /api/health says name "durbun" with a semver version (`health`: the bundle's probeServer), and "/"
 * serves the Dürbün UI, or the page a Dürbün without a UI build shows. A program that only answers
 * /api/health is treated as "another program" (the app then starts its own server on a fallback port).
 */
export async function proveDurbun(
  port: number,
  opts: { health(port: number): Promise<DurbunProbe | undefined>; timeoutMs?: number },
): Promise<DurbunProbe | undefined> {
  const health = await opts.health(port).catch(() => undefined);
  if (!health || typeof health.version !== 'string' || !VERSION_RE.test(health.version)) return undefined;
  const page = await fetchDurbunPage(port, opts.timeoutMs ?? 1_500);
  return page ? { version: health.version, page } : undefined;
}

/** Can we bind host:port right now? */
export function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Does something accept TCP connections on host:port? (refused / unreachable / timeout → false) */
export function acceptsConnections(port: number, host: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.unref();
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Is the port free for Dürbün? The server binds 127.0.0.1 (the window loads APP_HOST), but browsers and
 * SDK clients that use http://localhost:port try ::1 first: a program listening on [::1]:port or
 * [::]:port (Node/Vite servers bound to "localhost" or to no host) does not stop the 127.0.0.1 bind, yet
 * those clients would reach it instead of Dürbün. Such a port counts as taken. So does a program on
 * 0.0.0.0:port: macOS lets 127.0.0.1 bind on top of it (stealing its local traffic), and the server's
 * LAN bind (settings.allowLan) fails there.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (!(await canBind(port, '127.0.0.1'))) return false;
  if (!(await canBind(port, '0.0.0.0'))) return false;
  return !(await acceptsConnections(port, '::1'));
}

/**
 * While the window shows another Dürbün (attach), check it every `intervalMs`; after `misses`
 * consecutive failed health checks call `onGone` once (the app then starts its own server, so closing
 * the terminal that ran `npm start` does not leave the app without a server). Returns a stop function.
 */
export function watchAttached(
  port: number,
  opts: { probe(port: number): Promise<DurbunProbe | undefined>; onGone(): void; intervalMs?: number; misses?: number },
): () => void {
  const intervalMs = opts.intervalMs ?? 4_000;
  const allowed = opts.misses ?? 3;
  let stopped = false;
  let missed = 0;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    const alive = await opts.probe(port).catch(() => undefined);
    if (stopped) return;
    missed = alive ? 0 : missed + 1;
    if (missed >= allowed) {
      stopped = true;
      opts.onGone();
      return;
    }
    timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
