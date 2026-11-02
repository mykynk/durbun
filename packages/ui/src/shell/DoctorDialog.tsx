import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, CircleMinus, ExternalLink, RefreshCw, Stethoscope, TriangleAlert } from 'lucide-react';
import type { DriverStatus, ToolCheck } from '@durbun/protocol';
import { useT } from '../i18n';
import { driverStatusText } from '../i18n/codes';
import { ui, useDrivers, useUi } from '../data';
import { Dialog } from '../components/Dialog';
import { Button } from '../components/Button';
import { Callout, EmptyState } from '../components/Layout';
import { CopyButton } from '../components/CopyButton';
import { Spinner } from '../components/Spinner';
import { StatusDot } from '../components/Badges';
import { formatRelative } from '../lib/format';
import { useDoctor } from './useDoctor';
import { checkDetail, checkFix, checkLabel, isCommand } from './doctorText';

export { isCommand };

const STATUS_ICON = { ok: CircleCheck, warn: TriangleAlert, missing: CircleMinus, error: CircleAlert } as const;

type CheckGroup = 'durbun' | 'android' | 'ios' | 'flutter' | 'other';
const GROUP_ORDER: CheckGroup[] = ['durbun', 'android', 'ios', 'flutter', 'other'];

/** Which section a check belongs to (ids are server-defined, see doctorText.ts). */
export function checkGroup(id: string): CheckGroup {
  if (['node', 'data-dir', 'ui-build', 'port-http', 'port-sdk'].includes(id)) return 'durbun';
  if (id === 'adb' || id.startsWith('driver-android')) return 'android';
  if (['simctl', 'usbmuxd', 'idevicesyslog', 'devicectl', 'idevicescreenshot', 'xcrun'].includes(id) || id.startsWith('driver-ios')) return 'ios';
  if (id.startsWith('flutter')) return 'flutter';
  return 'other';
}

