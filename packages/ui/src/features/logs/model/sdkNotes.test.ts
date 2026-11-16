import { describe, expect, it } from 'vitest';
import { sdkNoteOf, sdkNoteText, symbolizeCommandOf } from './sdkNotes';
import { analyzeEntry, dataWithoutHints } from './analyze';
import { setLanguage } from '../../../i18n';
import '../i18n';

const base = { source: 'app' as const, appId: 'app:1', message: 'Mock "Pets" was not applied to GET https://x/pets: …' };

describe('sdk notes', () => {
  it('reads the reason lines and ignores the rest', () => {
    expect(sdkNoteOf({ ...base, data: { reason: 'noInterceptor', afterMs: 30000 } })).toEqual({ kind: 'noInterceptor', afterMs: 30000 });
    expect(sdkNoteOf({ ...base, data: { reason: 'networkInterceptor', mockRuleId: 'r1', requestId: '7' } })).toEqual({ kind: 'networkInterceptor', ruleId: 'r1', netId: 'app:1:7' });
    expect(sdkNoteOf({ ...base, data: { reason: 'networkInterceptor' } })).toBeUndefined();
    expect(sdkNoteOf({ ...base, source: 'device', data: { reason: 'noInterceptor' } } as never)).toBeUndefined();
    expect(sdkNoteOf({ ...base, data: 'noInterceptor' })).toBeUndefined();
  });

  it('words them in the interface language', () => {
    setLanguage('tr');
    expect(sdkNoteText({ ...base, data: { reason: 'noInterceptor', afterMs: 30000 } })).toContain('DurbunInterceptor yok');
    // The rule is not in the list: the name the app sent stays.
    expect(sdkNoteText({ ...base, data: { reason: 'networkInterceptor', mockRuleId: 'r1', requestId: '7' } })).toContain('“Pets” sahte yanıtı bir isteğe uygulanmadı');
    setLanguage('en');
    expect(sdkNoteText({ ...base, data: { reason: 'networkInterceptor', mockRuleId: 'r1' } })).toContain('Mock “Pets” was not applied to a request');
    expect(sdkNoteText({ ...base, data: null })).toBeUndefined();
  });

  it('a stack without symbols: the command, and data without the hint', () => {
    const cmd = 'flutter symbolize -i stack.txt -d <split-debug-info folder>/app.android-arm64.symbols';
    expect(symbolizeCommandOf({ source: 'app', data: { source: 'flutter', symbolize: cmd } })).toBe(cmd);
    expect(symbolizeCommandOf({ source: 'app', data: { symbolize: 'rm -rf /' } })).toBeUndefined();
    expect(symbolizeCommandOf({ source: 'device', data: { symbolize: cmd } })).toBeUndefined();
    expect(dataWithoutHints({ source: 'flutter', symbolize: cmd })).toEqual({ source: 'flutter' });
    expect(dataWithoutHints({ symbolize: cmd })).toBeUndefined();
    const a = analyzeEntry({ id: 1, ts: 0, deviceId: 'd', source: 'app', level: 'error', tag: 'flutter', message: 'boom', data: { symbolize: cmd } });
    expect(a.json).toBeNull();
  });
});
