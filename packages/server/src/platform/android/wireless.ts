/**
 * Wireless debugging (Android 11+): `adb pair HOST:PORT CODE` once per phone and Mac, then `adb connect HOST:PORT`;
 * `adb mdns services` lists the phones that advertise pairing (`_adb-tls-pairing._tcp`, while the "Pair device with
 * pairing code" screen is open) or connection (`_adb-tls-connect._tcp`, while Wireless debugging is on).
 *
 * The output wording below is read from adb's own sources (packages/modules/adb: client/adb_wifi.cpp for pair,
 * socket_spec.cpp / client/commandline.cpp for connect, client/mdns_utils + transport_mdns for the list); the
 * parsers match loosely and keep the raw text as `detail` for anything they do not know.
 */
import type { AdbWirelessService } from '@durbun/protocol';
import { tailLines } from '../shared/text';
import type { Adb } from './adb';

export interface WirelessOutcome {
  ok: boolean;
  /** i18n code (`adb.wireless.*`, `action.toolMissing`). */
  code: string;
  message: string;
  params?: Record<string, string>;
  /** `adb pair`: the phone's adb guid. */
  guid?: string;
  /** `adb connect`: the serial adb now lists the phone under ("192.168.1.20:41235"). */
  serial?: string;
}

const clean = (text: string) => tailLines(text.replace(/[^\x20-\x7e\n\t]/g, ''), 3, 300);

/** `adb pair` output (stdout and stderr together). */
export function parsePairOutput(text: string): WirelessOutcome {
  const ok = /Successfully paired to (\S+) \[guid=([^\]\s]+)\]/.exec(text);
  if (ok) return { ok: true, code: 'adb.wireless.paired', message: `Paired with ${ok[1]}`, guid: ok[2] };
  if (/Wrong password or connection was dropped/i.test(text)) {
    return { ok: false, code: 'adb.wireless.wrongCode', message: 'Wrong pairing code, or the connection dropped' };
  }
  if (/Unable to start pairing client/i.test(text)) {
    return { ok: false, code: 'adb.wireless.unreachable', message: 'The phone could not be reached at this address' };
  }
  if (/Failed to parse address|Invalid port/i.test(text)) {
    return { ok: false, code: 'adb.wireless.badAddress', message: 'The address is not valid', params: { detail: clean(text) } };
  }
  if (/unknown command|unknown option/i.test(text)) {
    return { ok: false, code: 'adb.wireless.adbTooOld', message: 'This adb has no wireless pairing (platform-tools 30 or newer has)' };
  }
  return { ok: false, code: 'adb.wireless.failed', message: `Pairing failed: ${clean(text) || 'no output'}`, params: { detail: clean(text) || 'no output' } };
}

/** `adb connect` output. */
export function parseConnectOutput(text: string): WirelessOutcome {
  const ok = /^(?:already )?connected to (\S+)/m.exec(text);
  if (ok) return { ok: true, code: 'adb.wireless.connected', message: `Connected to ${ok[1]}`, serial: ok[1] };
  if (/failed to authenticate/i.test(text)) {
    return { ok: false, code: 'adb.wireless.notPaired', message: 'The phone does not know this Mac yet: pair it first' };
  }
  if (/Connection refused/i.test(text)) {
    return { ok: false, code: 'adb.wireless.refused', message: 'The phone refused the connection at this address' };
  }
  if (/No route to host|timed out|Network is unreachable|Host is down/i.test(text)) {
    return { ok: false, code: 'adb.wireless.unreachable', message: 'The phone could not be reached at this address' };
  }
  if (/cannot resolve host|bad port|invalid port/i.test(text)) {
    return { ok: false, code: 'adb.wireless.badAddress', message: 'The address is not valid', params: { detail: clean(text) } };
  }
  return { ok: false, code: 'adb.wireless.failed', message: `Could not connect: ${clean(text) || 'no output'}`, params: { detail: clean(text) || 'no output' } };
}

/** "192.168.1.20:37099" / "[fe80::1]:37099" → host and port. */
export function splitHostPort(addr: string): { host: string; port: number } | undefined {
  const m = /^\[([0-9A-Fa-f:.%a-zA-Z]+)\]:(\d{1,5})$/.exec(addr) ?? /^([^\s:[\]]+):(\d{1,5})$/.exec(addr);
  if (!m) return undefined;
  const port = Number(m[2]);
  return port > 0 && port <= 65535 ? { host: m[1]!, port } : undefined;
}

/**
 * `adb mdns services`: a header line, then one service per line, "name<TAB>type<TAB>host:port" (type with or without
 * the trailing dot). Unknown lines are skipped.
 */
export function parseMdnsServices(text: string): AdbWirelessService[] {
  const out: AdbWirelessService[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const m = /^\s*(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+(\S+)\s*$/.exec(raw);
    if (!m) continue;
    const addr = splitHostPort(m[3]!);
    if (!addr) continue;
    const kind = m[2] === 'pairing' ? 'pairing' : 'connect';
    const key = `${kind}|${m[1]}|${addr.host}:${addr.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = m[1]!;
    // "adb-<serial>-<6 random>": the phone's own serial number.
    const serial = /^adb-(.+)-[A-Za-z0-9]{6}$/.exec(name)?.[1];
    out.push({ name, kind, host: addr.host, port: addr.port, ...(serial ? { serial } : {}) });
  }
  return out;
}

/** Valid host for pair / connect: IPv4, IPv6 or a host name; never something adb would read as an option. */
export function validWirelessHost(host: unknown): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((p) => Number(p) <= 255);
  if (/^[0-9A-Fa-f:]+(%[A-Za-z0-9]+)?$/.test(host) && host.includes(':')) return true;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/.test(host);
}

export function wirelessAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export const PAIR_TIMEOUT_MS = 45_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const MDNS_TIMEOUT_MS = 8_000;

/** The adb calls behind the "Pair over Wi-Fi" screen. */
export class AdbWireless {
  constructor(private readonly adb: Pick<Adb, 'run'>) {}

  async pair(host: string, port: number, code: string): Promise<WirelessOutcome> {
    const r = await this.adb.run(['pair', wirelessAddress(host, port), code], { timeoutMs: PAIR_TIMEOUT_MS });
    if (r.timedOut) return { ok: false, code: 'adb.wireless.timeout', message: 'The phone did not answer in time' };
    return parsePairOutput(`${r.stdout}\n${r.stderr}\n${r.error ?? ''}`);
  }

  async connect(host: string, port: number): Promise<WirelessOutcome> {
    const r = await this.adb.run(['connect', wirelessAddress(host, port)], { timeoutMs: CONNECT_TIMEOUT_MS });
    if (r.timedOut) return { ok: false, code: 'adb.wireless.timeout', message: 'The phone did not answer in time' };
    return parseConnectOutput(`${r.stdout}\n${r.stderr}\n${r.error ?? ''}`);
  }

  /** Phones on this network that advertise wireless debugging; `ok: false` when this adb cannot look. */
  async discover(): Promise<{ ok: boolean; services: AdbWirelessService[]; detail?: string }> {
    const r = await this.adb.run(['mdns', 'services'], { timeoutMs: MDNS_TIMEOUT_MS });
    const text = `${r.stdout}\n${r.stderr}`;
    if (!r.ok && !/List of discovered mdns services/i.test(text)) return { ok: false, services: [], detail: clean(text || r.error || '') };
    return { ok: true, services: parseMdnsServices(r.stdout) };
  }
}
