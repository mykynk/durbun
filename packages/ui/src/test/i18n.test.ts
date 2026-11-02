import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetI18nForTests, interpolate, registerMessages, setLanguage, t, tOr, translate } from '../i18n/core';

describe('i18n core', () => {
  beforeEach(() => {
    __resetI18nForTests();
    registerMessages('demo', {
      tr: {
        hello: 'Merhaba {name}',
        lines: { one: '{count, number} satır', other: '{count, number} satır' },
        nested: { deep: { key: 'Derin' } },
        connected: ['{name} bağlandı', 'Cihaz bağlandı'],
        onlyTr: 'Yalnızca Türkçe',
      },
      en: {
        hello: 'Hello {name}',
        lines: { one: '{count, number} line', other: '{count, number} lines' },
        nested: { deep: { key: 'Deep' } },
        connected: ['{name} connected', 'Device connected'],
        onlyEn: 'English only',
      },
    });
  });

  afterAll(() => __resetI18nForTests());

  it('interpolates params and switches language', () => {
    setLanguage('tr');
    expect(t('demo.hello', { name: 'Yusuf' })).toBe('Merhaba Yusuf');
    expect(document.documentElement.lang).toBe('tr');
    setLanguage('en');
    expect(t('demo.hello', { name: 'Yusuf' })).toBe('Hello Yusuf');
  });

  it('flattens nested messages', () => {
    expect(translate('tr', 'demo.nested.deep.key')).toBe('Derin');
  });

  it('selects plural forms and formats numbers per language', () => {
    expect(translate('en', 'demo.lines', { count: 1 })).toBe('1 line');
    expect(translate('en', 'demo.lines', { count: 12345 })).toBe('12,345 lines');
    expect(translate('tr', 'demo.lines', { count: 12345 })).toBe('12.345 satır');
  });

  it('picks the first candidate whose params are present', () => {
    expect(translate('tr', 'demo.connected', { name: 'Pixel 8' })).toBe('Pixel 8 bağlandı');
    expect(translate('tr', 'demo.connected')).toBe('Cihaz bağlandı');
    expect(translate('en', 'demo.connected', { name: '' })).toBe('Device connected');
  });

  it('falls back to English, then to the key', () => {
    expect(translate('tr', 'demo.onlyEn')).toBe('English only');
    expect(translate('en', 'demo.onlyTr')).toBe('demo.onlyTr');
    expect(translate('tr', 'demo.missing')).toBe('demo.missing');
  });

  it('tOr returns the fallback for unknown keys or missing params', () => {
    setLanguage('tr');
    expect(tOr('demo.hello', { name: 'Ali' }, 'fallback')).toBe('Merhaba Ali');
    expect(tOr('demo.hello', {}, 'Hello from server')).toBe('Hello from server');
    expect(tOr('demo.nope', {}, 'Server text')).toBe('Server text');
  });

  it('leaves unknown placeholders visible', () => {
    expect(interpolate('{a} and {b}', { a: 1 }, 'en')).toBe('1 and {b}');
    expect(interpolate('port {p}', { p: 9750 }, 'tr')).toBe('port 9750');
    expect(interpolate('{p, number}', { p: 9750 }, 'tr')).toBe('9.750');
  });
});
