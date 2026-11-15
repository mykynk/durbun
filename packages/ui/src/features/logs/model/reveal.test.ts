import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { contextPartKeys, mergeContext, revealNeeds } from './reveal';
import { rankOf } from './types';

let nextId = 1;
const line = (p: Partial<LogEntry> = {}): LogEntry => ({ id: nextId++, ts: 1, deviceId: 'android:1', source: 'app', level: 'debug', tag: 't', message: 'cart loaded', ...p });
const filter = (p: Partial<Parameters<typeof revealNeeds>[1]> = {}): Parameters<typeof revealNeeds>[1] => ({
  minRank: 0,
  queryMinRank: 0,
  sources: { app: true, device: true, system: true },
  hideNoise: false,
  noise: () => false,
  showNetwork: true,
  query: { matchesAll: true, test: () => true },
  ...p,
});
const none = { query: false, level: false, sources: false, noise: false, network: false };

describe('show in context: which filters hide the line', () => {
  it('nothing when the line is visible as things are', () => {
    expect(revealNeeds(line(), filter())).toEqual(none);
  });

  it('names each filter that hides it, and only those', () => {
    const q = { matchesAll: false, test: (e: LogEntry) => e.message.includes('payment') };
    expect(revealNeeds(line(), filter({ query: q }))).toEqual({ ...none, query: true });
    expect(revealNeeds(line(), filter({ queryMinRank: rankOf('warn') }))).toEqual({ ...none, query: true });
    expect(revealNeeds(line(), filter({ minRank: rankOf('info') }))).toEqual({ ...none, level: true });
    expect(revealNeeds(line({ source: 'device' }), filter({ sources: { app: true, device: false, system: true } }))).toEqual({ ...none, sources: true });
    expect(revealNeeds(line({ source: 'device' }), filter({ hideNoise: true, noise: () => true }))).toEqual({ ...none, noise: true });
    expect(revealNeeds(line({ kind: 'network' }), filter({ showNetwork: false }))).toEqual({ ...none, network: true });
    expect(revealNeeds(line({ level: 'error' }), filter({ minRank: rankOf('info') }))).toEqual(none);
  });

  it('a second jump suspends more, never less; the scope to go back to is the first one left', () => {
    const first = mergeContext(null, { ...none, query: true }, { kind: 'device', deviceId: 'android:1' });
    const second = mergeContext(first, { ...none, noise: true }, { kind: 'all' });
    expect(second).toEqual({ ...none, query: true, noise: true, scope: { kind: 'device', deviceId: 'android:1' } });
    expect(contextPartKeys(second!)).toEqual(['query', 'noise', 'scope']);
    expect(mergeContext(null, none)).toBeNull();
  });
});
