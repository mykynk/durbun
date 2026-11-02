import { memo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { clsx } from 'clsx';
import {
  ArrowDownToLine,
  Binoculars,
  Bookmark,
  Box,
  CircleHelp,
  Ellipsis,
  Minus,
  Pause,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  VolumeX,
  X,
} from 'lucide-react';
import type { LogLevel, LogSource } from '@durbun/protocol';
import { Button, DropdownMenu, IconButton, Input, Popover, SegmentedControl, Toggle, Tooltip, formatNumber, type MenuItem } from '../../../components';
import { usePrefs, type Density, type TimeFormat } from '../../../data';
import { useT } from '../../../i18n';
import { LogQueryHelp, LogQueryInput, type ParsedQuery, type QuerySuggestData } from '../query';
import { PRESETS, normalizeQuery, type SavedFilter } from '../model/queryEdit';
import type { SourceToggles } from '../model/types';

const LEVELS: LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error'];
const LETTER: Record<string, string> = { verbose: 'V', debug: 'D', info: 'I', warn: 'W', error: 'E' };
const FONT_STEPS = [11, 11.5, 12, 12.5, 13, 14, 15, 16];

export interface LogsToolbarProps {
  active: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  parsed: ParsedQuery;
  onQueryChange(q: string): void;
  onQuerySubmit(q: string): void;
  getSuggestData(): QuerySuggestData;
  minLevel: LogLevel;
  onMinLevel(l: LogLevel): void;
  following: boolean;
  paused: boolean;
  onFollow(): void;
  onTogglePause(): void;
  onAddMarker(label?: string): void;
  onClear(skipConfirm: boolean): void;
  dedupe: boolean;
  onDedupe(v: boolean): void;
  fold: boolean;
  onFold(v: boolean): void;
  menuItems(): MenuItem[];
}

/** The Logs toolbar: query, level, sources, noise, follow/pause, marker, clear, view options, more. */
export const LogsToolbar = memo(function LogsToolbar(p: LogsToolbarProps) {
  const t = useT();
  const helpRef = useRef<HTMLButtonElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="lg-toolbar" role="toolbar" aria-label={t('logs.title')}>
      <div className="lg-tb-search">
        <LogQueryInput
          value={p.query}
          onChange={p.onQueryChange}
          onSubmit={p.onQuerySubmit}
          parsed={p.parsed}
          getSuggestData={p.getSuggestData}
          placeholder={t('logs.search.placeholder')}
          shortcut={['/', 'Mod+F']}
          shortcutEnabled={p.active}
          inputRef={p.inputRef}
          aria-label={t('logs.search.label')}
          className="lg-query"
          trailing={
            <button
              ref={helpRef}
              type="button"
              className="search__btn"
              aria-label={t('logs.search.help')}
              title={t('logs.search.help')}
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((o) => !o)}
            >
              <CircleHelp size={13} aria-hidden />
            </button>
          }
        />
        <Popover open={helpOpen} onClose={() => setHelpOpen(false)} anchor={helpRef} side="bottom" align="end" width={460} aria-label={t('logs.search.helpTitle')}>
          <div className="lg-help">
            <div className="lg-help__title">{t('logs.search.helpTitle')}</div>
            <LogQueryHelp />
            <div className="lg-help__foot">{t('logs.search.helpFooter')}</div>
          </div>
        </Popover>
      </div>

      <div className="lg-tb-group">
        <SegmentedControl
          size="sm"
          value={LEVELS.includes(p.minLevel) ? p.minLevel : 'verbose'}
          onChange={p.onMinLevel}
          aria-label={t('logs.level.label')}
          className="lg-levels"
          options={LEVELS.map((l) => ({
            value: l,
            label: (
              <>
                <span className={`lg-seg-lvl lg-seg-lvl--${l}`} aria-hidden>
                  {LETTER[l]}
                </span>
                <span className="sr-only">{t(`logs.level.${l}`)}</span>
              </>
            ),
            tooltip: t(`logs.level.${l}`),
          }))}
        />
      </div>

      <div className="lg-tb-group lg-tb-actions">
        <Tooltip content={p.following ? t('logs.follow.tip') : t('logs.follow.jump')} shortcut="G">
          <button type="button" className={clsx('lg-tbbtn', p.following && !p.paused && 'is-live')} aria-pressed={p.following} aria-label={t('logs.follow.off')} onClick={p.onFollow}>
            <ArrowDownToLine size={13} aria-hidden />
            <span className="lg-tbbtn__label">{t('logs.follow.off')}</span>
          </button>
        </Tooltip>
        <IconButton icon={p.paused ? Play : Pause} label={p.paused ? t('logs.resume') : `${t('logs.pause')} — ${t('logs.pauseTip')}`} shortcut="Space" size="sm" active={p.paused} onClick={p.onTogglePause} />
        <MarkerButton onAdd={p.onAddMarker} />
        <IconButton icon={Trash2} label={t('logs.clear.tip')} shortcut="Mod+Backspace" size="sm" onClick={(e) => p.onClear(e.shiftKey)} />
        <ViewOptions dedupe={p.dedupe} onDedupe={p.onDedupe} fold={p.fold} onFold={p.onFold} />
        <DropdownMenu items={p.menuItems} aria-label={t('logs.more')} minWidth={260}>
          {(trigger) => <IconButton icon={Ellipsis} label={t('logs.more')} size="sm" {...trigger} />}
        </DropdownMenu>
      </div>
    </div>
  );
});

