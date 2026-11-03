import { useMemo } from 'react';
import { clsx } from 'clsx';
import { Highlighter, Plus, RotateCcw, Trash2, VolumeX } from 'lucide-react';
import { Button, Checkbox, Dialog, IconButton, Input, Select, Toggle } from '../../../components';
import { DEFAULT_NOISE_RULES, HIGHLIGHT_COLORS, usePrefs, type HighlightColor, type HighlightRule, type NoiseRule } from '../../../data';
import { t } from '../../../i18n';
import type { SavedFilter } from '../model/queryEdit';

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/* ───────────── noise rules ───────────── */

/** `keepsCrashLines`: the iPhone 'apps' scope is on, so crash-relevant daemon lines bypass the rules (`keepCrashRelevant`). */
export function NoiseRulesDialog({ open, onClose, keepsCrashLines }: { open: boolean; onClose(): void; keepsCrashLines?: boolean }) {
  const rules = usePrefs((s) => s.noiseRules);
  const setPref = usePrefs((s) => s.setPref);
  const update = (id: string, patch: Partial<NoiseRule>) => setPref('noiseRules', rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setPref('noiseRules', rules.filter((r) => r.id !== id));
  const add = () => setPref('noiseRules', [...rules, { id: newId('noise'), field: 'tag', match: 'exact', value: '', enabled: true }]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('logs.rules.noiseTitle')}
      description={t('logs.rules.noiseDescription')}
      icon={VolumeX}
      size="lg"
      footer={
        <>
          <Button variant="ghost" icon={RotateCcw} onClick={() => setPref('noiseRules', DEFAULT_NOISE_RULES)}>
            {t('logs.rules.reset')}
          </Button>
          <span className="grow" />
          <Button variant="secondary" icon={Plus} onClick={add}>
            {t('logs.rules.add')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      {rules.length === 0 ? <p className="muted text-sm">{t('logs.rules.empty')}</p> : null}
      {keepsCrashLines ? <p className="muted text-sm lg-rules__note">{t('logs.rules.noiseKeepsCrash')}</p> : null}
      <div className="lg-rules" role="table" aria-label={t('logs.rules.noiseTitle')}>
        {rules.map((r) => (
          <div key={r.id} className={clsx('lg-rules__row', !r.enabled && 'is-off')} role="row">
            <Toggle size="sm" checked={r.enabled} onChange={(v) => update(r.id, { enabled: v })} aria-label={t('logs.rules.enabled')} />
            <Select
              size="sm"
              value={r.field}
              aria-label={t('logs.rules.field')}
              onChange={(e) => update(r.id, { field: e.target.value as NoiseRule['field'] })}
              options={(['tag', 'process', 'message'] as const).map((f) => ({ value: f, label: t(`logs.rules.fields.${f}`) }))}
            />
            <Select
              size="sm"
              value={r.match}
              aria-label={t('logs.rules.match')}
              onChange={(e) => update(r.id, { match: e.target.value as NoiseRule['match'] })}
              options={(['exact', 'prefix', 'contains'] as const).map((m) => ({ value: m, label: t(`logs.rules.matches.${m}`) }))}
            />
            <Input size="sm" mono value={r.value} aria-label={t('logs.rules.value')} placeholder={t('logs.rules.value')} onChange={(e) => update(r.id, { value: e.target.value })} className="lg-rules__value" />
            <IconButton icon={Trash2} label={t('logs.rules.remove')} size="sm" tone="danger" onClick={() => remove(r.id)} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}

/* ───────────── highlight rules ───────────── */

function regexError(r: HighlightRule): boolean {
  if (!r.regex || !r.pattern) return false;
  try {
    new RegExp(r.pattern);
    return false;
  } catch {
    return true;
  }
}

export function HighlightRulesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const rules = usePrefs((s) => s.highlightRules);
  const setPref = usePrefs((s) => s.setPref);
  const update = (id: string, patch: Partial<HighlightRule>) => setPref('highlightRules', rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setPref('highlightRules', rules.filter((r) => r.id !== id));
  const add = () => {
    const used = new Set(rules.map((r) => r.color));
    const color = HIGHLIGHT_COLORS.find((c) => !used.has(c)) ?? 'yellow';
    setPref('highlightRules', [...rules, { id: newId('hl'), pattern: '', regex: false, caseSensitive: false, color, enabled: true }]);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('logs.rules.highlightTitle')}
      description={t('logs.rules.highlightDescription')}
      icon={Highlighter}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button variant="secondary" icon={Plus} onClick={add}>
            {t('logs.rules.add')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      {rules.length === 0 ? <p className="muted text-sm">{t('logs.rules.empty')}</p> : null}
      <div className="lg-rules" role="table" aria-label={t('logs.rules.highlightTitle')}>
        {rules.map((r) => {
          const bad = regexError(r);
          return (
            <div key={r.id} className={clsx('lg-rules__row lg-rules__row--hl', !r.enabled && 'is-off')} role="row">
              <Toggle size="sm" checked={r.enabled} onChange={(v) => update(r.id, { enabled: v })} aria-label={t('logs.rules.enabled')} />
              <Input
                size="sm"
                mono
                value={r.pattern}
                invalid={bad}
                title={bad ? t('logs.rules.invalidRegex') : undefined}
                aria-label={t('logs.rules.pattern')}
                placeholder={t('logs.rules.pattern')}
                onChange={(e) => update(r.id, { pattern: e.target.value })}
                className="lg-rules__value"
              />
              <Checkbox checked={r.regex} onChange={(v) => update(r.id, { regex: v })} label={t('logs.rules.regex')} />
              <Checkbox checked={r.caseSensitive} onChange={(v) => update(r.id, { caseSensitive: v })} label="Aa" aria-label={t('logs.rules.caseSensitive')} />
              <ColorPicker value={r.color} onChange={(c) => update(r.id, { color: c })} />
              <IconButton icon={Trash2} label={t('logs.rules.remove')} size="sm" tone="danger" onClick={() => remove(r.id)} />
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

function ColorPicker({ value, onChange }: { value: HighlightColor; onChange(c: HighlightColor): void }) {
  return (
    <div className="lg-colors" role="radiogroup" aria-label={t('logs.rules.color')}>
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={t(`logs.rules.colors.${c}`)}
          title={t(`logs.rules.colors.${c}`)}
          className={clsx('lg-colors__swatch', `lg-colors__swatch--${c}`, value === c && 'is-on')}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

/* ───────────── saved filters ───────────── */

export function SavedFiltersDialog({
  open,
  onClose,
  saved,
  onChange,
  onApply,
}: {
  open: boolean;
  onClose(): void;
  saved: readonly SavedFilter[];
  onChange(next: SavedFilter[]): void;
  onApply(query: string): void;
}) {
  const list = useMemo(() => [...saved], [saved]);
  const update = (id: string, patch: Partial<SavedFilter>) => onChange(list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('logs.saved.title')}
      description={t('logs.saved.description')}
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      {list.length === 0 ? <p className="muted text-sm">{t('logs.saved.empty')}</p> : null}
      <div className="lg-rules" role="table" aria-label={t('logs.saved.title')}>
        {list.map((f) => (
          <div key={f.id} className="lg-rules__row lg-rules__row--saved" role="row">
            <Input size="sm" value={f.name} aria-label={t('logs.saved.nameLabel')} onChange={(e) => update(f.id, { name: e.target.value.slice(0, 60) })} />
            <Input size="sm" mono value={f.query} aria-label={t('logs.saved.queryLabel')} onChange={(e) => update(f.id, { query: e.target.value })} className="lg-rules__value" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onApply(f.query);
                onClose();
              }}
            >
              {t('logs.saved.apply')}
            </Button>
            <IconButton icon={Trash2} label={t('logs.saved.remove')} size="sm" tone="danger" onClick={() => onChange(list.filter((x) => x.id !== f.id))} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}
