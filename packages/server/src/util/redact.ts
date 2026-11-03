/**
 * Secrets that must never reach a diagnostics log line (the Mac app keeps them in main.log, which users
 * share): the auth token of a Dart VM service URL. While Dürbün forwards a device's VM service port, that
 * token is the only thing that stops another program from evaluating code in the debug app.
 *
 *   http://127.0.0.1:5555/AbC=/            → http://127.0.0.1:5555/•••/
 *   ws://127.0.0.1:5555/AbC=/ws            → ws://127.0.0.1:5555/•••/ws
 *   …?uri=http%3A%2F%2F127.0.0.1%3A5555%2FAbC%3D%2F  (DevTools links) → …%2F•••%2F
 */

const MASK = '•••';
/** scheme://host:port (or //host:port) + "/<base64url token>=" followed by "/", the end, or a delimiter. */
const TOKEN_IN_URL = /((?:(?:https?|wss?):)?\/\/[^\s/'"<>`?#]+)\/[A-Za-z0-9_\-+]+={1,2}(?=[/\s'"<>`?#),\]]|$)/g;
/** The same inside a percent-encoded URL (a DevTools `?uri=` parameter). */
const TOKEN_IN_ENCODED_URL = /((?:https?|wss?)%3A%2F%2F[A-Za-z0-9._~%-]+?)%2F[A-Za-z0-9_\-+]+(?:%3D){1,2}(?=%2F|[\s&'"<>`#]|$)/gi;

/** `text` with every VM service auth token masked (cheap when the text cannot contain one). */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || (text.indexOf('=') < 0 && !/%3D/i.test(text))) return text;
  return text.replace(TOKEN_IN_URL, `$1/${MASK}`).replace(TOKEN_IN_ENCODED_URL, `$1%2F${MASK}`);
}

/** Log arguments with tokens masked: strings, and Errors (as copies; the original keeps its message). */
export function redactLogArg(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value instanceof Error) {
    const message = redactSecrets(value.message);
    const stack = value.stack === undefined ? undefined : redactSecrets(value.stack);
    if (message === value.message && stack === value.stack) return value;
    const copy = new Error(message);
    copy.name = value.name;
    copy.stack = stack;
    const code = (value as NodeJS.ErrnoException).code;
    if (code !== undefined) (copy as NodeJS.ErrnoException).code = code;
    return copy;
  }
  return value;
}
