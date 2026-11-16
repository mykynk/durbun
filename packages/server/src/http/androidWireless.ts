/**
 * /api/android/wireless — pair an Android 11+ phone over Wi-Fi from the UI (SPEC §5.5):
 *   GET                       → AdbWirelessState (adb present?, phones advertising wireless debugging)
 *   POST /pair    {host, port, code}  → AdbWirelessResult; on success it also connects when the phone's connect
 *                                       service is found on the same host
 *   POST /connect {host, port}        → AdbWirelessResult
 * Once connected, the Android driver's device tracker picks the phone up like any other.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdbWirelessResult, AdbWirelessService, AdbWirelessState, DeviceInfo } from '@durbun/protocol';
import type { DeviceDriver } from '../types';
import { validWirelessHost, wirelessAddress, type AdbWireless, type WirelessOutcome } from '../platform/android/wireless';
import { HttpError, readJson, sendJson } from './util';

export interface WirelessDeps {
  drivers: () => readonly DeviceDriver[];
  devices: () => readonly DeviceInfo[];
  /** Tests: wait between a pairing and the look for its connect service (default 1.5 s). */
  settleMs?: number;
}

type WirelessDriver = DeviceDriver & { wireless(): AdbWireless | undefined };

function wirelessOf(deps: WirelessDeps): AdbWireless | undefined {
  const d = deps.drivers().find((x): x is WirelessDriver => x.id === 'android' && typeof (x as Partial<WirelessDriver>).wireless === 'function');
  return d?.wireless();
}

const notAllowed = (allow: string) => Object.assign(new HttpError(405, 'Method not allowed', 'method.notAllowed'), { allow });

function bad(param: string, expected: string): HttpError {
  return new HttpError(400, `${param} is not valid`, 'action.invalidParams', { param, expected });
}

function parsePort(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw bad('port', 'port');
  return n;
}

function parseHost(v: unknown): string {
  const host = typeof v === 'string' ? v.trim().replace(/^\[(.*)\]$/, '$1') : '';
  if (!validWirelessHost(host)) throw bad('host', 'host');
  return host;
}

/** The six digits the phone shows; spaces and dashes the tester may type are dropped. */
function parseCode(v: unknown): string {
  const code = typeof v === 'string' ? v.replace(/[\s-]/g, '') : typeof v === 'number' ? String(v) : '';
  if (!/^\d{6}$/.test(code)) throw bad('code', 'pairingCode');
  return code;
}

/** Is this advertised phone already connected over Wi-Fi? */
export function isServiceConnected(s: AdbWirelessService, devices: readonly DeviceInfo[]): boolean {
  if (s.kind !== 'connect') return false;
  const addr = wirelessAddress(s.host, s.port);
  return devices.some(
    (d) =>
      d.platform === 'android' &&
      d.state === 'online' &&
      (d.serial === addr || d.serial === `${s.name}._adb-tls-connect._tcp` || d.serial === `${s.name}._adb-tls-connect._tcp.` ||
        (!!s.serial && d.hardwareSerial === s.serial && (d.connection === 'wifi' || !!d.connections?.includes('wifi')))),
  );
}

function result(o: WirelessOutcome, address: string): AdbWirelessResult {
  return {
    ok: o.ok,
    code: o.code,
    message: o.message,
    address,
    ...(o.params ? { params: o.params } : {}),
    ...(o.serial ? { serial: o.serial } : {}),
  };
}

export function createWirelessModule(deps: WirelessDeps) {
  let pairing = false;

  async function state(): Promise<AdbWirelessState> {
    const w = wirelessOf(deps);
    if (!w) return { adb: false, discovery: 'unavailable', services: [] };
    const found = await w.discover();
    const devices = deps.devices();
    return {
      adb: true,
      discovery: found.ok ? 'ok' : 'unavailable',
      services: found.services.map((s) => (isServiceConnected(s, devices) ? { ...s, connected: true } : s)),
      ...(found.detail ? { detail: found.detail } : {}),
    };
  }

  function need(): AdbWireless {
    const w = wirelessOf(deps);
    if (!w) throw new HttpError(503, 'adb is not available', 'action.toolMissing', { tool: 'adb' });
    return w;
  }

  async function pair(body: Record<string, unknown>): Promise<AdbWirelessResult> {
    const host = parseHost(body.host);
    const port = parsePort(body.port);
    const code = parseCode(body.code);
    const w = need();
    if (pairing) throw new HttpError(409, 'A pairing is already running', 'adb.wireless.busy');
    pairing = true;
    try {
      const o = await w.pair(host, port, code);
      const out = result(o, wirelessAddress(host, port));
      if (!o.ok) return out;
      // The phone keeps its connect service (another port) on the same address; adb may also connect by itself.
      await new Promise((r) => setTimeout(r, deps.settleMs ?? 1500));
      const found = await w.discover();
      const svc = found.services.find((s) => s.kind === 'connect' && s.host === host);
      if (!svc) return out;
      if (isServiceConnected(svc, deps.devices())) return { ...out, connected: { ok: true, address: wirelessAddress(svc.host, svc.port), code: 'adb.wireless.connected' } };
      const c = await w.connect(svc.host, svc.port);
      return {
        ...out,
        ...(c.serial ? { serial: c.serial } : {}),
        connected: { ok: c.ok, address: wirelessAddress(svc.host, svc.port), code: c.code, message: c.message },
      };
    } finally {
      pairing = false;
    }
  }

  async function connect(body: Record<string, unknown>): Promise<AdbWirelessResult> {
    const host = parseHost(body.host);
    const port = parsePort(body.port);
    const o = await need().connect(host, port);
    return result(o, wirelessAddress(host, port));
  }

  async function handle(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<void> {
    const method = req.method ?? 'GET';
    if (segs[1] !== 'wireless' || segs.length > 3) throw new HttpError(404, 'Not found', 'api.notFound');
    if (segs.length === 2) {
      if (method !== 'GET' && method !== 'HEAD') throw notAllowed('GET, HEAD');
      return sendJson(res, 200, await state());
    }
    const op = segs[2];
    if (op !== 'pair' && op !== 'connect') throw new HttpError(404, 'Not found', 'api.notFound');
    if (method !== 'POST') throw notAllowed('POST');
    const body = await readJson(req, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required', 'body.invalidJson');
    const b = body as Record<string, unknown>;
    return sendJson(res, 200, op === 'pair' ? await pair(b) : await connect(b));
  }

  return { prefixes: ['android'] as const, handle: (req: IncomingMessage, res: ServerResponse, segs: string[]) => handle(req, res, segs) };
}