function CheckRow({ check }: { check: ToolCheck }) {
  const t = useT();
  const Icon = STATUS_ICON[check.status] ?? CircleAlert;
  const detail = checkDetail(check);
  const fix = check.status !== 'ok' ? checkFix(check) : undefined;
  return (
    <li className={clsx('doctor-check', `doctor-check--${check.status}`)}>
      <Icon size={17} className="doctor-check__icon" aria-label={t(`shell.doctor.status.${check.status}`)} />
      <div className="doctor-check__body">
        <div className="doctor-check__head">
          <span className="doctor-check__label">{checkLabel(check)}</span>
          {check.version ? <span className="doctor-check__version mono">{check.version}</span> : null}
          <span className={clsx('doctor-check__status', `doctor-check__status--${check.status}`)}>{t(`shell.doctor.status.${check.status}`)}</span>
        </div>
        {check.path && !(detail ?? '').includes(check.path) ? <div className="doctor-check__path mono selectable">{check.path}</div> : null}
        {detail ? (
          <div className="doctor-check__detail selectable" title={detail !== check.detail ? check.detail : undefined}>
            {detail}
          </div>
        ) : null}
        {fix?.text ? <div className="doctor-check__hint">{fix.text}</div> : null}
        {fix?.command ? (
          <div className="doctor-fix">
            <code className="doctor-fix__code selectable">{fix.command}</code>
            <CopyButton size="sm" value={fix.command} label={t('shell.doctor.copyFix')} toastOnCopy={t('shell.doctor.fixCopied')} />
          </div>
        ) : null}
        {check.docsUrl ? (
          <a className="doctor-check__docs" href={check.docsUrl} target="_blank" rel="noreferrer noopener">
            {t('shell.doctor.docs')} <ExternalLink size={11} aria-hidden />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function DriverRow({ d }: { d: DriverStatus }) {
  const t = useT();
  const tone = d.active ? 'success' : d.available ? 'info' : 'warn';
  const state = d.active ? t('shell.doctor.driver.active') : d.available ? t('shell.doctor.driver.available') : t('shell.doctor.driver.unavailable');
  const text = d.detail || d.code ? driverStatusText(d) : '';
  return (
    <li className="doctor-driver">
      <StatusDot tone={tone} size={7} />
      <span className="doctor-driver__name">{t(`shell.doctor.drivers.${d.id}`)}</span>
      <span className="doctor-driver__state">{state}</span>
      {text ? (
        <span className="doctor-driver__detail truncate" title={d.detail && d.detail !== text ? `${text} — ${d.detail}` : text}>
          {text}
        </span>
      ) : null}
    </li>
  );
}

/** "Sistem kontrolü": GET /api/doctor results with status icons and copyable fixes, plus driver states. */
export function DoctorDialog() {
  const open = useUi((s) => s.doctor);
  if (!open) return null;
  return <DoctorContent />;
}

function DoctorContent() {
  const t = useT();
  const { checks, loading, error, fetchedAt, refresh } = useDoctor({ maxAgeMs: 5_000 });
  const drivers = useDrivers();
  const counts = { ok: 0, warn: 0, missing: 0, error: 0 };
  for (const c of checks ?? []) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const problems = counts.warn + counts.missing + counts.error;
  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    checks: (checks ?? []).filter((c) => checkGroup(c.id) === g).sort((a, b) => order(a.status) - order(b.status)),
  })).filter((g) => g.checks.length > 0);

  return (
    <Dialog
      open
      onClose={ui.closeDoctor}
      title={t('shell.doctor.title')}
      description={t('shell.doctor.description')}
      icon={Stethoscope}
      size="lg"
      footer={
        <>
          {fetchedAt ? <span className="muted text-sm grow">{t('shell.doctor.checkedAt', { when: formatRelative(fetchedAt) })}</span> : <span className="grow" />}
          <Button icon={RefreshCw} loading={loading} onClick={() => void refresh()}>
            {t('shell.doctor.rerun')}
          </Button>
          <Button variant="primary" onClick={ui.closeDoctor}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      {error && !checks ? (
        <EmptyState
          icon={CircleAlert}
          tone="danger"
          size="sm"
          title={t('shell.doctor.failed')}
          description={error}
          actions={
            <Button icon={RefreshCw} onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !checks ? (
        <div className="doctor-loading">
          <Spinner size={18} />
          <span className="muted">{t('shell.doctor.running')}</span>
        </div>
      ) : (
        <div className="doctor">
          {problems === 0 ? (
            <Callout tone="success" title={t('shell.doctor.allGood')}>
              {t('shell.doctor.allGoodHint')}
            </Callout>
          ) : (
            <Callout tone="warn" title={t('shell.doctor.problems', { count: problems })}>
              {t('shell.doctor.problemsHint')}
            </Callout>
          )}
          <div className="doctor-summary">
            {(['ok', 'warn', 'missing', 'error'] as const).map((s) =>
              counts[s] > 0 ? (
                <span key={s} className={clsx('doctor-summary__item', `doctor-summary__item--${s}`)}>
                  <span className="tnum">{counts[s]}</span> {t(`shell.doctor.status.${s}`)}
                </span>
              ) : null,
            )}
          </div>
          {groups.map((g) => (
            <section key={g.group} className="doctor-group" aria-label={t(`shell.doctor.groups.${g.group}`)}>
              <h3 className="doctor-section-title">{t(`shell.doctor.groups.${g.group}`)}</h3>
              <ul className="doctor-checks">
                {g.checks.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
            </section>
          ))}
          {drivers.length > 0 ? (
            <section className="doctor-group" aria-label={t('shell.doctor.driversTitle')}>
              <h3 className="doctor-section-title">{t('shell.doctor.driversTitle')}</h3>
              <ul className="doctor-drivers">
                {drivers.map((d) => (
                  <DriverRow key={d.id} d={d} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function order(s: ToolCheck['status']): number {
  return s === 'error' ? 0 : s === 'missing' ? 1 : s === 'warn' ? 2 : 3;
}
