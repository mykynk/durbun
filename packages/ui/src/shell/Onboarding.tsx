import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Apple, BookOpen, CircleCheck, CircleMinus, FlaskConical, MonitorSmartphone, Plug, ShieldCheck, Stethoscope, TriangleAlert } from 'lucide-react';
import '../sources/text';
import type { DriverStatus, ToolCheck } from '@durbun/protocol';
import { useT } from '../i18n';
import { driverStatusText } from '../i18n/codes';
import { ui, useDrivers } from '../data';
import { AndroidIcon, DurbunMark, type IconType } from '../components/Icons';
import { Button } from '../components/Button';
import { CopyButton } from '../components/CopyButton';
import { findCheck, useDoctor } from './useDoctor';
import { setDemo } from './actions';
import { checkDetail, checkFix } from './doctorText';

type ToolState = 'ok' | 'missing' | 'unknown';

function ToolStatus({ state, label, detail, check }: { state: ToolState; label: string; detail?: string; check?: ToolCheck }) {
  const Icon = state === 'ok' ? CircleCheck : state === 'missing' ? TriangleAlert : CircleMinus;
  const fix = state === 'missing' && check ? checkFix(check) : undefined;
  return (
    <div className={clsx('onb-tool', `onb-tool--${state}`)}>
      <div className="onb-tool__row">
        <Icon size={14} aria-hidden className="onb-tool__icon" />
        <span className="onb-tool__label">{label}</span>
      </div>
      {detail ? <div className="onb-tool__detail">{detail}</div> : null}
      {fix?.text ? <div className="onb-tool__detail">{fix.text}</div> : null}
      {fix?.command ? (
        <div className="doctor-fix doctor-fix--compact">
          <code className="doctor-fix__code selectable">{fix.command}</code>
          <CopyButton size="xs" value={fix.command} />
        </div>
      ) : null}
    </div>
  );
}

/** Tool state from its doctor check (preferred) or, until the checks arrive, from the driver status. */
function toolState(check: ToolCheck | undefined, driver?: DriverStatus): ToolState {
  if (check) return check.status === 'ok' || check.status === 'warn' ? 'ok' : 'missing';
  if (!driver) return 'unknown';
  return driver.available ? 'ok' : 'missing';
}

function OnbCard({
  icon: Icon,
  iconNode,
  title,
  children,
  footer,
  wide,
}: {
  icon?: IconType;
  iconNode?: ReactNode;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={clsx('onb-card', wide && 'onb-card--wide')} aria-label={title}>
      <header className="onb-card__header">
        <span className="onb-card__icon">{iconNode ?? (Icon ? <Icon size={18} aria-hidden /> : null)}</span>
        <h3 className="onb-card__title">{title}</h3>
      </header>
      <div className="onb-card__body">{children}</div>
      {footer ? <footer className="onb-card__footer">{footer}</footer> : null}
    </section>
  );
}

