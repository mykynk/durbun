/**
 * User patterns that can backtrack exponentially: validation warns, the server runs them with a time limit
 * (a stuck pattern counts as no match instead of freezing every capture and the UI).
 */
import { describe, expect, it } from 'vitest';
import { unsafeRegexReason, validateFlow } from '@durbun/protocol';
import { compileUserRegex, UNSAFE_REGEX_TIMEOUT_MS } from '../../src/flows/regex';

describe('unsafeRegexReason', () => {
  it('finds a repeat inside a repeat', () => {
    for (const p of ['(a+)+$', '(a*)*b', '(\\w+\\s?)*$', '(.*)*x', '((ab)+)+', '([a-z]+)+$', '(x+x+)+y', '(a{1,}){2,}']) {
      expect(unsafeRegexReason(p), p).toBeDefined();
    }
  });

  it('leaves ordinary patterns alone', () => {
    for (const p of ['Login failed', 'user (\\d+) logged in', '^E/.*crash', '(\\d{1,3}\\.){3}\\d{1,3}', '[(+*)]+', 'a\\(b+\\)+', '(GET|POST) /v1/.*', '\\d+ms']) {
      expect(unsafeRegexReason(p), p).toBeUndefined();
    }
  });
});

describe('compileUserRegex', () => {
  it('runs safe patterns directly, with groups', () => {
    const re = compileUserRegex('user (\\d+)');
    expect(re.unsafe).toBe(false);
    expect(re.exec('user 42 logged in')).toEqual(['user 42', '42']);
    expect(re.test('nobody')).toBe(false);
    expect(() => compileUserRegex('(')).toThrow(SyntaxError);
  });

  it('an exponential pattern on an unlucky line stops after the time limit and counts as no match', () => {
    const re = compileUserRegex('(a+)+$');
    expect(re.unsafe).toBe(true);
    expect(re.exec('aaaa')).toEqual(['aaaa', 'aaaa']);
    const started = performance.now();
    expect(re.test(`${'a'.repeat(40)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(UNSAFE_REGEX_TIMEOUT_MS * 20);
    expect(re.timeouts).toBe(1);
  });
});

describe('flow validation', () => {
  it('warns flow.regex.unsafe on a wait.log pattern (the flow still saves and runs)', () => {
    const { flow, issues } = validateFlow({
      format: 'durbun-flow',
      version: 1,
      id: 'f',
      name: 'F',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'w', type: 'wait.log', params: { text: '(\\w+\\s?)*$', regex: true } },
      ],
      edges: [{ from: 'start', to: 'w' }],
    });
    expect(flow).toBeDefined();
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', code: 'flow.regex.unsafe', nodeId: 'w' }));
  });
});