export interface SourceFiltersProps {
  sources: SourceToggles;
  onToggleSource(s: LogSource): void;
  /** Formatted counts per source (strings → memo-friendly). */
  sourceCounts: Readonly<Record<LogSource, string>>;
  hideNoise: boolean;
  noiseCount: number;
  noiseCountText: string;
  onToggleNoise(): void;
}

/** Source toggles (Cihaz / Uygulama / Sistem with counts) and the noise toggle, right side of the filter bar. */
export const SourceFilters = memo(function SourceFilters(p: SourceFiltersProps) {
  const t = useT();
  const noiseText = p.noiseCount > 0 ? (p.hideNoise ? t('logs.noise.count', { count: p.noiseCount }) : t('logs.noise.wouldHide', { count: p.noiseCount })) : '';
  return (
    <div className="lg-srcbar">
      <div className="lg-tb-group" role="group" aria-label={t('logs.source.label')}>
        <SourceButton source="device" icon={<Smartphone size={13} aria-hidden />} on={p.sources.device} count={p.sourceCounts.device} onToggle={p.onToggleSource} />
        <SourceButton source="app" icon={<Box size={13} aria-hidden />} on={p.sources.app} count={p.sourceCounts.app} onToggle={p.onToggleSource} />
        <SourceButton source="system" icon={<Binoculars size={13} aria-hidden />} on={p.sources.system} count={p.sourceCounts.system} onToggle={p.onToggleSource} />
      </div>
      <span className="lg-chips__sep" aria-hidden />
      <Tooltip content={`${p.hideNoise ? t('logs.noise.showTip') : t('logs.noise.hideTip')} — ${t('logs.noise.hint')}`}>
        <button
          type="button"
          className={clsx('lg-tbbtn lg-noisebtn', p.hideNoise && 'is-on')}
          aria-pressed={p.hideNoise}
          aria-label={noiseText ? `${t('logs.noise.label')} · ${noiseText}` : t('logs.noise.label')}
          onClick={p.onToggleNoise}
        >
          <VolumeX size={13} aria-hidden />
          <span className="lg-tbbtn__label">{t('logs.noise.label')}</span>
          {p.noiseCount > 0 ? <span className="lg-tbbtn__count tnum">{p.hideNoise ? `−${p.noiseCountText}` : p.noiseCountText}</span> : null}
        </button>
      </Tooltip>
    </div>
  );
});

