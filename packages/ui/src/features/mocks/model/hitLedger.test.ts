import { beforeEach, describe, expect, it } from 'vitest';
import type { NetworkEntry } from '@durbun/protocol';
import { recordHits, resetHitLedger, sessionHits } from './hitLedger';

const hit = (id: string, rule = 'r1', mocked = true) => ({ id, mocked, mockRuleId: rule }) as unknown as NetworkEntry;

describe('mock hit ledger', () => {
  beforeEach(() => resetHitLedger());
  it('counts each answered request once, per rule', () => {
    recordHits([hit('a'), hit('b'), hit('a'), hit('c', 'r2'), hit('d', 'r1', false)]);
    // A later update of the same request (pending → complete) does not count again.
    recordHits([hit('b')]);
    expect(sessionHits('r1')).toBe(2);
    expect(sessionHits('r2')).toBe(1);
    expect(sessionHits('nope')).toBe(0);
  });
});
