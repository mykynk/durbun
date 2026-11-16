/**
 * JSON Web Tokens seen in a request (Authorization header, cookies, query values), decoded on this computer only:
 * base64url → JSON for the header and the claims. The signature is never checked and the token never leaves the
 * view (no network, no clipboard unless the user copies).
 */

export interface DecodedJwt {
  /** Where it was found: header / cookie / parameter name. */
  name: string;
  token: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** Time claims in epoch ms (only the ones present and numeric). */
  times: Partial<Record<JwtTimeClaim, number>>;
}

export const JWT_TIME_CLAIMS = ['exp', 'nbf', 'iat', 'auth_time'] as const;
export type JwtTimeClaim = (typeof JWT_TIME_CLAIMS)[number];

/** Longer values are not looked at (a token this big is not a session token). */
const MAX_TOKEN = 16_384;
const TOKEN_RE = /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;

function base64UrlJson(part: string): Record<string, unknown> | null {
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Decodes one token (`Bearer ` prefix allowed), or null when it is not a JWT with JSON header and claims. */
export function decodeJwt(raw: string, name = ''): DecodedJwt | null {
  const token = raw.trim().replace(/^bearer\s+/i, '');
  if (token.length > MAX_TOKEN || !token.startsWith('eyJ')) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  const header = base64UrlJson(parts[0]);
  const claims = header ? base64UrlJson(parts[1]) : null;
  if (!header || !claims) return null;
  const times: DecodedJwt['times'] = {};
  for (const k of JWT_TIME_CLAIMS) {
    const v = claims[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) times[k] = v * 1000;
  }
  return { name, token, header, claims, times };
}

/**
 * Every distinct JWT inside these name/value pairs: a value that is a token (`Bearer …` too) or holds one (a
 * `Cookie` header, a JSON-ish value). At most `max`.
 */
export function findJwts(values: ReadonlyArray<{ name: string; value: string }>, max = 6): DecodedJwt[] {
  const out: DecodedJwt[] = [];
  const seen = new Set<string>();
  for (const { name, value } of values) {
    if (out.length >= max) break;
    if (!value || value.length > MAX_TOKEN * 4 || !value.includes('eyJ')) continue;
    for (const m of value.match(TOKEN_RE) ?? []) {
      if (seen.has(m) || out.length >= max) continue;
      const jwt = decodeJwt(m, name);
      if (!jwt) continue;
      seen.add(m);
      out.push(jwt);
    }
  }
  return out;
}

export type JwtState = 'expired' | 'notYet' | 'valid' | 'noExpiry';

/** Whether the token was usable at `at` (epoch ms): `exp` passed, `nbf` not reached, fine, or no expiry at all. */
export function jwtStateAt(jwt: DecodedJwt, at: number): JwtState {
  const { exp, nbf } = jwt.times;
  if (exp !== undefined && exp <= at) return 'expired';
  if (nbf !== undefined && nbf > at) return 'notYet';
  return exp === undefined ? 'noExpiry' : 'valid';
}

/** A short string for a claim (subject, issuer…) or undefined. */
export function claimText(jwt: DecodedJwt, key: string): string | undefined {
  const v = jwt.claims[key];
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ');
  return undefined;
}
