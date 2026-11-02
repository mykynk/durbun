/**
 * "Sistem kontrolü" — aggregates environment checks (Node.js, data directory, UI build, ports) with every
 * driver's and the Flutter VM module's `checks()` into one ToolCheck[] list. A driver whose checks throw
 * or hang is reported as an error entry instead of breaking the whole report.
 */
import { constants as fsConstants, promises as fsp } from 'node:fs';
import net from 'node:net';
import type { ToolCheck } from '@durbun/protocol';
import type { DeviceDriver, FlutterVmModule } from './types';

export const MIN_NODE_MAJOR = 20;
const DEFAULT_TIMEOUT_MS = 20_000;
const STATUS_RANK: Record<ToolCheck['status'], number> = { ok: 0, warn: 1, missing: 2, error: 3 };

export interface PortState {
  /** ToolCheck id, e.g. 'port-http'. */
  id: string;
  label: string;
  port: number;
  host: string;
  /** listening: bound by this server · failed: bind error · unknown: probe availability now. */
  state: 'listening' | 'failed' | 'unknown';
  error?: string;
}

export interface DoctorInput {
  drivers: ReadonlyArray<Pick<DeviceDriver, 'id' | 'checks'>>;
  vm?: Pick<FlutterVmModule, 'checks'> | null;
  ports?: PortState[];
  /** Resolved UI directory (null = no build found). Omit to skip the check. */
  uiDir?: string | null;
  dataDir?: string;
  nodeVersion?: string;
  /** Per-source timeout for checks() (default 20 s). */
  timeoutMs?: number;
}

export function checkNodeVersion(version: string = process.versions.node): ToolCheck {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    id: 'node',
    label: 'Node.js',
    status: ok ? 'ok' : 'error',
    version: version.startsWith('v') ? version : `v${version}`,
    path: process.execPath,
    detail: ok ? undefined : `Dürbün needs Node.js ${MIN_NODE_MAJOR} or newer`,
    fix: ok ? undefined : 'brew install node',
    docsUrl: ok ? undefined : 'https://nodejs.org/',
  };
}

/** Try to bind `host:port` briefly. */
export function probePort(port: number, host = '127.0.0.1'): Promise<'free' | 'in-use' | 'error'> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE' ? 'in-use' : 'error'));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve('free'));
    });
  });
}

export async function checkPort(p: PortState): Promise<ToolCheck> {
  const base = { id: p.id, label: p.label, path: `${p.host}:${p.port}` };
  if (p.state === 'listening') return { ...base, status: 'ok', detail: `Listening on ${p.host}:${p.port}` };
  const who = `lsof -nP -iTCP:${p.port} -sTCP:LISTEN`;
  if (p.state === 'failed') {
    return { ...base, status: 'error', detail: p.error ?? `Could not listen on ${p.host}:${p.port}`, fix: who };
  }
  const probe = await probePort(p.port, p.host);
  if (probe === 'free') return { ...base, status: 'ok', detail: 'Available' };
  if (probe === 'in-use') return { ...base, status: 'warn', detail: `Port ${p.port} is used by another program`, fix: who };
  return { ...base, status: 'warn', detail: `Could not test port ${p.port}` };
}

export function checkUiBuild(uiDir: string | null): ToolCheck {
  return uiDir
    ? { id: 'ui-build', label: 'UI build', status: 'ok', path: uiDir }
    : {
        id: 'ui-build',
        label: 'UI build',
        status: 'warn',
        detail: 'No built UI found (dist/ui). The server works, but the browser shows a placeholder page.',
        fix: 'npm run build',
      };
}

export async function checkDataDir(dataDir: string): Promise<ToolCheck> {
  try {
    await fsp.access(dataDir, fsConstants.W_OK);
    return { id: 'data-dir', label: 'Data directory', status: 'ok', path: dataDir };
  } catch (err) {
    return {
      id: 'data-dir',
      label: 'Data directory',
      status: 'error',
      path: dataDir,
      detail: `Not writable: ${(err as Error).message}`,
      fix: 'durbun --data-dir <writable folder>',
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Coerce a driver-provided check into a well-formed ToolCheck (drivers are written by other teams). */
function sanitizeCheck(raw: unknown, sourceId: string): ToolCheck | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const c = raw as Partial<ToolCheck>;
  if (typeof c.id !== 'string' || !c.id) return undefined;
  const status = c.status && c.status in STATUS_RANK ? c.status : 'warn';
  const out: ToolCheck = { id: c.id, label: typeof c.label === 'string' && c.label ? c.label : c.id, status };
  for (const key of ['version', 'path', 'detail', 'fix', 'docsUrl'] as const) {
    const value = c[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  if (status !== c.status) out.detail = `${out.detail ? out.detail + ' — ' : ''}(${sourceId} reported an unknown status)`;
  return out;
}

async function collect(sourceId: string, label: string, run: () => Promise<ToolCheck[]>, timeoutMs: number): Promise<ToolCheck[]> {
  try {
    const result = await withTimeout(Promise.resolve().then(run), timeoutMs, `${label} checks`);
    if (!Array.isArray(result)) return [];
    return result.map((c) => sanitizeCheck(c, sourceId)).filter((c): c is ToolCheck => c !== undefined);
  } catch (err) {
    return [{ id: `${sourceId}-checks`, label, status: 'error', detail: `Checks failed: ${(err as Error).message ?? String(err)}` }];
  }
}

/** Merge duplicates (same id from several drivers): keep the worst status, first one wins on ties. */
export function mergeChecks(checks: ToolCheck[]): ToolCheck[] {
  const byId = new Map<string, number>();
  const out: ToolCheck[] = [];
  for (const c of checks) {
    const at = byId.get(c.id);
    if (at === undefined) {
      byId.set(c.id, out.length);
      out.push(c);
    } else if (STATUS_RANK[c.status] > STATUS_RANK[out[at]!.status]) {
      out[at] = c;
    }
  }
  return out;
}

const DRIVER_LABELS: Record<string, string> = {
  android: 'Android',
  'ios-sim': 'iOS Simulator',
  'ios-device': 'iOS device',
  demo: 'Demo',
  'flutter-vm': 'Flutter VM Service',
};

export async function runDoctor(input: DoctorInput): Promise<ToolCheck[]> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: Promise<ToolCheck>[] = [Promise.resolve(checkNodeVersion(input.nodeVersion))];
  if (input.dataDir) env.push(checkDataDir(input.dataDir));
  if (input.uiDir !== undefined) env.push(Promise.resolve(checkUiBuild(input.uiDir)));
  for (const p of input.ports ?? []) env.push(checkPort(p));

  const sources = input.drivers.map((d) =>
    collect(`driver-${d.id}`, DRIVER_LABELS[d.id] ?? d.id, () => d.checks(), timeoutMs),
  );
  const vm = input.vm;
  if (vm) sources.push(collect('flutter-vm', DRIVER_LABELS['flutter-vm']!, () => vm.checks(), timeoutMs));

  const [envChecks, driverChecks] = await Promise.all([Promise.all(env), Promise.all(sources)]);
  return mergeChecks([...envChecks, ...driverChecks.flat()]);
}
