import { describe, expect, it, vi } from 'vitest';

// jsdom has no canvas; the chart library is not needed to check the texts.
vi.mock('uplot', () => ({ default: class {} }));

import './index';
import { setLanguage, t } from '../../i18n';

describe('launch texts on the Performance tab', () => {
  it('are registered without the Logs tab having been opened', () => {
    for (const lang of ['en', 'tr'] as const) {
      setLanguage(lang);
      for (const key of ['logs.moment.launch.coldTip', 'logs.moment.launch.coldTipRequest']) {
        expect(t(key), `${lang} ${key}`).not.toBe(key);
      }
    }
  });
});
