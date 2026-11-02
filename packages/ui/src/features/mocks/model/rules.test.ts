import { beforeAll, describe, expect, it } from 'vitest';
import type { MockAction, MockRule, NetworkEntry } from '@durbun/protocol';
import { translate, type TFunction } from '../../../i18n/core';
import '../i18n';
import {
  actionSummary,
  bodyTypeLabel,
  disableAll,
  dropTarget,
  duplicateRule,
  emptyForm,
  exportRules,
  formSignature,
  formToRule,
  headerRow,
  hitCounts,
  mergeImported,
  moveItem,
  moveRuleBy,
  parseRulesFile,
  restoreEnabled,
  ruleToForm,
  validateForm,
  type RuleForm,
} from './rules';

const tr: TFunction = (key, params) => translate('tr', key, params);
const en: TFunction = (key, params) => translate('en', key, params);

function rule(id: string, p: Partial<MockRule> = {}): MockRule {
  return { id, enabled: true, method: 'GET', url: '/v1/pets', match: 'contains', action: { type: 'respond', status: 200 }, createdAt: 1, ...p };
}

describe('action summaries', () => {
  beforeAll(() => undefined);
  it('respond: status · type · delay', () => {
    const a: MockAction = { type: 'respond', status: 200, headers: [['Content-Type', 'application/json']], body: '{}', bodyEncoding: 'utf8', delayMs: 300 };
    expect(actionSummary(a, tr, 'tr')).toBe('200 · JSON · 300 ms');
    expect(actionSummary(a, en, 'en')).toBe('200 · JSON · 300 ms');
    expect(actionSummary({ type: 'respond', status: 204 }, tr, 'tr')).toBe('204 · gövde yok');
    expect(actionSummary({ type: 'respond', status: 200, headers: [['content-type', 'image/png']], body: 'iVBO', bodyEncoding: 'base64' }, en, 'en')).toBe('200 · PNG');
    expect(actionSummary({ type: 'respond', status: 500, body: 'oops', headers: [['content-type', 'text/plain']] }, tr, 'tr')).toBe('500 · metin');
  });
  it('delay and fail use localized durations and error names', () => {
    expect(actionSummary({ type: 'delay', delayMs: 2000 }, tr, 'tr')).toBe('Gecikme 2 sn');
    expect(actionSummary({ type: 'delay', delayMs: 2000 }, en, 'en')).toBe('Delay 2 s');
    expect(actionSummary({ type: 'delay', delayMs: 1500 }, tr, 'tr')).toBe('Gecikme 1,5 sn');
    expect(actionSummary({ type: 'delay', delayMs: 90_000 }, en, 'en')).toBe('Delay 1.5 min');
    expect(actionSummary({ type: 'fail', error: 'timeout' }, tr, 'tr')).toBe('Hata: zaman aşımı');
    expect(actionSummary({ type: 'fail', error: 'dns', delayMs: 1000 }, en, 'en')).toBe('Fail: DNS error · 1 s');
    expect(actionSummary({ type: 'fail', error: 'custom', message: 'Sunucu bakımda' }, tr, 'tr')).toBe('Hata: Sunucu bakımda');
  });
  it('labels body types', () => {
    expect(bodyTypeLabel({ type: 'respond', status: 200 })).toBeNull();
    expect(bodyTypeLabel({ type: 'respond', status: 200, body: '<p/>', headers: [['content-type', 'text/html; charset=utf-8']] })).toBe('HTML');
    expect(bodyTypeLabel({ type: 'respond', status: 200, body: 'AAEC', bodyEncoding: 'base64' })).toBe('BINARY');
  });
});

