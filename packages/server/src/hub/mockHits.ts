/**
 * How many requests each mock rule answered (MockRuleHits on the wire): the server's count, so every window shows
 * the same number and clearing the request list (or the memory limit dropping old requests) does not make a rule
 * look unused.
 *
 * Counted once per request, when its response (or failure) arrives marked `mocked` with a `mockRuleId`.
 * Reset rules:
 *   - a rule deleted from the mock list loses its count (`retain`); a rule with the same id added later starts at 0;
 *   - a server restart starts every count at 0 (nothing is written to disk);
 *   - clearing logs / requests / an app keeps the counts;
 *   - app scope: `byApp` splits the total per app session (the UI sums the sessions of the scope it shows); the
 *     sessions kept per rule are bounded, the oldest go first, so a long day of hot restarts may undercount an old
 *     session while the total stays exact.
 * Bounded: at most MAX_COUNTED_RULES rules (the least recently hit goes), MAX_APPS_PER_RULE sessions each.
 */
import type { MockRuleHits } from '@durbun/protocol';

export const MAX_COUNTED_RULES = 2_000;
export const MAX_APPS_PER_RULE = 50;

interface Count {
  count: number;
  lastTs: number;
  byApp: Map<string, number>;
}

export class MockHitCounter {
  private readonly rules = new Map<string, Count>();
  private revision = 0;
  private reported = 0;

  hit(ruleId: string, appId: string | undefined, ts: number): void {
    let c = this.rules.get(ruleId);
    if (c) this.rules.delete(ruleId); // re-insert: the map's order is "least recently hit first"
    else c = { count: 0, lastTs: 0, byApp: new Map() };
    this.rules.set(ruleId, c);
    if (this.rules.size > MAX_COUNTED_RULES) this.rules.delete(this.rules.keys().next().value!);
    c.count++;
    if (Number.isFinite(ts) && ts > c.lastTs) c.lastTs = ts;
    if (appId) {
      const n = (c.byApp.get(appId) ?? 0) + 1;
      c.byApp.delete(appId);
      c.byApp.set(appId, n);
      if (c.byApp.size > MAX_APPS_PER_RULE) c.byApp.delete(c.byApp.keys().next().value!);
    }
    this.revision++;
  }

  /** Keep only the counts of these rule ids (the mock list changed: deleted rules lose theirs). True when any went. */
  retain(ruleIds: Iterable<string>): boolean {
    const keep = new Set(ruleIds);
    let changed = false;
    for (const id of [...this.rules.keys()]) {
      if (keep.has(id)) continue;
      this.rules.delete(id);
      changed = true;
    }
    if (changed) this.revision++;
    return changed;
  }

  snapshot(): MockRuleHits {
    const out: MockRuleHits = {};
    for (const [id, c] of this.rules) {
      out[id] = { count: c.count, lastTs: c.lastTs };
      if (c.byApp.size) out[id]!.byApp = Object.fromEntries(c.byApp);
    }
    return out;
  }

  /** True once after each change (the batcher attaches the counts to the next batch only then). */
  takeIfChanged(): boolean {
    if (this.reported === this.revision) return false;
    this.reported = this.revision;
    return true;
  }
}
