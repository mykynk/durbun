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
 * /sdk stays open to any origin and address (apps on the LAN, React Native over adb reverse).
 */
import type { IncomingMessage } from 'node:http';

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
