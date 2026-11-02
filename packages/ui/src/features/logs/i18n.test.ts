import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeys, setLanguage } from '../../i18n/core';
import '../../i18n';
import './i18n';
import { systemText } from './model/systemText';

const dir = existsSync(join(process.cwd(), 'src/features/logs')) ? join(process.cwd(), 'src/features/logs') : join(process.cwd(), 'packages/ui/src/features/logs');

function walk(d: string, out: string[] = []): string[] {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'query') walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const own = (lang: 'tr' | 'en') => new Set(messageKeys(lang).filter((k) => k.startsWith('logs.')));

describe('logs dictionary', () => {
  afterAll(() => setLanguage('en'));

  it('Turkish and English define exactly the same keys', () => {
    const tr = own('tr');
    const en = own('en');
    expect([...tr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !tr.has(k))).toEqual([]);
    expect(tr.size).toBeGreaterThan(200);
  });

  it('every literal t("logs.…") / t("common.…") key used by the view exists in both languages', () => {
    const used = new Set<string>();
    for (const f of walk(dir)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*['`]((?:logs|common|shell)\.[A-Za-z0-9_.-]+)['`]/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(100);
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    expect([...used].filter((k) => !tr.has(k) || !en.has(k))).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, readonly string[]> = {
      'logs.source.row': ['device', 'app', 'system'],
      'logs.source': ['device', 'app', 'system', 'deviceHint', 'appHint', 'systemHint'],
      'logs.level': ['verbose', 'debug', 'info', 'warn', 'error'],
      'logs.kind': ['crash', 'anr', 'flutterError', 'event', 'network', 'marker', 'lifecycle', 'text'],
      'logs.rules.fields': ['tag', 'process', 'message'],
      'logs.rules.matches': ['exact', 'prefix', 'contains'],
      'logs.rules.colors': ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'pink'],
      'logs.presets': ['errors', 'crashes', 'network', 'flutter', 'events'],
    };
    const tr = new Set(messageKeys('tr'));
    const en = new Set(messageKeys('en'));
    const missing: string[] = [];
    for (const [prefix, ids] of Object.entries(families)) for (const id of ids) if (!tr.has(`${prefix}.${id}`) || !en.has(`${prefix}.${id}`)) missing.push(`${prefix}.${id}`);
    expect(missing).toEqual([]);
  });

  it('never uses CSS uppercase (Turkish "info" → "İNFO")', () => {
    const css = readFileSync(join(dir, 'logs.css'), 'utf8');
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  });
});

describe('system line text', () => {
  it('localizes server params ({device}/{app}/{process}/{label,n}) through the shared code messages', () => {
    setLanguage('tr');
    expect(systemText({ code: 'device.connected', params: { device: 'Pixel 8 · Demo', deviceId: 'demo:1' }, message: 'Device connected: Pixel 8 · Demo' })).toContain('Pixel 8 · Demo');
    expect(systemText({ code: 'process.died', params: { process: 'com.mykynk.pati', pid: 4821 }, message: 'Process died' })).toContain('com.mykynk.pati');
    expect(systemText({ code: 'vm.hotRestart', params: { app: 'Pati' }, message: 'Hot restart: Pati' })).toContain('Pati');
    expect(systemText({ code: 'marker', params: { label: '', n: 3 }, message: 'Marker 3' })).toBe('İşaret 3');
    expect(systemText({ code: 'marker', params: { label: 'Ödeme', n: 4 }, message: 'Ödeme' })).toBe('Ödeme');
    expect(systemText({ code: 'some.unknown', params: {}, message: 'English fallback' })).toBe('English fallback');
    setLanguage('en');
    expect(systemText({ code: 'marker', params: { label: '', n: 3 }, message: 'Marker 3' })).toBe('Marker 3');
  });
});