function SourceButton({ source, icon, on, count, onToggle }: { source: LogSource; icon: ReactNode; on: boolean; count: string; onToggle(s: LogSource): void }) {
  const t = useT();
  return (
    <Tooltip content={t(`logs.source.${source}Hint`)}>
      <button type="button" className={clsx('lg-tbbtn lg-srcbtn', on ? 'is-on' : 'is-off')} aria-pressed={on} aria-label={`${t(`logs.source.${source}`)} · ${count}`} onClick={() => onToggle(source)}>
        {icon}
        <span className="lg-tbbtn__label">{t(`logs.source.${source}`)}</span>
        <span className="lg-tbbtn__count tnum">{count}</span>
      </button>
    </Tooltip>
  );
}

function MarkerButton({ onAdd }: { onAdd(label?: string): void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const submit = () => {
    onAdd(label.trim() || undefined);
    setLabel('');
    setOpen(false);
  };
  return (
    <>
      <IconButton ref={ref} icon={Bookmark} label={`${t('logs.marker.add')} — ${t('logs.marker.addTip')}`} shortcut="M" size="sm" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="bottom" align="end" width={300} aria-label={t('logs.marker.add')}>
        <form
          className="lg-marker-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="lg-pop__label" htmlFor="lg-marker-label">
            {t('logs.marker.label')}
          </label>
          <div className="row gap-2">
            <Input id="lg-marker-label" size="sm" value={label} placeholder={t('logs.marker.placeholder')} onChange={(e) => setLabel(e.target.value)} maxLength={200} autoFocus />
            <Button type="submit" size="sm" variant="primary" icon={Bookmark}>
              {t('logs.marker.submit')}
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}

function ViewOptions({ dedupe, onDedupe, fold, onFold }: { dedupe: boolean; onDedupe(v: boolean): void; fold: boolean; onFold(v: boolean): void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const prefs = usePrefs();
  const fs = prefs.logFontSize;
  const idx = FONT_STEPS.findIndex((s) => s >= fs);
  const cur = idx < 0 ? FONT_STEPS.length - 1 : idx;
  const setFont = (i: number) => prefs.setPref('logFontSize', FONT_STEPS[Math.min(FONT_STEPS.length - 1, Math.max(0, i))]!);
  return (
    <>
      <Button ref={ref} size="sm" variant="ghost" icon={SlidersHorizontal} aria-expanded={open} aria-haspopup="dialog" aria-label={t('logs.view.title')} title={t('logs.view.title')} className="lg-viewbtn" onClick={() => setOpen((o) => !o)}>
        <span className="lg-tbbtn__label">{t('logs.view.button')}</span>
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="bottom" align="end" width={320} aria-label={t('logs.view.title')}>
        <div className="lg-pop">
          <div className="lg-pop__row">
            <span className="lg-pop__label">{t('logs.view.fontSize')}</span>
            <div className="row gap-1">
              <IconButton icon={Minus} label={t('logs.view.smaller')} size="xs" variant="subtle" disabled={cur <= 0} onClick={() => setFont(cur - 1)} />
              <span className="lg-pop__value tnum">{formatNumber(fs, { maxFractionDigits: 1 })} px</span>
              <IconButton icon={Plus} label={t('logs.view.larger')} size="xs" variant="subtle" disabled={cur >= FONT_STEPS.length - 1} onClick={() => setFont(cur + 1)} />
            </div>
          </div>
          <div className="lg-pop__row">
            <span className="lg-pop__label">{t('logs.view.density')}</span>
            <SegmentedControl<Density>
              size="sm"
              value={prefs.density}
              onChange={(v) => prefs.setPref('density', v)}
              aria-label={t('logs.view.density')}
              options={[
                { value: 'compact', label: t('logs.view.compact') },
                { value: 'comfortable', label: t('logs.view.comfortable') },
              ]}
            />
          </div>
          <div className="lg-pop__row">
            <span className="lg-pop__label">{t('logs.view.time')}</span>
            <SegmentedControl<TimeFormat>
              size="sm"
              value={prefs.timeFormat}
              onChange={(v) => prefs.setPref('timeFormat', v)}
              aria-label={t('logs.view.time')}
              options={[
                { value: 'absolute', label: t('logs.view.absolute'), tooltip: t('logs.view.absoluteTip') },
                { value: 'relative', label: t('logs.view.relative'), tooltip: t('logs.view.relativeTip') },
                { value: 'delta', label: t('logs.view.delta'), tooltip: t('logs.view.deltaTip') },
              ]}
            />
          </div>
          <div className="lg-pop__sep" />
          <Toggle size="sm" checked={prefs.wrapLines} onChange={(v) => prefs.setPref('wrapLines', v)} label={t('logs.view.wrap')} description={t('logs.view.wrapHint')} />
          <Toggle size="sm" checked={prefs.showNetworkInLogs} onChange={(v) => prefs.setPref('showNetworkInLogs', v)} label={t('logs.view.network')} description={t('logs.view.networkHint')} />
          <Toggle size="sm" checked={dedupe} onChange={onDedupe} label={t('logs.view.dedupe')} description={t('logs.view.dedupeHint')} />
          <Toggle size="sm" checked={fold} onChange={onFold} label={t('logs.view.fold')} />
        </div>
      </Popover>
    </>
  );
}

/* ───────────── quick filter chips ───────────── */

export interface FilterChipsProps {
  query: string;
  saved: readonly SavedFilter[];
  onApply(query: string): void;
  onSave(name: string): void;
  onRemove(id: string): void;
}

export const FilterChips = memo(function FilterChips({ query, saved, onApply, onSave, onRemove }: FilterChipsProps) {
  const t = useT();
  const norm = normalizeQuery(query);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const canSave = norm.length > 0 && !saved.some((s) => normalizeQuery(s.query) === norm) && !PRESETS.some((p) => normalizeQuery(p.query) === norm);
  return (
    <div className="lg-chips" role="group" aria-label={t('logs.presets.label')}>
      {PRESETS.map((p) => {
        const on = normalizeQuery(p.query) === norm;
        return (
          <button key={p.id} type="button" className={clsx('lg-chip', on && 'is-on')} aria-pressed={on} title={p.query} onClick={() => onApply(on ? '' : p.query)}>
            {t(p.labelKey)}
          </button>
        );
      })}
      {saved.length ? <span className="lg-chips__sep" aria-hidden /> : null}
      {saved.map((f) => {
        const on = normalizeQuery(f.query) === norm;
        return (
          <span key={f.id} className={clsx('lg-chip lg-chip--saved', on && 'is-on')}>
            <button type="button" className="lg-chip__main" aria-pressed={on} title={f.query} onClick={() => onApply(on ? '' : f.query)}>
              {f.name}
            </button>
            <button type="button" className="lg-chip__x" aria-label={`${t('logs.saved.remove')}: ${f.name}`} title={t('logs.saved.remove')} onClick={() => onRemove(f.id)}>
              <X size={10} aria-hidden />
            </button>
          </span>
        );
      })}
      {canSave ? (
        <>
          <button ref={saveRef} type="button" className="lg-chip lg-chip--add" title={t('logs.saved.saveTip')} onClick={() => setSaving(true)}>
            <Save size={11} aria-hidden />
            {t('logs.saved.save')}
          </button>
          <Popover open={saving} onClose={() => setSaving(false)} anchor={saveRef} side="bottom" align="start" width={280} aria-label={t('logs.saved.save')}>
            <form
              className="lg-marker-form"
              onSubmit={(e) => {
                e.preventDefault();
                const n = name.trim() || norm.slice(0, 40);
                onSave(n);
                setName('');
                setSaving(false);
              }}
            >
              <label className="lg-pop__label" htmlFor="lg-save-name">
                {t('logs.saved.nameLabel')}
              </label>
              <div className="row gap-2">
                <Input id="lg-save-name" size="sm" value={name} placeholder={t('logs.saved.namePlaceholder')} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
                <Button type="submit" size="sm" variant="primary">
                  {t('common.save')}
                </Button>
              </div>
              <code className="lg-pop__code">{norm}</code>
            </form>
          </Popover>
        </>
      ) : null}
    </div>
  );
});
