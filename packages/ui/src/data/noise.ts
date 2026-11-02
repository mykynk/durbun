import type { LogEntry } from '@durbun/protocol';
import type { NoiseRule } from './stores/prefs';

/**
 * Compile the user's noise rules into one predicate (true = noisy → hide when `hideNoise`).
 * Only device logs are considered noise; app/system lines are never hidden by these rules.
 * Matching is case-insensitive with plain toLowerCase (SPEC §7.1).
 */
export function compileNoiseRules(rules: readonly NoiseRule[]): (e: Pick<LogEntry, 'source' | 'tag' | 'process' | 'message'>) => boolean {
  const active = rules.filter((r) => r.enabled && r.value.trim());
  if (active.length === 0) return () => false;
  const exact = { tag: new Set<string>(), process: new Set<string>(), message: new Set<string>() };
  const prefix: { field: NoiseRule['field']; value: string }[] = [];
  const contains: { field: NoiseRule['field']; value: string }[] = [];
  for (const r of active) {
    const v = r.value.trim().toLowerCase();
    if (r.match === 'exact') exact[r.field].add(v);
    else if (r.match === 'prefix') prefix.push({ field: r.field, value: v });
    else contains.push({ field: r.field, value: v });
  }
  return (e) => {
    if (e.source !== 'device') return false;
    const fields = {
      tag: (e.tag ?? '').toLowerCase(),
      process: (e.process ?? '').toLowerCase(),
      message: e.message.length > 2000 ? '' : e.message.toLowerCase(),
    };
    if (exact.tag.has(fields.tag) || (fields.process && exact.process.has(fields.process)) || exact.message.has(fields.message)) return true;
    for (const p of prefix) if (fields[p.field] && fields[p.field].startsWith(p.value)) return true;
    for (const c of contains) if (fields[c.field] && fields[c.field].includes(c.value)) return true;
    return false;
  };
}
