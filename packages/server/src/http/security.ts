/**
 * Access control for the UI WebSocket (/ui) and the REST API (/api/*). These carry every request, header
 * and body of the developer's apps, so a random website open in the developer's browser must never be
 * able to read them:
 *  - the peer must be a loopback address (LAN devices only get /sdk);
 *  - an Origin header, when present, must be the Dürbün UI itself or the Vite dev server (SPEC §5.4);
 *  - the Host header must name a loopback host (defeats DNS-rebinding, where a hostile page's own
 *    hostname resolves to 127.0.0.1 and its requests become "same-origin" without an Origin header);
 *  - Sec-Fetch-Site, when present, must be same-origin or none (blocks <img>/<script> embeds from
 *    other sites, which browsers send without an Origin header).
 * /sdk stays open to any address (apps on the LAN, React Native over adb reverse) but not to web pages of
 * other sites, DNS-rebinding pages included (checkSdkUpgrade).
 */
import type { IncomingMessage } from 'node:http';
import os from 'node:os';

/** Vite dev server port (packages/ui/vite.config.ts, strictPort). */
export const DEV_UI_PORT = 5173;

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let a = address.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  return IPV4_LOOPBACK.test(a);
}

export function allowedOrigins(port: number): Set<string> {
  const out = new Set<string>();
  for (const p of new Set([port, DEV_UI_PORT])) {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) out.add(`http://${host}:${p}`);
  }
  return out;
}

/** Hostname part of a Host header value (keeps IPv6 brackets). */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === '') return true; // HTTP/1.0 clients (curl -0); peer is already loopback
  const host = hostnameOf(hostHeader);
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || IPV4_LOOPBACK.test(host);
}

export type AccessResult = { ok: true } | { ok: false; reason: string };

export function checkLocalAccess(req: Pick<IncomingMessage, 'headers' | 'socket'>, port: number): AccessResult {
  const remote = req.socket?.remoteAddress;
  if (!isLoopbackAddress(remote)) return { ok: false, reason: `client ${remote ?? 'unknown'} is not on this computer` };
  const host = req.headers.host;
  if (!isLoopbackHostHeader(host)) return { ok: false, reason: `unexpected Host header "${host}"` };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const normalized = origin.trim().toLowerCase().replace(/\/+$/, '');
    if (!allowedOrigins(port).has(normalized)) return { ok: false, reason: `origin "${origin}" is not allowed` };
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: `${site} request blocked` };
  }
  return { ok: true };
}

/** Hostname (IPv6 in brackets) and port of an http(s)/ws(s) Origin; undefined for "null", file:// and garbage. */
function parseOrigin(origin: string): { hostname: string; port: string; defaultPort: string } | undefined {
  let url: URL;
  try {
    url = new URL(origin.trim());
  } catch {
    return undefined;
  }
  const defaultPort = url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : url.protocol === 'http:' || url.protocol === 'ws:' ? '80' : '';
  if (!defaultPort || !url.hostname) return undefined;
  return { hostname: url.hostname.toLowerCase(), port: url.port || defaultPort, defaultPort };
}

/** Port part of a Host header value (undefined when it names none). */
function portOf(hostHeader: string): string | undefined {
  const h = hostHeader.trim();
  const end = h.startsWith('[') ? h.indexOf(']') + 1 : 0;
  const colon = h.indexOf(':', end);
  return colon >= 0 ? h.slice(colon + 1) : undefined;
}

/** An IP literal as a URL / Host header spells it (IPv6 in brackets). */
const isIpLiteral = (hostname: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'));

/**
 * This Mac's own names as an Origin or a Host header spells them (lowercase): the addresses of its network
 * interfaces (IPv6 in brackets, without a zone) and its host name, with its Bonjour ".local" form.
 */
export function ownHostNames(): Set<string> {
  const out = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        const address = a.address.toLowerCase().replace(/%.*$/, '');
        out.add(a.family === 'IPv6' || (a.family as unknown) === 6 ? `[${address}]` : address);
      }
    }
  } catch {
    // no interface list on this system: loopback pages still pass
  }
  try {
    const name = os.hostname().trim().toLowerCase().replace(/\.$/, '');
    const label = name.split('.')[0];
    if (name) out.add(name);
    if (label) out.add(label).add(`${label}.local`);
  } catch {
    // no host name: its addresses still count
  }
  return out;
}

/**
 * The SDK WebSocket (/sdk) takes apps on any address, but never a web page of another site: such a page
 * could read the mock rules (bodies, tokens) and push fake sessions and crashes.
 *  - Native clients send no Origin (Node `ws`, dart:io).
 *  - React Native sends the ws URL's own origin (`http://<host>:<port>`). That passes for a host no public
 *    DNS answers for (loopback, an IP literal such as 10.0.2.2 or the Mac's LAN address, a ".local" name):
 *    after a DNS rebinding a hostile page is same-origin with its own public name, which resolves to
 *    127.0.0.1 by then, so the Origin alone proves nothing there.
 *  - The JS SDK in a browser runs on a page of a dev server on this Mac: the page's host is loopback or one
 *    of this Mac's own names (`ownNames`, default ownHostNames()), whatever host and port it dials (the JS
 *    SDK tries localhost, 127.0.0.1 and the page's host), and its fetch metadata says same-site or
 *    cross-site.
 * Everything else that sends an Origin, or cross-site fetch metadata, is refused.
 */
export function checkSdkUpgrade(req: Pick<IncomingMessage, 'headers'>, ownNames?: Iterable<string>): AccessResult {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  const origin = req.headers.origin;
  let localPage = false;
  if (origin !== undefined) {
    const o = parseOrigin(origin);
    if (!o) return { ok: false, reason: `origin "${origin}" is not allowed` };
    localPage = isLoopbackHostHeader(o.hostname) || new Set([...(ownNames ?? ownHostNames())].map((n) => n.toLowerCase())).has(o.hostname);
    if (!localPage) {
      const hostName = host ? hostnameOf(host) : '';
      const sameOrigin = !!hostName && hostName === o.hostname && (portOf(host) ?? o.defaultPort) === o.port;
      if (!sameOrigin) return { ok: false, reason: `origin "${origin}" does not match the host "${host}"` };
      if (!isIpLiteral(hostName) && !hostName.endsWith('.local')) {
        return { ok: false, reason: `origin "${origin}" is a page of the public name "${hostName}", not of this Mac` };
      }
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none' && !localPage) {
    return { ok: false, reason: `${site} request blocked` };
  }
  return { ok: true };
}