describe('form ⇄ rule + validation', () => {
  const valid = (): RuleForm => ({ ...emptyForm(), url: '/v1/pets', body: '{"items":[]}' });

  it('round-trips a respond rule', () => {
    const r: MockRule = {
      id: 'r1',
      enabled: false,
      name: 'Boş liste',
      method: 'POST',
      url: 'https://api.pati.app/v1/pets',
      match: 'exact',
      apps: ['com.mykynk.pati'],
      action: { type: 'respond', status: 201, headers: [['content-type', 'application/json']], body: '{"ok":true}', bodyEncoding: 'utf8', delayMs: 250 },
      createdAt: 42,
    };
    expect(formToRule(ruleToForm(r), { id: 'r1', createdAt: 42 })).toEqual(r);
  });

  it('round-trips delay and fail rules and drops empty optional fields', () => {
    const d = rule('d', { action: { type: 'delay', delayMs: 3000 }, method: '*' });
    expect(formToRule(ruleToForm(d), { id: 'd', createdAt: 1 })).toEqual(d);
    const f = rule('f', { action: { type: 'fail', error: 'custom', message: 'boom', delayMs: 100 } });
    expect(formToRule(ruleToForm(f), { id: 'f', createdAt: 1 })).toEqual(f);
    const form = { ...valid(), name: '   ', headers: [headerRow('', '')], body: '' };
    const out = formToRule(form, { id: 'x', createdAt: 1 });
    expect(out.name).toBeUndefined();
    expect(out.action).toEqual({ type: 'respond', status: 200 });
  });

  it('reports blocking errors with fields', () => {
    const codes = (f: RuleForm) => validateForm(f).errors.map((e) => `${e.field}:${e.code}`);
    expect(codes(valid())).toEqual([]);
    expect(codes({ ...valid(), url: '  ' })).toEqual(['url:urlRequired']);
    expect(codes({ ...valid(), url: '([a-z', match: 'regex' })).toEqual(['url:regexInvalid']);
    expect(codes({ ...valid(), status: '42' })).toEqual(['status:statusInvalid']);
    expect(codes({ ...valid(), status: '700' })).toEqual(['status:statusInvalid']);
    expect(codes({ ...valid(), method: 'GE T' })).toEqual(['method:methodInvalid']);
    expect(codes({ ...valid(), headers: [headerRow('Bad Header', 'x')] })).toEqual(['headers:headerNameInvalid']);
    expect(codes({ ...valid(), headers: [headerRow('', 'value')] })).toEqual(['headers:headerNameMissing']);
    expect(codes({ ...valid(), bodyEncoding: 'base64', body: 'not base64 !!' })).toEqual(['body:base64Invalid']);
    expect(codes({ ...valid(), respondDelayMs: 'abc' })).toEqual(['respondDelayMs:delayInvalid']);
    expect(codes({ ...valid(), type: 'delay', delayMs: '' })).toEqual(['delayMs:delayRequired']);
    expect(codes({ ...valid(), type: 'delay', delayMs: '900000' })).toEqual(['delayMs:delayTooLong']);
  });

  it('warns without blocking', () => {
    const warn = (f: RuleForm) => validateForm(f).warnings.map((e) => e.code);
    expect(warn({ ...valid(), body: '{"a":' })).toEqual(['jsonInvalid']);
    expect(warn({ ...valid(), url: 'pe' })).toEqual(['containsShort']);
    expect(warn({ ...valid(), url: 'https://x.dev/a', match: 'glob' })).toEqual(['globNoWildcard']);
    expect(warn({ ...valid(), status: '204' })).toEqual(['bodyIgnored']);
    expect(warn({ ...valid(), type: 'fail', failError: 'custom' })).toEqual(['customMessage']);
  });

  it('detects dirty forms regardless of header row ids', () => {
    const a = ruleToForm(rule('x', { action: { type: 'respond', status: 200, headers: [['a', '1']] } }));
    const b = ruleToForm(rule('x', { action: { type: 'respond', status: 200, headers: [['a', '1']] } }));
    expect(formSignature(a)).toBe(formSignature(b));
    expect(formSignature({ ...a, url: 'other' })).not.toBe(formSignature(b));
  });
});

