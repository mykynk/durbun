/**
 * Requests the Mac sends itself (replay, flow `http.request` steps) must never reach Dürbün's own server: its
 * HTTP port serves the REST API (captured traffic, environment secrets, settings) to any loopback client, and a
 * shared flow could read it and post it elsewhere. Two layers:
 *  - before every hop (redirects included), the target is refused when its port is one of Dürbün's own ports
 *    and its host is this Mac (loopback, 0.0.0.0, one of the Mac's interface addresses or host names, or a name
 *    that resolves to one of them);
 *  - a desktop request to this Mac (any port; a local proxy could forward to Dürbün) carries
 *    DESKTOP_REQUEST_HEADER, and checkLocalAccess (security.ts) refuses /api and /ui requests that carry it.
 *    Remote targets never get it (a public name that resolves to 127.0.0.1 fails checkLocalAccess's Host rule).
 * Other services on this Mac (a tester's backend on localhost:3000) stay reachable.
 */
import dns from 'node:dns';
import os from 'node:os';
import type { I18nParams } from '@durbun/protocol';

/** Header on requests the Mac sends itself to this Mac; the REST API and /ui refuse requests that carry it. */
export const DESKTOP_REQUEST_HEADER = 'X-Durbun-Desktop';
export const DESKTOP_REQUEST_HEADER_VALUE = '1';
/** i18n code of a refused desktop request (replay command error, flow step error). */
export const OWN_SERVER_CODE = 'net.ownServer';

export type HostLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (hostname) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Lowercase address without IPv6 brackets or zone; IPv4-mapped IPv6 in its dotted IPv4 form. */
export function normalizeAddress(address: string): string {
  let a = address.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  a = a.replace(/%.*$/, '');
  const mapped = /^::ffff:(.+)$|^(?:0{1,4}:){5}ffff:(.+)$/.exec(a);
  const rest = mapped?.[1] ?? mapped?.[2];
  if (rest) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  if (a === '0:0:0:0:0:0:0:1') return '::1';
  if (a === '0:0:0:0:0:0:0:0') return '::';
  return a;
}

/** Addresses of this Mac's network interfaces (normalized). */
export function ownAddresses(): Set<string> {
  const out = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(normalizeAddress(a.address));
  } catch {
    // no interface list: loopback and 0.0.0.0 still count
  }
  return out;
}

/** This Mac's host names (lowercase): the full name, its first label and the Bonjour ".local" form. */
export function ownNames(): Set<string> {
  const out = new Set<string>();
  try {
    const name = os.hostname().trim().toLowerCase().replace(/\.$/, '');
    const label = name.split('.')[0];
    if (name) out.add(name);
    if (label) out.add(label).add(`${label}.local`);
  } catch {
    // no host name
  }
  return out;
}

/** True for an address that reaches this Mac: loopback, unspecified (0.0.0.0 / :: connect locally) or an interface address. */
export function isThisMacAddress(address: string, own: Set<string> = ownAddresses()): boolean {
  const a = normalizeAddress(address);
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || /^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true;
  if (a === '::1' || a === '::') return true;
  return own.has(a);
}

const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/**
 * True when a URL host names this Mac without a DNS lookup: localhost names, local IP literals, this Mac's host
 * names. (A public name that resolves to 127.0.0.1 is not caught here; see resolvesToThisMac.)
 */
export function isThisMacHostname(hostname: string, names: { addresses?: Set<string>; hostNames?: Set<string> } = {}): boolean {
  const h = normalizeAddress(hostname).replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIpLiteral(h)) return isThisMacAddress(h, names.addresses ?? ownAddresses());
  return (names.hostNames ?? ownNames()).has(h);
}

/** Port a URL connects to (its explicit port, else the scheme's default). */
export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** A desktop request was refused because it would reach Dürbün's own server. */
export class OwnServerRequestError extends Error {
  readonly code = OWN_SERVER_CODE;
  constructor(
    message: string,
    readonly params: I18nParams,
  ) {
    super(message);
    this.name = 'OwnServerRequestError';
  }
}

export interface OwnTargetGuard {
  /** Dürbün's own listening ports (HTTP, device gateway, SDK). */
  ownPorts(): Iterable<number>;
  /** DNS lookup (tests); default dns.lookup with every address. */
  lookup?: HostLookup;
}

/**
 * Throws OwnServerRequestError when `url` would reach one of Dürbün's own ports on this Mac. Hosts on other ports
 * are never looked up. A name that does not resolve passes (the request fails on its own).
 */
export async function assertNotOwnServer(url: URL, guard: OwnTargetGuard | undefined, via: 'request' | 'redirect' = 'request'): Promise<void> {
  if (!guard) return;
  const port = effectivePort(url);
  const ports = new Set([...guard.ownPorts()].filter((p) => Number.isInteger(p) && p > 0));
  if (!ports.has(port)) return;
  const own = ownAddresses();
  let local = isThisMacHostname(url.hostname, { addresses: own });
  if (!local && !isIpLiteral(normalizeAddress(url.hostname))) {
    try {
      local = (await (guard.lookup ?? defaultLookup)(normalizeAddress(url.hostname))).some((a) => isThisMacAddress(a, own));
    } catch {
      local = false;
    }
  }
  if (!local) return;
  const target = `${url.hostname}:${port}`;
  throw new OwnServerRequestError(
    via === 'redirect'
      ? `The request was redirected to Dürbün's own server (${target}); Dürbün does not send requests to itself`
      : `${target} is Dürbün's own server; requests from Dürbün cannot be sent to it`,
    { url: url.toString(), host: url.hostname, port, redirect: via === 'redirect' ? 1 : 0 },
  );
}
