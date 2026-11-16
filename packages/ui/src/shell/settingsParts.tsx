/** Building blocks of the settings sections (shared with sections that live in features, like Backup). */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { ServerSettings } from '@durbun/protocol';
import { useT } from '../i18n';
import { isConnected, ui, updateServerSettings, useConnection } from '../data';
import { Button } from '../components/Button';
import { Input } from '../components/Form';
import { Callout } from '../components/Layout';
import { toast } from '../components/Toast';
import { formatNumber } from '../lib/format';
import { errorMessage } from './actions';

export function SectionHeader({ title, description, onClose }: { title: string; description?: string; onClose?: boolean }) {
  const t = useT();
  return (
    <header className="settings__header">
      <div>
        <h2 className="settings__title">{title}</h2>
        {description ? <p className="settings__desc">{description}</p> : null}
      </div>
      {onClose !== false ? (
        <Button variant="ghost" size="sm" onClick={ui.closeSettings}>
          {t('common.done')}
        </Button>
      ) : null}
    </header>
  );
}

export function Row({ label, hint, children, saved, range }: { label: ReactNode; hint?: ReactNode; children: ReactNode; saved?: boolean; range?: [min: number, max: number, unit?: string] }) {
  const t = useT();
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <div className="setting-row__label">
          {label}
          {saved ? (
            <span className="setting-row__saved" role="status" aria-label={t('code.settings.saved')}>
              <Check size={12} aria-hidden />
            </span>
          ) : null}
        </div>
        {hint || range ? (
          <div className="setting-row__hint">
            {hint}
            {range ? (
              <span className="setting-row__range tnum">
                {hint ? ' · ' : null}
                {t('shell.settings.range', { min: formatNumber(range[0]), max: `${formatNumber(range[1])}${range[2] ? ` ${range[2]}` : ''}` })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings__group">
      {title ? <h3 className="settings__group-title">{title}</h3> : null}
      <div className="settings__group-body">{children}</div>
    </section>
  );
}

export function OfflineNote() {
  const t = useT();
  const status = useConnection((s) => s.status);
  if (isConnected(status)) return null;
  return (
    <Callout tone="warn" compact>
      {t('shell.settings.offline')}
    </Callout>
  );
}

/** Save one server setting; `savedKey` marks the row that just saved (a check for 1.6 s). */
export function useServerPatch() {
  const t = useT();
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const save = async (key: keyof ServerSettings, patch: Partial<ServerSettings>) => {
    try {
      await updateServerSettings(patch);
      setSavedKey(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSavedKey(null), 1600);
    } catch (err) {
      toast.error(t('shell.settings.saveFailed'), { description: errorMessage(err) });
    }
  };
  return { save, savedKey };
}

/** A number input that commits on blur / Enter within [min, max] (Escape restores). */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  unit,
  scale = 1,
  step = 1,
  disabled,
  label,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  unit?: string;
  /** Displayed value = stored / scale. */
  scale?: number;
  step?: number;
  disabled?: boolean;
  label: string;
}) {
  const t = useT();
  const shown = Math.round((value / scale) * 100) / 100;
  const [draft, setDraft] = useState(String(shown));
  useEffect(() => setDraft(String(shown)), [shown]);
  const parsed = Number(draft.replace(',', '.'));
  const invalid = draft.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max;
  const commit = () => {
    if (invalid) {
      setDraft(String(shown));
      return;
    }
    if (parsed !== shown) onCommit(Math.round(parsed * scale));
  };
  return (
    <Input
      size="sm"
      className="setting-number tnum"
      inputMode="decimal"
      value={draft}
      step={step}
      disabled={disabled}
      invalid={invalid}
      aria-label={label}
      title={invalid ? t('shell.settings.range', { min: formatNumber(min), max: formatNumber(max) }) : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(String(shown));
          e.stopPropagation();
        }
      }}
      trailing={unit ? <span className="input-unit">{unit}</span> : undefined}
    />
  );
}
