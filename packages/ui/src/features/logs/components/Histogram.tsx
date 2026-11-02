import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { formatClock, useElementSize } from '../../../components';
import { t, useT } from '../../../i18n';
import type { HistogramIndex, HistogramView } from '../model/histogram';

export interface HistogramProps {
  hist: HistogramIndex;
  /** Re-render trigger (model version). */
  version: number;
  /** Visible window [from, to] (epoch ms) to highlight, or null. */
  visible: { from: number; to: number } | null;
  /** Jump to the first row at or after this time. */
  onJump(ts: number): void;
}

const BAR_W = 3; // px per display bucket (incl. 1px gap)
const REFRESH_MS = 250;
/** Show at least 5 minutes so a fresh session fills in from the right. */
const MIN_SPAN_MS = 5 * 60_000;

function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Thin log-volume strip: stacked bars per time bucket (errors / warnings / the rest) for the current
 * filter, the visible window highlighted. Click or drag to jump. Aggregation is incremental (per-second
 * base buckets) and redrawn at most 4× per second.
 */
export const Histogram = memo(function Histogram({ hist, version, visible, onJump }: HistogramProps) {
  useT(); // re-render on language change (memoized)
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width } = useElementSize(wrapRef);
  const [tick, setTick] = useState(0);
  const lastDraw = useRef({ at: 0, version: -1, hv: -1 });
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);

  // Throttle redraws: at most every REFRESH_MS while data streams in.
  useEffect(() => {
    if (hist.version === lastDraw.current.hv) return;
    const wait = REFRESH_MS - (performance.now() - lastDraw.current.at);
    if (wait <= 0) {
      setTick((x) => x + 1);
      return;
    }
    const id = setTimeout(() => setTick((x) => x + 1), wait);
    return () => clearTimeout(id);
  }, [version, hist]);

  const buckets = Math.max(1, Math.floor(width / BAR_W));
  const view: HistogramView = useMemo(() => {
    lastDraw.current.at = performance.now();
    lastDraw.current.hv = hist.version;
    return hist.view(buckets, MIN_SPAN_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, buckets, hist]);

  // Theme changes swap the CSS variables: redraw when <html data-theme> changes.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const h = canvas.clientHeight || 24;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    if (view.count === 0 || view.max === 0) return;
    const cErr = cssVar(canvas, '--lv-error', '#ff6369');
    const cWarn = cssVar(canvas, '--lv-warn', '#f5b544');
    const cOther = cssVar(canvas, '--lg-hist-bar', '#6b7488');
    const slot = width / view.count;
    const bw = Math.max(1, slot - (slot >= 3 ? 1 : 0));
    const usable = h - 3;
    // log scale: a startup flood must not flatten everything else; any non-empty bucket stays visible
    const logMax = Math.log1p(view.max);
    const scale = (n: number) => (n <= 0 ? 0 : Math.max(2, (Math.log1p(n) / logMax) * usable));
    for (let i = 0; i < view.count; i++) {
      const total = view.other[i]! + view.warn[i]! + view.err[i]!;
      if (total === 0) continue;
      const x = i * slot;
      const full = scale(total);
      const errH = (view.err[i]! / total) * full;
      const warnH = (view.warn[i]! / total) * full;
      const otherH = full - errH - warnH;
      let y = h - 1;
      if (otherH > 0) {
        ctx.fillStyle = cOther;
        ctx.fillRect(x, y - otherH, bw, otherH);
        y -= otherH;
      }
      if (warnH > 0) {
        ctx.fillStyle = cWarn;
        ctx.fillRect(x, y - Math.max(1, warnH), bw, Math.max(1, warnH));
        y -= warnH;
      }
      if (errH > 0) {
        ctx.fillStyle = cErr;
        ctx.fillRect(x, y - Math.max(2, errH), bw, Math.max(2, errH));
      }
    }
  }, [view, width, themeTick]);

  const span = view.to - view.from;
  const xToTs = (x: number) => view.from + (Math.min(Math.max(x, 0), width) / Math.max(1, width)) * span;

  const drag = useRef(false);
  const raf = useRef(0);
  const jumpAt = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || view.count === 0) return;
    const ts = xToTs(clientX - rect.left);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => onJump(ts));
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || view.count === 0) return;
    drag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    jumpAt(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect && view.count > 0) {
      const x = e.clientX - rect.left;
      setHover({ x, i: Math.min(view.count - 1, Math.max(0, Math.floor((x / Math.max(1, width)) * view.count))) });
    }
    if (drag.current) jumpAt(e.clientX);
  };
  const endDrag = () => {
    drag.current = false;
  };

  let win: { left: number; width: number } | null = null;
  if (visible && span > 0 && width > 0) {
    const l = ((Math.max(visible.from, view.from) - view.from) / span) * width;
    const r = ((Math.min(visible.to, view.to) - view.from) / span) * width;
    if (r >= l - 1) win = { left: Math.max(0, l), width: Math.max(3, r - l) };
  }

  let readout: string | null = null;
  if (hover && view.count > 0) {
    const i = hover.i;
    const from = view.from + i * view.step;
    const parts = [t('logs.hist.lines', { count: view.other[i]! + view.warn[i]! + view.err[i]! })];
    if (view.err[i]) parts.push(t('logs.hist.errors', { count: view.err[i]! }));
    if (view.warn[i]) parts.push(t('logs.hist.warnings', { count: view.warn[i]! }));
    readout = `${formatClock(from, { ms: false })} – ${formatClock(from + view.step, { ms: false })} · ${parts.join(' · ')}`;
  }

  return (
    <div
      ref={wrapRef}
      className="lg-hist"
      role="img"
      aria-label={`${t('logs.hist.label')} · ${t('logs.hist.hint')}`}
      title={t('logs.hist.hint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} className="lg-hist__canvas" aria-hidden />
      {win ? <div className="lg-hist__window" style={{ left: win.left, width: win.width }} aria-hidden /> : null}
      {hover && readout ? (
        <>
          <div className="lg-hist__cursor" style={{ left: hover.x }} aria-hidden />
          <div className={`lg-hist__readout${hover.x > width / 2 ? ' is-left' : ''}`} style={hover.x > width / 2 ? { right: width - hover.x + 8 } : { left: hover.x + 8 }}>
            {readout}
          </div>
        </>
      ) : null}
      {view.count > 0 ? (
        <>
          <span className="lg-hist__edge lg-hist__edge--start tnum">{formatClock(view.from, { ms: false })}</span>
          <span className="lg-hist__edge lg-hist__edge--end tnum">{formatClock(view.to, { ms: false })}</span>
        </>
      ) : null}
    </div>
  );
});
