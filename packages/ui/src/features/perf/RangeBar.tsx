import { useEffect, useMemo } from 'react';
import { CircleAlert, Globe, ScrollText, X } from 'lucide-react';
import type { LogEntry, NetworkEntry } from '@durbun/protocol';
import { Button, IconButton, formatClock, formatDuration, openContextMenu, type MenuItem } from '../../components';
import { logStore, networkStore, ui } from '../../data';
import { useT } from '../../i18n';
import { isErrorLog } from './traffic';

/** What the target logged and requested between two moments (the store order is by id, close to time order). */
export function rangeContents(
  from: number,
  to: number,
  logs: readonly LogEntry[],
  requests: readonly NetworkEntry[],
  logIn: (e: LogEntry) => boolean,
  netIn: (e: NetworkEntry) => boolean,
): { logs: LogEntry[]; errors: LogEntry[]; requests: NetworkEntry[] } {
  const inLogs = logs.filter((e) => e.ts >= from && e.ts <= to && e.kind !== 'network' && logIn(e)).sort((a, b) => a.ts - b.ts || a.id - b.id);
  const inReqs = requests.filter((e) => e.startTs <= to && (e.endTs ?? e.startTs) >= from && netIn(e)).sort((a, b) => a.startTs - b.startTs);
  return { logs: inLogs, errors: inLogs.filter(isErrorLog), requests: inReqs };
}

/**
 * The range dragged on a chart, and what happened in it: links to its first log line, its first error and its
 * requests (a list to pick from), so a spike leads to its cause. Escape or ✕ clears it.
 */
export function RangeBar({ from, to, logIn, netIn, onClear }: { from: number; to: number; logIn: (e: LogEntry) => boolean; netIn: (e: NetworkEntry) => boolean; onClear(): void }) {
  const t = useT();
  const found = useMemo(() => rangeContents(from, to, logStore.entries, networkStore.list(), logIn, netIn), [from, to, logIn, netIn]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClear]);

  const openRequests = (anchor: HTMLElement) => {
    if (found.requests.length === 1) {
      ui.focusNetwork(found.requests[0]!.id);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const items: MenuItem[] = found.requests.slice(0, 40).map((e) => ({
      id: e.id,
      label: `${e.method} ${e.path}`,
      hint: [e.status ?? (e.state === 'failed' ? t('perf.range.failed') : '…'), e.duration !== undefined ? formatDuration(e.duration) : ''].filter(Boolean).join(' · '),
      danger: e.state === 'failed' || (e.status ?? 0) >= 500,
      onSelect: () => ui.focusNetwork(e.id),
    }));
    if (found.requests.length > 40) items.push({ type: 'label', label: t('perf.range.moreRequests', { count: found.requests.length - 40 }) });
    openContextMenu({ x: r.left, y: r.bottom + 4 }, items);
  };

  const span = formatDuration(to - from);
  return (
    <div className="pf-range" role="region" aria-label={t('perf.range.label')}>
      <span className="pf-range__time tnum">
        {formatClock(from, { ms: false })} – {formatClock(to, { ms: false })} <span className="muted">· {span}</span>
      </span>
      <span className="grow" />
      {found.logs.length || found.requests.length ? null : <span className="muted text-sm">{t('perf.range.nothing')}</span>}
      {found.errors.length ? (
        <Button size="sm" variant="ghost" icon={CircleAlert} className="pf-range__error" onClick={() => ui.focusLog(found.errors[0]!.id)}>
          {t('perf.range.firstError', { count: found.errors.length })}
        </Button>
      ) : null}
      {found.logs.length ? (
        <Button size="sm" variant="ghost" icon={ScrollText} onClick={() => ui.focusLog(found.logs[0]!.id)}>
          {t('perf.range.logs', { count: found.logs.length })}
        </Button>
      ) : null}
      {found.requests.length ? (
        <Button size="sm" variant="ghost" icon={Globe} aria-haspopup={found.requests.length > 1 ? 'menu' : undefined} onClick={(e) => openRequests(e.currentTarget)}>
          {t('perf.range.requests', { count: found.requests.length })}
        </Button>
      ) : null}
      <IconButton icon={X} size="sm" label={t('perf.range.clear')} shortcut="Escape" onClick={onClear} />
    </div>
  );
}
