/** Building blocks of the settings sections (shared with sections that live in features, like Backup). */
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useT } from '../i18n';
import { isConnected, ui, useConnection } from '../data';
import { Button } from '../components/Button';
import { Callout } from '../components/Layout';
import { formatNumber } from '../lib/format';

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