describe('ordering', () => {
  const list = ['a', 'b', 'c', 'd'];
  it('moves items to a final index', () => {
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 9, 0)).toEqual(list);
  });
  it('converts drag-and-drop targets', () => {
    // drag "a" (0) after "c" (2) → final index 2
    expect(moveItem(list, 0, dropTarget(0, 2, 'after'))).toEqual(['b', 'c', 'a', 'd']);
    // drag "d" (3) before "b" (1) → final index 1
    expect(moveItem(list, 3, dropTarget(3, 1, 'before'))).toEqual(['a', 'd', 'b', 'c']);
    // drop onto itself does nothing
    expect(dropTarget(2, 2, 'before')).toBe(2);
    expect(dropTarget(2, 2, 'after')).toBe(2);
    // after the previous row = same place
    expect(dropTarget(2, 1, 'after')).toBe(2);
  });
  it('moves rules one step by keyboard', () => {
    const rules = [rule('a'), rule('b'), rule('c')];
    expect(moveRuleBy(rules, 'b', -1).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(moveRuleBy(rules, 'c', 1).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('duplicates right after the original', () => {
    const out = duplicateRule([rule('a', { name: 'Liste' }), rule('b')], 'a', { id: 'a2', now: 5, nameSuffix: ' (kopya)' });
    expect(out.map((r) => r.id)).toEqual(['a', 'a2', 'b']);
    expect(out[1]).toMatchObject({ name: 'Liste (kopya)', createdAt: 5 });
    expect(out[0]).not.toBe(out[1]);
  });
});

describe('master switch', () => {
  it('remembers which rules were on and restores them', () => {
    const rules = [rule('a'), rule('b', { enabled: false }), rule('c')];
    const off = disableAll(rules);
    expect(off.rules.every((r) => !r.enabled)).toBe(true);
    expect(off.remembered).toEqual(['a', 'c']);
    expect(restoreEnabled(off.rules, off.remembered).map((r) => r.enabled)).toEqual([true, false, true]);
    // remembered rules were deleted meanwhile → enable everything
    expect(restoreEnabled(off.rules, ['gone']).every((r) => r.enabled)).toBe(true);
  });
});

describe('hit counts', () => {
  it('counts mocked requests per rule', () => {
    const e = (p: Partial<NetworkEntry>) => p as NetworkEntry;
    const counts = hitCounts([e({ mocked: true, mockRuleId: 'a' }), e({ mocked: true, mockRuleId: 'a' }), e({ mocked: false, mockRuleId: 'b' }), e({ mocked: true, mockRuleId: 'c' })]);
    expect([...counts.entries()]).toEqual([
      ['a', 2],
      ['c', 1],
    ]);
  });
});

describe('import / export', () => {
  it('round-trips the export format', () => {
    const rules = [rule('a'), rule('b', { action: { type: 'fail', error: 'tls' } })];
    const parsed = parseRulesFile(exportRules(rules, 7));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rules).toEqual(rules);
  });
  it('accepts plain arrays and reports invalid rules with their index', () => {
    const text = JSON.stringify([
      { url: '/ok', action: { type: 'delay', delayMs: 500 } },
      { url: '', action: { type: 'delay', delayMs: 1 } },
      { url: '([', match: 'regex', action: { type: 'delay', delayMs: 1 } },
      { url: '/x', action: { type: 'respond', status: 999 } },
      { url: '/y', action: { type: 'explode' } },
      'nope',
    ]);
    const { rules, issues } = parseRulesFile(text, 100);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ method: '*', match: 'contains', enabled: true, createdAt: 100, action: { type: 'delay', delayMs: 500 } });
    expect(issues.map((i) => `${i.index}:${i.code}`)).toEqual(['2:urlRequired', '3:regexInvalid', '4:statusInvalid', '5:actionInvalid', '6:notObject']);
  });
  it('rejects non-JSON and empty files', () => {
    expect(parseRulesFile('{oops').issues).toEqual([{ index: 0, code: 'notJson' }]);
    expect(parseRulesFile('{"format":"durbun-mocks","rules":[]}').issues).toEqual([{ index: 0, code: 'noRules' }]);
    expect(parseRulesFile('{"a":1}').issues).toEqual([{ index: 0, code: 'noRules' }]);
  });
  it('merges by appending (fresh ids for duplicates) or replacing', () => {
    const existing = [rule('a'), rule('b')];
    const imported = [rule('b', { url: '/new' }), rule('c')];
    const appended = mergeImported(existing, imported, 'append', 1);
    expect(appended.map((r) => r.url)).toEqual(['/v1/pets', '/v1/pets', '/new', '/v1/pets']);
    expect(new Set(appended.map((r) => r.id)).size).toBe(4);
    expect(mergeImported(existing, imported, 'replace').map((r) => r.id)).toEqual(['b', 'c']);
  });
});
