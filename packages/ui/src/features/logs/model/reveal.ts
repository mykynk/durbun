import type { LogEntry } from '@durbun/protocol';
import type { Scope } from '../../../data';
import { isStructural, rankOf, type RowFilter } from './types';

/**
 * "Show in context" / a jump from another tab must show a line the user's filters hide WITHOUT throwing those
 * filters away. The view enters a temporary context: only the filters that hide the line are suspended (never
 * written to the saved query or the prefs), a bar says which, and "Back to my filters" ends it. Editing any filter
 * while in context keeps what is on screen as the new filter (`commit`).
 */
export interface RevealContext {
  /** The query (its text, its `level:` floor) hides the line. */
  query: boolean;
  /** The toolbar's minimum level hides it. */
  level: boolean;
  /** Its source (device / app / system) is switched off. */
  sources: boolean;
  /** It is a noise line and noise is hidden (the `hideNoise` pref stays as it is). */
  noise: boolean;
  /** It is a network line and they are hidden (the `showNetworkInLogs` pref stays as it is). */
  network: boolean;
  /** The scope the jump left (the line was outside it): "Back" returns to it. */
  scope?: Scope;
}

export type RevealParts = Omit<RevealContext, 'scope'>;

/** Which of the user's filters hide [e] (scope aside). All false: the line is visible as things are. */
export function revealNeeds(e: LogEntry, f: Pick<RowFilter, 'minRank' | 'queryMinRank' | 'sources' | 'hideNoise' | 'noise' | 'showNetwork' | 'query'>): RevealParts {
  const rank = rankOf(e.level);
  return {
    query: rank < f.queryMinRank || (!f.query.matchesAll && !f.query.test(e)),
    level: rank < f.minRank && !isStructural(e),
    sources: e.kind !== 'marker' && f.sources[e.source] === false,
    noise: e.source === 'device' && f.hideNoise && f.noise(e),
    network: e.kind === 'network' && !f.showNetwork,
  };
}

export function anyPart(p: RevealParts): boolean {
  return p.query || p.level || p.sources || p.noise || p.network;
}

/** A second jump while in context suspends more, never less; the scope to go back to is the first one. */
export function mergeContext(cur: RevealContext | null, parts: RevealParts, leftScope?: Scope): RevealContext | null {
  const next: RevealContext = {
    query: !!cur?.query || parts.query,
    level: !!cur?.level || parts.level,
    sources: !!cur?.sources || parts.sources,
    noise: !!cur?.noise || parts.noise,
    network: !!cur?.network || parts.network,
    ...(cur?.scope ? { scope: cur.scope } : leftScope ? { scope: leftScope } : {}),
  };
  return anyPart(next) || next.scope ? next : null;
}

/** The suspended parts, in the order the bar names them. */
export function contextPartKeys(c: RevealContext): ('query' | 'level' | 'sources' | 'noise' | 'network' | 'scope')[] {
  const out: ('query' | 'level' | 'sources' | 'noise' | 'network' | 'scope')[] = [];
  if (c.query) out.push('query');
  if (c.level) out.push('level');
  if (c.sources) out.push('sources');
  if (c.noise) out.push('noise');
  if (c.network) out.push('network');
  if (c.scope) out.push('scope');
  return out;
}
