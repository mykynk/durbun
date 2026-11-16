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

/** Compiled patterns kept for `userRegexTest` (conditions and URL rules run the same few patterns again and again). */
const TEST_CACHE_MAX = 256;
const testCache = new Map<string, UserRegex | null>();

/**
 * RegexTest (protocol flows/expr.ts) for the server: a pattern that can backtrack exponentially runs with a time
 * limit (compileUserRegex); an invalid one never matches. Compiled patterns are cached (bounded).
 */
export function userRegexTest(pattern: string, text: string): boolean {
  let re = testCache.get(pattern);
  if (re === undefined) {
    try {
      re = compileUserRegex(pattern);
    } catch {
      re = null;
    }
    testCache.set(pattern, re);
    if (testCache.size > TEST_CACHE_MAX) testCache.delete(testCache.keys().next().value!);
  }
  return re ? re.test(text) : false;
}
