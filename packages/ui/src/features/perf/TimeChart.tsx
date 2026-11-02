import { memo, useEffect, useRef, type ReactNode } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { withAlpha, type ChartColors } from './theme';
import { yRange } from './model';
import type { Annotation, AnnotationType } from './traffic';

export interface ChartSeriesSpec {
  key: string;
  label: string;
  /** Resolved CSS color (see theme.ts). */
  color: string;
  kind?: 'line' | 'area' | 'bars';
  format: (v: number) => string;
}

export interface PlotRect {
  left: number;
  width: number;
}

export interface TimeChartProps {
  title: string;
  /** Small note next to the title (e.g. "5-second average"). */
  note?: ReactNode;
  series: readonly ChartSeriesSpec[];
  xs: readonly number[];
  ys: readonly (readonly (number | null | undefined)[])[];
  /** Visible x range in seconds (shared by all charts). */
  xRange: readonly [number, number];
  /** The y axis reaches at least this value (e.g. 60 fps). */
  softMax?: number;
  /** Use exactly [0, softMax] while the data stays below it. */
  snapMax?: boolean;
  colors: ChartColors;
  annotations: readonly Annotation[];
  yFormat: (v: number) => string;
  /** Axis tick label for a time (s) given the visible span (s). */
  timeFormat: (sec: number, spanSec: number) => string;
  /** Tooltip header for a time (s). */
  tooltipTime: (sec: number) => string;
  syncKey: string;
  /** Latest value per series for the header legend (undefined → "—"). */
  legendValues?: readonly (string | undefined)[];
  /** Overlay text when there is nothing to draw. */
  emptyText?: string;
  onPlotRect?: (rect: PlotRect) => void;
  ariaLabel: string;
}

const ANNOTATION_COLOR: Record<AnnotationType, keyof ChartColors> = {
  crash: 'crash',
  anr: 'anr',
  marker: 'marker',
  connect: 'connect',
  reconnect: 'connect',
};

/** Fixed y-axis width so the plot areas of all stacked charts line up (and the event lane above them). */
export const Y_AXIS_SIZE = 50;

/**
 * One uPlot time-series chart: 2px lines (10 % area wash or thin bars), hairline grid, synced crosshair,
 * one tooltip listing every series at the hovered time, vertical annotation lines. Theme changes recreate the
 * chart (canvas colors are resolved from tokens); data changes only call setData.
 */
