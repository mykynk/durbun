/**
 * Short, localizable labels for transport errors as reported by the different SDKs
 * (dart:io SocketException/HandshakeException, OkHttp, URLSession NSURLError…, fetch/undici, Dürbün).
 */

export type ShortErrorKey = 'timeout' | 'dns' | 'refused' | 'tls' | 'reset' | 'offline' | 'disconnected' | 'cancelled' | 'generic';

export function shortErrorKey(error: string | undefined): ShortErrorKey {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'generic';
  if (e.includes('app disconnected')) return 'disconnected';
  if (/cancel/.test(e)) return 'cancelled';
  if (/time ?out|timed out|-1001\b/.test(e)) return 'timeout';
  if (/host lookup|enotfound|eai_again|nodename|unknownhostexception|unable to resolve host|dns|cannot find host|-1003\b/.test(e)) return 'dns';
  if (/handshake|certificate|ssl|tls|-120[0-9]\b/.test(e)) return 'tls';
  if (/refused|econnrefused|-1004\b/.test(e)) return 'refused';
  if (/not connected to the internet|network is unreachable|offline|-1009\b|enetunreach/.test(e)) return 'offline';
  if (/reset|closed|broken pipe|econnreset|connection abort|-1005\b|unexpected end of stream/.test(e)) return 'reset';
  return 'generic';
}

/** "SocketException: Failed host lookup…" → { type: 'SocketException', message: 'Failed host lookup…' }. */
export function splitError(error: string | undefined): { type?: string; message: string } {
  const e = (error ?? '').trim();
  const m = /^([A-Za-z_$][\w$.]*(?:Exception|Error|Failure))(?::\s*|\s+)([\s\S]*)$/.exec(e);
  if (m && m[2]) return { type: m[1], message: m[2] };
  return { message: e };
}
