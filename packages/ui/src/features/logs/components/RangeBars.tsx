import { memo } from 'react';
import { Copy, ListChecks, Share2, Timer, X } from 'lucide-react';
import { Button, IconButton, SegmentedControl, formatClock, formatDuration, isMac } from '../../../components';
import { t, useT } from '../../../i18n';
import { AROUND_STEPS, type LogTimeRange } from '../model/timeRange';

const STEP_LABEL: Record<number, { tr: string; en: string }> = {
  10_000: { tr: '10 sn', en: '10 s' },
  30_000: { tr: '30 sn', en: '30 s' },
  60_000: { tr: '1 dk', en: '1 min' },
  300_000: { tr: '5 dk', en: '5 min' },
};

/** "14:02:10 – 14:02:40" (milliseconds only when the window is shorter than ten seconds). */
function clockSpan(r: Pick<LogTimeRange, 'from' | 'to'>): { from: string; to: string } {
  const ms = r.to - r.from < 10_000;
  return { from: formatClock(r.from, { ms }), to: formatClock(r.to, { ms }) };
}

export interface RangeBarProps {
  range: LogTimeRange;
  /** Rows the list shows inside the range (after the other filters). */
  count: number;
  lang: 'tr' | 'en';
  onStep(half: number): void;
  onCopy(): void;
  onShare(): void;
  onClear(): void;
}

/**
 * The list is narrowed to a time window ("±30 s around this line", a Shift-drag on the histogram): which window,
 * how many lines, a wider or narrower window around the same line, Copy / Share of exactly those lines, and ✕.
 */
export const RangeBar = memo(function RangeBar({ range, count, lang, onStep, onCopy, onShare, onClear }: RangeBarProps) {
  useT();
  const span = clockSpan(range);
  return (
    <div className="lg-paused lg-rangebar" role="region" aria-label={t('logs.range.label')}>
      <Timer size={13} aria-hidden />
      <span className="lg-rangebar__text">
        <span className="lg-rangebar__title tnum">{t('logs.range.title', span)}</span>
        <span className="lg-paused__sep" aria-hidden>
          ·
        </span>
        <span className="muted tnum">{count > 0 ? t('logs.range.lines', { count }) : t('logs.range.nothing')}</span>
        {range.anchor ? null : (
          <span className="muted tnum lg-rangebar__span">
            <span className="lg-paused__sep" aria-hidden>
              ·
            </span>{' '}
            {formatDuration(range.to - range.from)}
          </span>
        )}
      </span>
      {range.anchor ? (
        <SegmentedControl<string>
          size="sm"
          value={String(range.half ?? 0)}
          onChange={(v) => onStep(Number(v))}
          aria-label={t('logs.range.stepsLabel')}
          className="lg-rangebar__steps"
          options={AROUND_STEPS.map((ms) => ({ value: String(ms), label: t('logs.range.step', { span: STEP_LABEL[ms]?.[lang] ?? formatDuration(ms) }) }))}
        />
      ) : null}
      <span className="lg-rangebar__tools">
        <Button size="sm" variant="ghost" icon={Copy} disabled={count === 0} onClick={onCopy}>
          {t('logs.range.copy')}
        </Button>
        <Button size="sm" variant="ghost" icon={Share2} disabled={count === 0} onClick={onShare}>
          {t('logs.range.share')}
        </Button>
        <IconButton icon={X} size="sm" label={t('logs.range.clear')} onClick={onClear} />
      </span>
    </div>
  );
});

export interface SelectionBarProps {
  count: number;
  /** Time between the oldest and the newest selected line (ms). */
  spanMs: number;
  onCopy(): void;
  onShare(): void;
  /** One selected line: show the moments around it. */
  onAround?(): void;
  onClear(): void;
}

/** Several lines are selected (Shift / ⌘-click): how many, Copy (⌘C), Share…, Clear (Esc). */
export const SelectionBar = memo(function SelectionBar({ count, spanMs, onCopy, onShare, onAround, onClear }: SelectionBarProps) {
  useT();
  return (
    <div className="lg-paused lg-selbar" role="region" aria-label={t('logs.selection.label')}>
      <ListChecks size={13} aria-hidden />
      <span className="lg-rangebar__text">
        <span className="lg-rangebar__title tnum" aria-live="polite">
          {t('logs.selection.count', { count })}
        </span>
        {spanMs > 0 ? (
          <>
            <span className="lg-paused__sep" aria-hidden>
              ·
            </span>
            <span className="muted tnum">{t('logs.selection.span', { span: formatDuration(spanMs) })}</span>
          </>
        ) : null}
        <span className="lg-selbar__hint muted">{t('logs.selection.hint', { mod: isMac ? '⌘' : 'Ctrl' })}</span>
      </span>
      <span className="lg-rangebar__tools">
        <Button size="sm" variant="ghost" icon={Copy} kbd="Mod+C" onClick={onCopy}>
          {t('logs.selection.copy')}
        </Button>
        <Button size="sm" variant="ghost" icon={Share2} onClick={onShare}>
          {t('logs.selection.share')}
        </Button>
        {onAround ? (
          <Button size="sm" variant="ghost" icon={Timer} onClick={onAround}>
            {t('logs.selection.around')}
          </Button>
        ) : null}
        <IconButton icon={X} size="sm" label={t('logs.selection.clear')} shortcut="Escape" onClick={onClear} />
      </span>
    </div>
  );
});