export const TimeChart = memo(function TimeChart(props: TimeChartProps) {
  const { title, note, series, xs, ys, xRange, colors, annotations, legendValues, emptyText, ariaLabel } = props;
  const plotRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const configKey = JSON.stringify([series.map((s) => [s.key, s.label, s.color, s.kind ?? 'line']), colors.theme, colors.surface, colors.grid, colors.subtle, props.syncKey]);

  // Create / recreate (theme or series set changed).
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const p = latest.current;
    const c = p.colors;
    let hovered = false;
    const tip = document.createElement('div');
    tip.className = 'pf-tip';
    tip.setAttribute('aria-hidden', 'true');
    const tipTime = document.createElement('div');
    tipTime.className = 'pf-tip__time';
    tip.appendChild(tipTime);
    const tipRows = p.series.map((s) => {
      const row = document.createElement('div');
      row.className = 'pf-tip__row';
      const key = document.createElement('span');
      key.className = 'pf-tip__key';
      key.style.background = s.color;
      const value = document.createElement('span');
      value.className = 'pf-tip__value';
      const label = document.createElement('span');
      label.className = 'pf-tip__label';
      label.textContent = s.label;
      row.append(key, value, label);
      tip.appendChild(row);
      return { row, value };
    });

    const opts: uPlot.Options = {
      width: Math.max(80, Math.floor(rect.width)),
      height: Math.max(60, Math.floor(rect.height)),
      padding: [10, 10, 0, 0],
      legend: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      cursor: {
        sync: { key: p.syncKey, setSeries: false },
        drag: { x: false, y: false, setScale: false },
        focus: { prox: -1 },
        y: false,
        points: {
          size: 8,
          width: 2,
          stroke: () => c.surface,
          fill: (_u: uPlot, i: number) => p.series[i - 1]?.color ?? c.text,
        },
      },
      scales: {
        x: { time: true, range: () => [latest.current.xRange[0], latest.current.xRange[1]] },
        y: { range: (_u: uPlot, _min: number | null, max: number | null) => yRange(max, latest.current.softMax ?? 1, latest.current.snapMax) },
      },
      axes: [
        {
          stroke: c.subtle,
          font: c.font,
          size: 24,
          space: 72,
          gap: 4,
          grid: { stroke: c.grid, width: 1 },
          ticks: { show: false },
          values: (u: uPlot, splits: number[]) => {
            const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0);
            return splits.map((v) => latest.current.timeFormat(v, span));
          },
        },
        {
          stroke: c.subtle,
          font: c.font,
          size: Y_AXIS_SIZE,
          space: 24,
          gap: 6,
          grid: { stroke: c.grid, width: 1 },
          ticks: { show: false },
          values: (_u: uPlot, splits: number[]) => splits.map((v) => latest.current.yFormat(v)),
        },
      ],
      series: [
        {},
        ...p.series.map((s): uPlot.Series => {
          if (s.kind === 'bars') {
            return {
              label: s.label,
              stroke: s.color,
              fill: withAlpha(s.color, 0.8),
              width: 0,
              points: { show: false },
              paths: uPlot.paths.bars!({ size: [0.55, 7, 1], align: 0 }),
            };
          }
          return {
            label: s.label,
            stroke: s.color,
            width: 2,
            fill: s.kind === 'area' ? withAlpha(s.color, 0.1) : undefined,
            points: { show: false },
            spanGaps: false,
          };
        }),
      ],
      hooks: {
        ready: [
          (u) => {
            u.over.appendChild(tip);
            u.over.addEventListener('mouseenter', () => {
              hovered = true;
            });
            u.over.addEventListener('mouseleave', () => {
              hovered = false;
              tip.style.display = 'none';
            });
            report(u);
          },
        ],
        setSize: [(u) => report(u)],
        draw: [(u) => drawAnnotations(u)],
        setCursor: [(u) => updateTip(u)],
      },
    };

    function report(u: uPlot) {
      const ratio = uPlot.pxRatio || 1;
      latest.current.onPlotRect?.({ left: u.bbox.left / ratio, width: u.bbox.width / ratio });
    }

    function drawAnnotations(u: uPlot) {
      const list = latest.current.annotations;
      if (list.length === 0) return;
      const { ctx } = u;
      const { top, height, left, width } = u.bbox;
      const min = u.scales.x.min ?? -Infinity;
      const max = u.scales.x.max ?? Infinity;
      const ratio = uPlot.pxRatio || 1;
      ctx.save();
      ctx.lineWidth = Math.max(1, Math.round(ratio));
      for (const a of list) {
        const x = a.ts / 1000;
        if (x < min || x > max) continue;
        const px = Math.round(u.valToPos(x, 'x', true)) + 0.5;
        if (px < left || px > left + width) continue;
        ctx.globalAlpha = a.type === 'connect' || a.type === 'reconnect' ? 0.55 : 0.7;
        ctx.strokeStyle = latest.current.colors[ANNOTATION_COLOR[a.type]] as string;
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px, top + height);
        ctx.stroke();
      }
      ctx.restore();
    }

    function updateTip(u: uPlot) {
      const idx = u.cursor.idx;
      const leftPos = u.cursor.left ?? -1;
      if (!hovered || idx === null || idx === undefined || leftPos < 0) {
        tip.style.display = 'none';
        return;
      }
      const cur = latest.current;
      const xVal = u.posToVal(leftPos, 'x');
      tipTime.textContent = cur.tooltipTime(xVal);
      let any = false;
      tipRows.forEach((r, i) => {
        const sIdx = i + 1;
        const di = u.cursor.idxs?.[sIdx];
        const v = di !== null && di !== undefined ? u.data[sIdx]?.[di] : undefined;
        const has = typeof v === 'number' && Number.isFinite(v);
        r.value.textContent = has ? cur.series[i]!.format(v) : '—';
        r.row.style.opacity = has ? '1' : '0.55';
        any ||= has;
      });
      if (!any) {
        tip.style.display = 'none';
        return;
      }
      tip.style.display = 'block';
      const plotW = u.over.clientWidth;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const topPos = u.cursor.top ?? 0;
      let x = leftPos + 14;
      if (x + tw > plotW) x = leftPos - tw - 14;
      const y = Math.max(0, Math.min(topPos - th / 2, u.over.clientHeight - th));
      tip.style.transform = `translate(${Math.round(Math.max(0, x))}px, ${Math.round(y)}px)`;
    }

    const data = [p.xs as number[], ...p.ys.map((y) => y as (number | null)[])] as uPlot.AlignedData;
    const u = new uPlot(opts, data, el);
    uRef.current = u;

    let frame = 0;
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              const r = el.getBoundingClientRect();
              if (r.width < 10 || r.height < 10) return;
              const w = Math.floor(r.width);
              const h = Math.floor(r.height);
              if (w !== u.width || h !== u.height) u.setSize({ width: w, height: h });
            });
          })
        : null;
    ro?.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      u.destroy();
      if (uRef.current === u) uRef.current = null;
    };
    // configKey captures everything the chart is built from; the rest is read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  // Data / range updates.
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    u.setData([xs as number[], ...ys.map((y) => y as (number | null)[])] as uPlot.AlignedData);
  }, [xs, ys, xRange]);

  // Annotation-only changes need a redraw.
  useEffect(() => {
    uRef.current?.redraw(false, false);
  }, [annotations]);

  const hasData = ys.some((arr) => arr.some((v) => typeof v === 'number'));

  return (
    <section className="pf-chart" aria-label={title}>
      <header className="pf-chart__head">
        <h3 className="pf-chart__title">{title}</h3>
        {note ? <span className="pf-chart__note">{note}</span> : null}
        <span className="grow" />
        {series.length > 0 ? (
          <ul className="pf-legend" aria-label={title}>
            {series.map((s, i) => (
              <li key={s.key} className="pf-legend__item">
                <span className={s.kind === 'bars' ? 'pf-legend__swatch pf-legend__swatch--bar' : 'pf-legend__swatch'} style={{ background: s.color }} aria-hidden />
                <span className="pf-legend__label">{s.label}</span>
                {legendValues ? <span className="pf-legend__value">{legendValues[i] ?? '—'}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </header>
      <div className="pf-chart__body">
        <div ref={plotRef} className="pf-chart__plot" role="img" aria-label={ariaLabel} />
        {!hasData && emptyText ? <div className="pf-chart__empty">{emptyText}</div> : null}
      </div>
    </section>
  );
});