/** Empty state shown when no devices and no apps are known: how to connect (with this Mac's real tool status) + demo data. */
export function Onboarding() {
  const t = useT();
  const drivers = useDrivers();
  const { checks } = useDoctor({ maxAgeMs: 120_000 });
  const [starting, setStarting] = useState(false);
  const byId = (id: DriverStatus['id']) => drivers.find((d) => d.id === id);
  const adbCheck = findCheck(checks, 'adb');
  const syslogCheck = findCheck(checks, 'idevicesyslog');
  const usbmuxCheck = findCheck(checks, 'usbmuxd');
  const simctlCheck = findCheck(checks, 'simctl');
  const android = byId('android');
  const iosDevice = byId('ios-device');
  const iosSim = byId('ios-sim');
  const vm = byId('flutter-vm');

  const adbState = toolState(adbCheck, android);
  const syslogState = toolState(syslogCheck, iosDevice);
  const usbmuxState = usbmuxCheck ? toolState(usbmuxCheck) : 'ok';
  const simctlState = toolState(simctlCheck, iosSim);
  const statusOf = (d: DriverStatus | undefined) => (d?.detail || d?.code ? driverStatusText(d) : undefined);

  const startDemo = async () => {
    setStarting(true);
    await setDemo(true);
    setStarting(false);
  };

  return (
    <div className="onboarding">
      <div className="onboarding__inner">
        <div className="onboarding__hero">
          <DurbunMark tile size={52} />
          <h1 className="onboarding__title">{t('shell.onboarding.title')}</h1>
          <p className="onboarding__lead">{t('shell.onboarding.lead')}</p>
        </div>

        <div className="onboarding__grid">
          <OnbCard iconNode={<AndroidIcon size={18} />} title={t('shell.onboarding.android.title')}>
            <ol className="onb-steps">
              <li>{t('shell.onboarding.android.step1')}</li>
              <li>{t('shell.onboarding.android.step2')}</li>
              <li>{t('shell.onboarding.android.step3')}</li>
              <li>{t('shell.onboarding.android.step4')}</li>
            </ol>
            <ToolStatus
              state={adbState}
              label={adbState === 'ok' ? t('shell.onboarding.adbReady', { version: adbCheck?.version ?? '' }) : adbState === 'missing' ? t('shell.onboarding.adbMissing') : t('shell.onboarding.checking')}
              detail={adbState === 'ok' ? statusOf(android)?.replace(/^adb\b[^·]*·\s*/, '') : adbCheck ? checkDetail(adbCheck) : undefined}
              check={adbCheck}
            />
          </OnbCard>

          <OnbCard icon={Apple} title={t('shell.onboarding.ios.title')}>
            <ol className="onb-steps">
              <li>{t('shell.onboarding.ios.step1')}</li>
              <li>{t('shell.onboarding.ios.step2')}</li>
              <li>{t('shell.onboarding.ios.step3')}</li>
            </ol>
            {usbmuxState === 'missing' ? (
              <ToolStatus state="missing" label={t('shell.onboarding.usbmuxMissing')} detail={usbmuxCheck ? checkDetail(usbmuxCheck) : undefined} check={usbmuxCheck} />
            ) : null}
            <ToolStatus
              state={syslogState}
              label={syslogState === 'ok' ? t('shell.onboarding.syslogReady') : syslogState === 'missing' ? t('shell.onboarding.syslogMissing') : t('shell.onboarding.checking')}
              detail={syslogState === 'ok' ? statusOf(iosDevice) : undefined}
              check={syslogCheck}
            />
          </OnbCard>

          <OnbCard icon={MonitorSmartphone} title={t('shell.onboarding.sim.title')}>
            <p className="onb-p">{t('shell.onboarding.sim.body')}</p>
            <ToolStatus
              state={simctlState}
              label={
                simctlState === 'ok'
                  ? t('shell.onboarding.simctlReady', { version: simctlCheck?.version ?? '' })
                  : simctlState === 'missing'
                    ? t('shell.onboarding.simctlMissing')
                    : t('shell.onboarding.checking')
              }
              detail={simctlState === 'ok' ? statusOf(iosSim) : simctlCheck ? checkDetail(simctlCheck) : undefined}
              check={simctlCheck}
            />
            <ToolStatus state={adbState} label={t('shell.onboarding.emulatorNote')} />
          </OnbCard>

          <OnbCard icon={Plug} wide title={t('shell.onboarding.flutter.title')}>
            <p className="onb-p">{t('shell.onboarding.flutter.body')}</p>
            <ToolStatus state={vm ? (vm.available ? 'ok' : 'missing') : 'unknown'} label={t('shell.onboarding.flutter.status')} detail={statusOf(vm)} />
          </OnbCard>

          <OnbCard
            icon={FlaskConical}
            wide
            title={t('shell.onboarding.demo.title')}
            footer={
              <Button variant="primary" icon={starting ? undefined : FlaskConical} loading={starting} onClick={() => void startDemo()} fullWidth>
                {t('shell.onboarding.demo.button')}
              </Button>
            }
          >
            <p className="onb-p">{t('shell.onboarding.demo.body')}</p>
          </OnbCard>
        </div>

        <div className="onboarding__links">
          <Button variant="ghost" icon={BookOpen} onClick={() => ui.openSdkGuide()}>
            {t('shell.sdk.title')}
          </Button>
          <Button variant="ghost" icon={ShieldCheck} onClick={ui.openDataSources}>
            {t('sources.general')}
          </Button>
          <Button variant="ghost" icon={Stethoscope} onClick={ui.openDoctor}>
            {t('shell.doctor.title')}
          </Button>
        </div>
        <p className="onboarding__foot subtle">{t('shell.onboarding.sdkNote')}</p>
      </div>
    </div>
  );
}
