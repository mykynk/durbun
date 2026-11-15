import { describe, expect, it } from 'vitest';
import { validateFlow } from '@durbun/protocol';
import { translate } from '../../../i18n/core';
import { STARTERS, starterFlow } from './starters';
import '../i18n';

describe('example flows', () => {
  for (const lang of ['tr', 'en'] as const) {
    it(`every example is a valid flow in ${lang}, written in that language`, () => {
      const t = (key: string, params?: Record<string, unknown>) => translate(lang, key, params as never);
      for (const s of STARTERS) {
        const doc = starterFlow(s.id, t);
        expect(doc.name).not.toContain('flows.starters');
        const { issues } = validateFlow({ ...doc, id: `starter-${s.id.toLowerCase()}` });
        expect({ id: s.id, errors: issues.filter((i) => i.level === 'error') }).toEqual({ id: s.id, errors: [] });
      }
    });
  }
});
