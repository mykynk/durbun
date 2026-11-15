/**
 * User regular expressions on the server (log triggers, "wait for a log line", extract rules). A pattern that
 * can backtrack exponentially (unsafeRegexReason) would block Node's event loop on one unlucky line and with it
 * every capture, the UI and the device drivers. Such patterns run in a vm context with a time limit; a pattern
 * that runs out of time counts as no match. Other patterns run directly.
 */
import vm from 'node:vm';
import { unsafeRegexReason } from '@durbun/protocol';

/** Time one unsafe pattern may take on one text. */
export const UNSAFE_REGEX_TIMEOUT_MS = 50;
/** Longest text an unsafe pattern is run on (the start of a longer one). */
export const UNSAFE_REGEX_MAX_CHARS = 10_000;

export interface UserRegex {
  readonly unsafe: boolean;
  /** Groups of the first match (0 = whole match, a group that did not take part is undefined), or null. */
  exec(text: string): (string | undefined)[] | null;
  test(text: string): boolean;
  /** Times the pattern ran out of time. */
  readonly timeouts: number;
}

/** Compile a user pattern; throws SyntaxError when it is not a regular expression. */
export function compileUserRegex(pattern: string, flags = ''): UserRegex {
  const re = new RegExp(pattern, flags);
  if (!unsafeRegexReason(pattern)) {
    return {
      unsafe: false,
      timeouts: 0,
      exec: (text) => {
        re.lastIndex = 0;
        const m = re.exec(text);
        return m ? [...m] : null;
      },
      test: (text) => {
        re.lastIndex = 0;
        return re.test(text);
      },
    };
  }
  // The regex lives in its own context: the timeout interrupts the backtracking there.
  const context = vm.createContext({ pattern, flags, input: '' });
  const script = new vm.Script('(globalThis.re ??= new RegExp(pattern, flags), re.lastIndex = 0, re.exec(input))');
  let timeouts = 0;
  const run = (text: string): (string | undefined)[] | null => {
    context.input = text.length > UNSAFE_REGEX_MAX_CHARS ? text.slice(0, UNSAFE_REGEX_MAX_CHARS) : text;
    try {
      const m = script.runInContext(context, { timeout: UNSAFE_REGEX_TIMEOUT_MS }) as ArrayLike<string | undefined> | null;
      return m ? Array.from(m) : null;
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        timeouts++;
        return null;
      }
      throw err;
    } finally {
      context.input = '';
    }
  };
  return {
    unsafe: true,
    get timeouts() {
      return timeouts;
    },
    exec: run,
    test: (text) => run(text) !== null,
  };
}
