import type { ReactNode } from 'react';
import { BookOpen, FunnelX, ScrollText, Stethoscope, Volume2, X } from 'lucide-react';
import { Button, EmptyState } from '../../../components';
import { ui, type Scope } from '../../../data';
import { logStatusText, t } from '../../../i18n';
import type { DeviceInfo } from '@durbun/protocol';

export function NoLogsState({ scope, device, children }: { scope: Scope; device?: DeviceInfo; children?: ReactNode }) {
  const status = device && device.logs.status !== 'streaming' ? logStatusText(device) : null;
  return (
    <EmptyState
      icon={ScrollText}
      size="lg"
      title={scope.kind === 'all' ? t('logs.empty.noLogsAllTitle') : t('logs.empty.noLogsTitle')}
      description={
        <>
          <p>{t('logs.empty.noLogsText')}</p>
          {status ? <p className="lg-empty__status">{t('logs.empty.deviceStatus', { status })}</p> : null}
        </>
      }
      actions={
        <>
          <Button variant="primary" icon={BookOpen} onClick={() => ui.openSdkGuide()}>
            {t('logs.empty.sdkGuide')}
          </Button>
          <Button icon={Stethoscope} onClick={() => ui.openDoctor()}>
            {t('logs.empty.doctor')}
          </Button>
        </>
      }
    >
      {children}
    </EmptyState>
  );
}

export interface ActiveFilter {
  id: string;
  label: string;
  /** Technical text (the query) → monospace. */
  mono?: boolean;
  clear(): void;
}

export function NoMatchState({
  inScope,
  filters,
  onClearAll,
  noiseHidden,
  onShowNoise,
  children,
}: {
  inScope: number;
  filters: readonly ActiveFilter[];
  onClearAll(): void;
  noiseHidden: boolean;
  onShowNoise(): void;
  /** Extra explanation under the filter chips (e.g. crash records that cannot be read). */
  children?: ReactNode;
}) {
  return (
    <EmptyState
      icon={FunnelX}
      title={t('logs.empty.noMatchTitle')}
      description={inScope > 0 ? t('logs.empty.noMatchText', { count: inScope }) : undefined}
      actions={
        <>
          <Button variant="primary" icon={FunnelX} onClick={onClearAll}>
            {t('logs.empty.clearFilters')}
          </Button>
          {noiseHidden ? (
            <Button icon={Volume2} onClick={onShowNoise}>
              {t('logs.empty.showNoise')}
            </Button>
          ) : null}
        </>
      }
    >
      {filters.length ? (
        <div className="lg-empty__filters" role="group" aria-label={t('logs.empty.activeFilters')}>
          {filters.map((f) => (
            <span key={f.id} className="lg-chip lg-chip--saved is-on">
              <span className={f.mono ? 'lg-chip__main mono' : 'lg-chip__main'}>{f.label}</span>
              <button type="button" className="lg-chip__x" aria-label={`${t('common.remove')}: ${f.label}`} onClick={f.clear}>
                <X size={10} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {children}
    </EmptyState>
  );
}
