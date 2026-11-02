import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Activity, Cpu } from 'lucide-react';
import type { AppSession, DeviceInfo } from '@durbun/protocol';
import { useHub } from '../../data';
import { Button, Checkbox, SearchInput } from '../../components';
import { useT } from '../../i18n';
import { showInPerf } from '../perf/request';
import { processRows } from './model';
import { DeviceCard } from './useAction';

const MAX_ROWS = 120;

/** Known processes of the device (pid → name) with a shortcut to poll one in the Performance tab. */
export function ProcessesCard({ device, sessions, canWatch }: { device: DeviceInfo; sessions: readonly AppSession[]; canWatch: boolean }) {
  const t = useT();
  const byPid = useHub((s) => s.processes[device.id]);
  const [query, setQuery] = useState('');
  const [showDied, setShowDied] = useState(false);
  const { rows, total, died } = useMemo(() => processRows(byPid, sessions, query, showDied), [byPid, sessions, query, showDied]);
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <DeviceCard
      section="processes"
      title={t('device.proc.title')}
      icon={Cpu}
      description={total > 0 ? t('device.proc.count', { shown: rows.length, total }) : undefined}
      actions={died > 0 ? <Checkbox checked={showDied} onChange={setShowDied} label={t('device.proc.showDied')} /> : undefined}
    >
      {total === 0 ? (
        <p className="dv-muted">{t('device.proc.empty')}</p>
      ) : (
        <>
          <SearchInput size="sm" value={query} onChange={setQuery} placeholder={t('device.proc.search')} className="dv-apps__search" />
          {rows.length === 0 ? (
            <p className="dv-muted">{t('device.proc.noMatch')}</p>
          ) : (
            <ul className="dv-procs" aria-label={t('device.proc.list')}>
              {shown.map((p) => (
                <li key={p.pid} className={clsx('dv-proc', p.event === 'died' && 'is-died')}>
                  <span className="dv-proc__pid mono tnum">{p.pid}</span>
                  <span className="dv-proc__name mono truncate" title={p.name}>
                    {p.name}
                  </span>
                  {p.appName ? <span className="dv-badge dv-badge--live">{p.appName}</span> : null}
                  {p.event === 'died' ? <span className="dv-badge dv-badge--muted">{t('device.proc.died')}</span> : null}
                  {canWatch && p.event !== 'died' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Activity}
                      aria-label={t('device.proc.watchLabel', { name: p.name, pid: p.pid })}
                      className="dv-proc__watch"
                      onClick={() => showInPerf({ kind: 'process', deviceId: device.id, pid: p.pid, name: p.name }, { poll: true })}
                    >
                      {t('device.proc.watch')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {rows.length > shown.length ? <p className="dv-hint">{t('device.proc.more', { count: rows.length - shown.length })}</p> : null}
          {canWatch ? <p className="dv-hint">{t('device.proc.hint')}</p> : null}
        </>
      )}
    </DeviceCard>
  );
}
