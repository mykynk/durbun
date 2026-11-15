/**
 * fetch for HTTPS servers with their own certificate settings: an internal CA or a self-signed test server (a flow
 * environment's TLS setting, a resend the user chose to send unverified). Node's fetch takes no per-request TLS
 * options without undici's Agent, so HTTPS goes through node:https here and comes back as a fetch Response; plain
 * HTTP goes to the normal fetch. Only what sendDesktopRequest uses is supported: method, headers, a Buffer body,
 * an abort signal and manual redirects (it follows them itself).
 */
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { pipeline, Readable } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';

export interface TlsSettings {
  /** Extra trusted certificates (PEM), added to the default ones. */
  ca?: string;
  /** Do not verify the server certificate. */
  skipVerify?: boolean;
}

/** OpenSSL / Node error codes of a certificate the client did not accept. */
const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'INVALID_CA',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Is this error code a rejected server certificate? */
export function isTlsCertError(code: string | undefined): boolean {
  return !!code && TLS_CERT_CODES.has(code);
}

/** The error code behind a fetch failure ("fetch failed" carries it in `cause`). */
export function fetchErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificate blocks of a PEM text (anything else, private keys included, is ignored). */
export function pemCertificates(text: string): string[] {
  return text.match(PEM_BLOCK) ?? [];
}

/** Default trusted CAs: with system ones when Node reads them (NODE_USE_SYSTEM_CA / --use-system-ca), else the bundled list. */
function defaultCas(): string[] {
  const get = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  if (typeof get === 'function') {
    try {
      return [...get('default')];
    } catch {
      /* older Node */
    }
  }
  return [...tls.rootCertificates];
}

type FetchInit = { method?: string; headers?: unknown; body?: unknown; signal?: AbortSignal | null; redirect?: string };

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function headerPairs(headers: unknown): [string, string][] {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map((h) => [String(h[0]), String(h[1])]);
  if (headers instanceof Headers) {
    const out: [string, string][] = [];
    headers.forEach((v, k) => out.push([k, v]));
    return out;
  }
  return Object.entries(headers as Record<string, string>).map(([k, v]) => [k, String(v)]);
}

/** The body as fetch gives it: decompressed (an error or abort on either side ends both). */
function decoded(res: IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const unzip =
    enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : undefined;
  return unzip ? pipeline(res, unzip, () => {}) : res;
}

/** A fetch whose HTTPS requests use these TLS settings; other URLs go to `fallback`. */
export function createTlsFetch(settings: TlsSettings, fallback: typeof fetch = fetch): typeof fetch {
  const extra = settings.ca ? pemCertificates(settings.ca) : [];
  const ca = extra.length ? [...defaultCas(), ...extra] : undefined;
  const run = (input: string | URL | Request, init: FetchInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== 'https:') return fallback(input, init as RequestInit);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of headerPairs(init.headers)) {
        const prev = headers[k.toLowerCase()];
        headers[k.toLowerCase()] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      const body = init.body === undefined || init.body === null ? undefined : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
      if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
      const req = https.request(url, {
        method: init.method ?? 'GET',
        headers,
        ca,
        rejectUnauthorized: !settings.skipVerify,
        // A fresh connection: a pooled one may have been made with other TLS settings.
        agent: false,
      });
      const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        // Like Node's fetch: a TypeError with the cause; an abort rejects with the signal's reason.
        reject(signal?.aborted ? signal.reason : Object.assign(new TypeError('fetch failed'), { cause: err }));
      });
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const out = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          } catch {
            /* a header value fetch would not accept */
          }
        }
        res.once('close', () => signal?.removeEventListener('abort', onAbort));
        if (status < 200 || status > 599) {
          res.resume();
          reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`Unsupported HTTP status ${status}`), { code: 'ERR_INVALID_STATUS' }) }));
          return;
        }
        const nullBody = NULL_BODY.has(status) || (init.method ?? 'GET').toUpperCase() === 'HEAD';
        if (nullBody) res.resume();
        const stream = nullBody ? null : (Readable.toWeb(decoded(res)) as ReadableStream<Uint8Array>);
        resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: out }));
      });
      req.end(body);
    });
  };
  return run as typeof fetch;
}
