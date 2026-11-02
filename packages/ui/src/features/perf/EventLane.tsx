import { memo, useMemo } from 'react';
import { clsx } from 'clsx';
import { Flag, Hourglass, OctagonX, Plug, RefreshCw } from 'lucide-react';
import { logStore, ui } from '../../data';
import { Tooltip, formatClock, openContextMenu, type IconType, type MenuItem } from '../../components';
import { useT } from '../../i18n';
import type { Annotation, AnnotationType } from './traffic';
import type { PlotRect } from './TimeChart';
import { annotationText } from './usePerfData';

/** Label in the current language (the entry is re-read; the cached text is the fallback once it left the ring). */
function annotationLabel(a: Annotation): string {
  const e = logStore.getById(a.id);
  return e ? annotationText(e) : a.text;
}

const ICONS: Record<AnnotationType, IconType> = {
  crash: OctagonX,
  anr: Hourglass,
  marker: Flag,
  connect: Plug,
  reconnect: RefreshCw,
};

/** Events closer than this (px) share one marker. */
const CLUSTER_PX = 12;

interface Cluster {
  x: number;
  items: Annotation[];
  /** Most severe type in the cluster (crash > anr > marker > connect). */
  type: AnnotationType;
}

const SEVERITY: Record<AnnotationType, number> = { crash: 4, anr: 3, marker: 2, reconnect: 1, connect: 0 };

export function clusterAnnotations(list: readonly Annotation[], from: number, to: number, width: number): Cluster[] {
  const span = to - from;
  if (span <= 0 || width <= 0) return [];
  const visible = list.filter((a) => a.ts >= from && a.ts <= to).sort((a, b) => a.ts - b.ts);
  const out: Cluster[] = [];
  for (const a of visible) {
    const x = ((a.ts - from) / span) * width;
    const last = out[out.length - 1];
    if (last && x - last.x < CLUSTER_PX) {
      last.items.push(a);
      if (SEVERITY[a.type] > SEVERITY[last.type]) last.type = a.type;
    } else out.push({ x, items: [a], type: a.type });
  }
  return out;
}

/**
 * A thin timeline above the charts: one marker per crash / ANR / marker / app (re)connect in the window,
 * aligned with the charts' plot area. Click → the log row in the Logs tab; clustered markers open a menu.
 */
export const EventLane = memo(function EventLane({ annotations, from, to, rect }: { annotations: readonly Annotation[]; from: number; to: number; rect: PlotRect | null }) {
  const t = useT();
  const clusters = useMemo(() => (rect ? clusterAnnotations(annotations, from, to, rect.width) : []), [annotations, from, to, rect]);
  if (!rect) return <div className="pf-lane" aria-hidden />;
  if (clusters.length === 0)
    return (
      <div className="pf-lane" aria-hidden>
        <div className="pf-lane__inner">
          <div className="pf-lane__track" style={{ left: rect.left, width: rect.width }} />
        </div>
      </div>
    );
  const label = (a: Annotation) => {
    const text = annotationLabel(a);
    return `${t(`perf.events.${a.type}`)} · ${formatClock(a.ts, { ms: false })}${text ? ` — ${text}` : ''}`;
  };
  return (
    <div className="pf-lane" role="group" aria-label={t('perf.events.lane')}>
      <div className="pf-lane__inner">
      <span className="pf-lane__label" style={{ width: rect.left }} aria-hidden>
        {t('perf.events.short')}
      </span>
      <div className="pf-lane__track" style={{ left: rect.left, width: rect.width }}>
        {clusters.map((c) => {
          const Icon = ICONS[c.type];
          const single = c.items.length === 1 ? c.items[0]! : null;
          const tip = single ? (
            <span className="pf-lane__tip">
              <strong>{t(`perf.events.${single.type}`)}</strong> · {formatClock(single.ts, { ms: false })}
              {annotationLabel(single) ? <span className="pf-lane__tip-text">{annotationLabel(single)}</span> : null}
              <span className="pf-lane__tip-hint">{t('perf.events.hint')}</span>
            </span>
          ) : (
            t('perf.events.cluster', { count: c.items.length })
          );
          return (
            <Tooltip key={`${c.items[0]!.id}`} content={tip} side="top">
              <button
                type="button"
                className={clsx('pf-lane__mark', `pf-lane__mark--${c.type}`)}
                style={{ left: c.x }}
                aria-label={single ? label(single) : t('perf.events.cluster', { count: c.items.length })}
                onClick={(e) => {
                  if (single) {
                    ui.focusLog(single.id);
                    return;
                  }
                  const r = e.currentTarget.getBoundingClientRect();
                  const items: MenuItem[] = c.items
                    .slice()
                    .reverse()
                    .map((a) => ({ id: String(a.id), label: label(a), icon: ICONS[a.type], onSelect: () => ui.focusLog(a.id) }));
                  openContextMenu({ x: r.left, y: r.bottom + 4 }, items);
                }}
              >
                <Icon size={11} aria-hidden />
                {c.items.length > 1 ? <span className="pf-lane__count">{c.items.length}</span> : null}
              </button>
            </Tooltip>
          );
        })}
      </div>
      </div>
    </div>
  );
});
