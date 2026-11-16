import { create } from 'zustand';
import type { MockRuleHitCount, MockRuleHits } from '@durbun/protocol';

/**
 * The server's count of the requests each mock rule answered (snapshot / batch `mockHits`): the same in every
 * window and kept when the request list is cleared. A deleted rule loses its count, a server restart starts at 0
 * (see the server's hub/mockHits.ts). `hits` stays null with a server that does not count (the UI dev mock, older
 * servers): the view then counts by itself.
 */
export interface MockHitsState {
  hits: MockRuleHits | null;
}

export const useMockHits = create<MockHitsState>()(() => ({ hits: null }));

function clean(raw: unknown): MockRuleHits | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: MockRuleHits = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const c = v as Partial<MockRuleHitCount>;
    if (typeof c.count !== 'number' || !Number.isFinite(c.count) || c.count < 0) continue;
    const entry: MockRuleHitCount = { count: c.count, lastTs: typeof c.lastTs === 'number' && Number.isFinite(c.lastTs) ? c.lastTs : 0 };
    if (c.byApp && typeof c.byApp === 'object') {
      const byApp: Record<string, number> = {};
      for (const [app, n] of Object.entries(c.byApp)) if (typeof n === 'number' && Number.isFinite(n)) byApp[app] = n;
      entry.byApp = byApp;
    }
    out[id] = entry;
  }
  return out;
}

/** Snapshot: the server's map, or null when it sends none (it does not count). */
export function setMockHitsFromSnapshot(raw: unknown): void {
  useMockHits.setState({ hits: raw === undefined ? null : clean(raw) });
}

/** Batch: a new map replaces the previous one (absent = unchanged). */
export function setMockHitsFromBatch(raw: unknown): void {
  if (raw === undefined) return;
  const hits = clean(raw);
  if (hits) useMockHits.setState({ hits });
}
