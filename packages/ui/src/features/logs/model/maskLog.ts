import { SECRET_MASK, isSecretName, maskUrl, type ErrorInfo } from '@durbun/protocol';

/**
 * Secret values in shared log text: the same names the request share and the file exports mask (`isSecretName`
 * from `@durbun/protocol`), found where a log line prints them — URLs with secret query values, `Bearer …` /
 * `Basic …` credentials, JSON Web Tokens, `"token": "…"` JSON pairs, `password=…` / `apiKey: …` pairs and
 * `Cookie:` lines. Log text has no fixed shape, so this masks what looks like a secret and keeps the rest.
 * Each masked value counts once (`count`), so the dialog can say how many values it hid.
 */
export class LogMasker {
  count = 0;

  private hit(v: string): string {
    this.count++;
    return v;
  }

  /** A free-form message, stack or display text with its secret-looking values masked. */
  text(input: string): string {
    if (!input) return input;
    let out = input;
    // URLs first: their query values are masked by name, and later steps must not eat them.
    out = out.replace(URL_RE, (u) => {
      const m = maskUrl(u);
      return m === u ? u : this.hit(m);
    });
    out = out.replace(COOKIE_LINE_RE, (_m, name: string) => this.hit(`${name}: ${SECRET_MASK}`));
    out = out.replace(JWT_RE, () => this.hit(SECRET_MASK));
    out = out.replace(AUTH_RE, (m, scheme: string, value: string) => (value === SECRET_MASK ? m : this.hit(`${scheme} ${SECRET_MASK}`)));
    out = out.replace(JSON_PAIR_RE, (m, key: string, sep: string, value: string) => (isSecretName(key) && value !== `"${SECRET_MASK}"` ? this.hit(`"${key}"${sep}"${SECRET_MASK}"`) : m));
    out = out.replace(PAIR_RE, (m, key: string, sep: string, value: string) => {
      if (!isSecretName(key) || value.includes(SECRET_MASK) || /^(bearer|basic)$/i.test(value)) return m;
      return this.hit(`${key}${sep}${SECRET_MASK}`);
    });
    return out;
  }

  /** Structured data the app logged: values under secret names masked, strings masked as text. */
  data(value: unknown, depth = 0): unknown {
    if (depth > 24) return value;
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.data(v, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isSecretName(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object' && v !== SECRET_MASK) out[k] = this.hit(SECRET_MASK);
        else out[k] = this.data(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  error(err: ErrorInfo | undefined): ErrorInfo | undefined {
    if (!err) return err;
    const out: ErrorInfo = { ...err };
    if (typeof err.message === 'string') out.message = this.text(err.message);
    if (typeof err.stack === 'string') out.stack = this.text(err.stack);
    return out;
  }
}

/** `scheme://…` up to whitespace or a closing quote / bracket. */
const URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`)\]}]+/g;
/** A cookie header printed in a log line: everything after it on the line is cookie values. */
const COOKIE_LINE_RE = /\b(cookie|set-cookie)\s*:\s*(?!••••)[^\n]+/gi;
/** A JSON Web Token anywhere (`eyJ….eyJ….sig`). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
/** `Bearer <token>` / `Basic <credentials>` (a value of at least 8 characters). */
const AUTH_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9\-._~+/]{8,}=*|••••)/gi;
/** `"key": "value"` / `"key": 123` pairs (JSON printed in a message). */
const JSON_PAIR_RE = /"((?:[^"\\]|\\.){1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g;
/** `key=value`, `key: value`, `key = "value"` in prose. */
const PAIR_RE = /\b([A-Za-z_][\w.-]{0,47})(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&"'}\])]+)/g;
