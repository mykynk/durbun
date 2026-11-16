import { afterEach, describe, expect, it } from 'vitest';
import { hasMessage, setLanguage } from '../../i18n';
import { MOCK_EXPECTED, packageNoticeText } from './notices';

afterEach(() => setLanguage('en'));

describe('package notices', () => {
  it('words a flow that could not be read from its check code, not the English problem', () => {
    setLanguage('tr');
    const text = packageNoticeText({
      code: 'package.flow.invalid',
      message: 'A flow could not be read: unknown node type "tapp"',
      params: { problem: 'unknown node type "tapp"', issue: 'flow.node.unknownType', type: 'tapp' },
    });
    expect(text).toBe('Paketteki bir akış okunamadı: Bilinmeyen adım türü: tapp');
    expect(text).not.toMatch(/unknown/);
  });

  it('names the first problem of a flow with problems', () => {
    setLanguage('tr');
    const text = packageNoticeText({
      code: 'package.flow.problems',
      message: 'Login: 2 problem(s), e.g. unknown node type "tapp"',
      params: { problem: 'unknown node type "tapp"', issue: 'flow.node.unknownType', type: 'tapp', flow: 'Giriş', count: 2 },
    });
    expect(text).toBe('Giriş akışında 2 hata var; ilki: Bilinmeyen adım türü: tapp');
  });

  it('words a mock rule problem from field and expected, with the rule number and name', () => {
    setLanguage('tr');
    expect(
      packageNoticeText({
        code: 'package.mock.invalid',
        message: 'A mock rule could not be read: rule #2 (Login): status must be an integer between 100 and 599',
        params: { problem: 'rule #2 (Login): status must be…', rule: 2, name: 'Login', field: 'status', expected: 'range', min: 100, max: 599 },
      }),
    ).toBe('Paketteki 2. mock kuralı (“Login”) okunamadı: “status” 100 ile 599 arasında bir tam sayı olmalı');
    setLanguage('en');
    expect(
      packageNoticeText({
        code: 'package.mock.invalid',
        message: 'x',
        params: { problem: 'x', rule: 3, field: 'match', expected: 'oneOf', options: 'exact, prefix' },
      }),
    ).toBe('Mock rule 3 in the package could not be read: “match” must be one of: exact, prefix');
  });

  it('keeps the coded text when an older server sends only the English problem', () => {
    setLanguage('tr');
    expect(packageNoticeText({ code: 'package.mock.invalid', message: 'x', params: { problem: 'action is missing' } })).toBe('Paketteki bir mock kuralı okunamadı: action is missing');
  });

  it('has Turkish and English text for every way a mock rule can be wrong', () => {
    for (const e of [...MOCK_EXPECTED, 'other']) {
      expect(hasMessage(`transfer.notice.expected.${e}`, 'tr')).toBe(true);
      expect(hasMessage(`transfer.notice.expected.${e}`, 'en')).toBe(true);
    }
  });
});
