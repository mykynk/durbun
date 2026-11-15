import { useEffect, useMemo, useState } from 'react';
import { Code2, FileArchive, KeyRound, Languages, RotateCw, Settings2, ShieldCheck, Square, Wifi } from 'lucide-react';
import type { AppSession, DeviceActionId, DeviceInfo } from '@durbun/protocol';
import { Button, Input, Select, Spinner, confirm, formatBytes, formatDuration } from '../../components';
import { actionAvailability, anyActionShown, type ActionAvailability } from '../../data/explain';
import { useLanguage, useT } from '../../i18n';
import { useAppRows } from './AppsCard';
import { ChoiceButtons } from './AppearanceCard';
import { codeText } from './codes';
import { ANDROID_PERMISSIONS, APP_LOCALES, ROTATIONS, SIM_PRIVACY_SERVICES, overrideOf, recordClock, shortPermission } from './model';
import { overrideValueText, permissionLabel } from './OverridesCard';
import { cancelDeviceReport, takeDeviceReport, useDeviceReports, useSelectedUser } from './stores';
import { ActionErrorCallout, DeviceCard, useDeviceAction, useStickyDefault } from './useAction';

/* Actions grouped by what a tester wants to do; a card shows when one of its actions runs or is blocked for a reason. */
export const APP_ACCESS_ACTIONS: readonly DeviceActionId[] = ['app-permission', 'app-locale', 'app-settings', 'keychain-reset'];
export const CONNECTION_ACTIONS: readonly DeviceActionId[] = ['airplane-mode', 'wifi', 'mobile-data'];
export const SCREEN_ACTIONS: readonly DeviceActionId[] = ['rotation'];
export const DEV_OPTION_ACTIONS: readonly DeviceActionId[] = ['dont-keep-activities'];
export const REPORT_ACTIONS: readonly DeviceActionId[] = ['bug-report'];
/** Actions these cards explain themselves when blocked: the "unavailable actions" card leaves them out. */
export const TESTER_ACTIONS: ReadonlySet<DeviceActionId> = new Set([...APP_ACCESS_ACTIONS, ...CONNECTION_ACTIONS, ...SCREEN_ACTIONS, ...DEV_OPTION_ACTIONS, ...REPORT_ACTIONS, 'bug-report-cancel']);

export const showsCard = (device: DeviceInfo, actions: readonly DeviceActionId[]) => anyActionShown(device, actions);

/** The reason an action cannot run now, said where the control would be. */
function Blocked({ availability, short }: { availability: Extract<ActionAvailability, { state: 'blocked' }>; short?: boolean }) {
  const t = useT();
  if (short) return <span className="dv-hint dv-blocked">{t('device.tester.blockedShort')}</span>;
  return <span className="dv-hint dv-blocked">{t('device.tester.reason', { reason: codeText(availability.code, availability.params) ?? availability.code })}</span>;
}

const reasonKey = (a: Extract<ActionAvailability, { state: 'blocked' }>) => `${a.code}|${JSON.stringify(a.params ?? {})}`;

/** A reason two or more rows of a card share: said once under the rows instead of on each. */
function sharedReason(device: DeviceInfo, actions: readonly DeviceActionId[]): Extract<ActionAvailability, { state: 'blocked' }> | undefined {
  const seen = new Map<string, { a: Extract<ActionAvailability, { state: 'blocked' }>; n: number }>();
  for (const action of actions) {
    const a = actionAvailability(device, action);
    if (a.state !== 'blocked') continue;
    const k = reasonKey(a);
    const e = seen.get(k);
    seen.set(k, { a, n: (e?.n ?? 0) + 1 });
  }
  for (const { a, n } of seen.values()) if (n > 1) return a;
  return undefined;
}

type Run = ReturnType<typeof useDeviceAction>['run'];

/** One setting with fixed values (on / off, an orientation): the value Dürbün set last is marked, the one before is said. */
function SettingRow<V extends string>({
  device,
  action,
  label,
  hint,
  options,
  current,
  params,
  run,
  isPending,
  done,
  failed,
  shared,
}: {
  device: DeviceInfo;
  action: DeviceActionId;
  label: string;
  hint?: string;
  options: { value: V; label: string }[];
  /** The device value Dürbün set, mapped to an option (null = Dürbün did not change it). */
  current: (raw: string) => V | null;
  params: (v: V) => Record<string, unknown>;
  run: Run;
  isPending: (key: string) => boolean;
  done: (v: V) => string;
  failed: string;
  /** The card says this reason once below its rows. */
  shared?: Extract<ActionAvailability, { state: 'blocked' }>;
}) {
  const t = useT();
  const a = actionAvailability(device, action);
  if (a.state === 'no') return null;
  const o = overrideOf(device, action);
  const last = o ? current(o.current) : null;
  return (
    <div className="dv-setting">
      <div className="dv-row dv-row--field dv-row--wrap">
        <span className="dv-label">{label}</span>
        {a.state === 'blocked' ? (
          <Blocked availability={a} short={!!shared && reasonKey(shared) === reasonKey(a)} />
        ) : (
          <ChoiceButtons
            label={label}
            options={options}
            last={last}
            pendingKey={(v) => `${action}-${v}`}
            isPending={isPending}
            onPick={(v) => void run({ key: `${action}-${v}`, action, params: params(v), success: done(v), failure: failed })}
          />
        )}
      </div>
      {hint || o ? (
        <span className="dv-hint dv-setting__hint">
          {[hint, o ? t('device.overrides.before', { value: overrideValueText(o, o.previous, t) }) : ''].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

const onOff = (raw: string): 'on' | 'off' | null => (raw === 'on' || raw === '1' ? 'on' : raw === 'off' || raw === '0' ? 'off' : null);

/** Airplane mode, Wi-Fi, mobile data (Android). */
export function ConnectionCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const options = [
    { value: 'on' as const, label: t('device.tester.on') },
    { value: 'off' as const, label: t('device.tester.off') },
  ];
  const shared = sharedReason(device, CONNECTION_ACTIONS);
  return (
    <DeviceCard section="connection" title={t('device.tester.connection.title')} icon={Wifi} description={t('device.tester.connection.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {CONNECTION_ACTIONS.map((action) => {
        const name = t(`device.actionName.${action}`);
        return (
          <SettingRow
            key={action}
            device={device}
            action={action}
            label={name}
            options={options}
            current={onOff}
            params={(v) => ({ enabled: v === 'on' })}
            run={run}
            isPending={isPending}
            done={(v) => t('device.tester.connection.done', { name, value: t(v === 'on' ? 'device.tester.valueOn' : 'device.tester.valueOff') })}
            failed={t('device.tester.connection.failed', { name })}
            shared={shared}
          />
        );
      })}
      {shared ? <p className="dv-hint dv-blocked-note">{codeText(shared.code, shared.params) ?? shared.code}</p> : null}
    </DeviceCard>
  );
}

/** Screen orientation (Android). */
export function ScreenCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const options = ROTATIONS.map((r) => ({ value: r, label: t(`device.tester.screen.${r}`) }));
  return (
    <DeviceCard section="screen" title={t('device.tester.screen.title')} icon={RotateCw} description={t('device.tester.screen.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <SettingRow
        device={device}
        action="rotation"
        label={t('device.actionName.rotation')}
        options={options}
        current={(raw) => ((ROTATIONS as readonly string[]).includes(raw) ? (raw as (typeof ROTATIONS)[number]) : null)}
        params={(v) => ({ orientation: v })}
        run={run}
        isPending={isPending}
        done={(v) => t('device.tester.screen.done', { value: t(`device.tester.screen.${v}`) })}
        failed={t('device.tester.screen.failed')}
      />
    </DeviceCard>
  );
}

/** "Don't keep activities" (Android developer options). */
export function DevOptionsCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const name = t('device.tester.dev.dontKeep');
  return (
    <DeviceCard section="dev-options" title={t('device.tester.dev.title')} icon={Code2} description={t('device.tester.dev.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <SettingRow
        device={device}
        action="dont-keep-activities"
        label={name}
        hint={t('device.tester.dev.dontKeepHint')}
        options={[
          { value: 'on' as const, label: t('device.tester.on') },
          { value: 'off' as const, label: t('device.tester.off') },
        ]}
        current={onOff}
        params={(v) => ({ enabled: v === 'on' })}
        run={run}
        isPending={isPending}
        done={(v) => t('device.tester.dev.done', { name, value: t(v === 'on' ? 'device.tester.valueOn' : 'device.tester.valueOff') })}
        failed={t('device.tester.dev.failed', { name })}
      />
    </DeviceCard>
  );
}

const CUSTOM = '__custom__';

function localeName(tag: string, lang: string): string {
  try {
    const name = new Intl.DisplayNames([lang], { type: 'language' }).of(tag);
    return name && name !== tag ? `${name} · ${tag}` : tag;
  } catch {
    return tag;
  }
}

/**
 * The selected app's permissions (grant / deny / put back; on simulators "ask again"), its own language, its page in
 * the system settings and, on simulators, the keychain. App actions run for the Android user picked in the Apps card.
 */
export function AppAccessCard({ device, sessions, preferredAppId }: { device: DeviceInfo; sessions: readonly AppSession[]; preferredAppId?: string }) {
  const t = useT();
  const lang = useLanguage();
  const { run, isPending, busy, error, clearError } = useDeviceAction(device.id);
  const userId = useSelectedUser(device);
  const rows = useAppRows(device, sessions);
  const apps = useMemo(() => rows.filter((r) => !r.system), [rows]);
  const [picked, setPicked] = useState<string | null>(null);
  const offered = (id: string) => apps.some((a) => a.id === id);
  // The app shown without a pick: the one in scope, else the first SDK app, kept when the list re-sorts.
  const firstApp = useStickyDefault(apps.find((a) => a.sdk)?.id ?? apps[0]?.id, offered);
  const appId = picked && offered(picked) ? picked : preferredAppId && offered(preferredAppId) ? preferredAppId : firstApp;
  const app = apps.find((a) => a.id === appId);
  const sim = device.platform === 'ios';
  const [perm, setPerm] = useState<string>(sim ? 'location' : ANDROID_PERMISSIONS[0]!.id);
  const [custom, setCustom] = useState('');
  const [locale, setLocale] = useState<string>('tr-TR');

  const permAvail = actionAvailability(device, 'app-permission');
  const localeAvail = actionAvailability(device, 'app-locale');
  const settingsAvail = actionAvailability(device, 'app-settings');
  const keychainAvail = actionAvailability(device, 'keychain-reset');
  const user = userId === undefined ? {} : { userId };

  const permission = perm === CUSTOM ? custom.trim() : perm;
  const permLabel = (id: string) => (sim ? t(`device.tester.app.service.${id}`) : permissionLabel(id, t));
  const permOverride = appId && !sim ? overrideOf(device, 'app-permission', { appId, key: permission }) : undefined;
  const permState = permOverride?.current === 'granted' ? 'grant' : permOverride?.current === 'revoked' ? 'revoke' : null;
  const localeOverride = appId ? overrideOf(device, 'app-locale', { appId }) : undefined;

  useEffect(() => {
    if (localeOverride) setLocale(localeOverride.current);
  }, [localeOverride?.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const changePermission = (kind: 'grant' | 'revoke' | 'restore') => {
    if (!appId || !permission) return;
    const name = permLabel(permission);
    const appName = app?.name ?? appId;
    const params = kind === 'restore' ? { appId, permission, restore: true, ...user } : { appId, permission, grant: kind === 'grant', ...user };
    void run({
      key: `perm-${kind}`,
      action: 'app-permission',
      params,
      success: t(kind === 'grant' ? 'device.tester.app.granted' : kind === 'revoke' ? 'device.tester.app.revoked' : sim ? 'device.tester.app.askAgain' : 'device.tester.app.restored', { permission: name, app: appName }),
      failure: t('device.tester.app.failed'),
    });
  };

  const permOptions = sim
    ? SIM_PRIVACY_SERVICES.map((s) => ({ value: s, label: t(`device.tester.app.service.${s}`) }))
    : [...ANDROID_PERMISSIONS.map((p) => ({ value: p.id, label: `${t(`device.tester.app.perm.${p.key}`)} · ${shortPermission(p.id)}` })), { value: CUSTOM, label: t('device.tester.app.custom') }];

  return (
    <DeviceCard
      section="app-access"
      title={t(actionAvailability(device, 'app-locale').state === 'no' ? 'device.tester.app.titlePermissions' : 'device.tester.app.title')}
      icon={ShieldCheck}
      description={t(actionAvailability(device, 'app-locale').state === 'no' ? 'device.tester.app.hintPermissions' : 'device.tester.app.hint')}
    >
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {permAvail.state !== 'no' || localeAvail.state !== 'no' || settingsAvail.state !== 'no' ? (
        apps.length === 0 ? (
          <p className="dv-muted">{t('device.tester.app.noApps')}</p>
        ) : (
          <div className="dv-row dv-row--field">
            <span className="dv-label">{t('device.tester.app.app')}</span>
            <Select size="sm" value={appId ?? ''} onChange={(e) => setPicked(e.target.value)} options={apps.map((a) => ({ value: a.id, label: `${a.name} · ${a.id}` }))} aria-label={t('device.tester.app.app')} className="dv-grow" />
          </div>
        )
      ) : null}

      {permAvail.state !== 'no' && apps.length > 0 ? (
        <div className="dv-setting">
          <div className="dv-row dv-row--field dv-row--wrap">
            <span className="dv-label">{t('device.tester.app.permission')}</span>
            {permAvail.state === 'blocked' ? (
              <Blocked availability={permAvail} />
            ) : (
              <Select size="sm" value={perm} onChange={(e) => setPerm(e.target.value)} options={permOptions} aria-label={t('device.tester.app.permission')} className="dv-grow" />
            )}
          </div>
          {permAvail.state === 'yes' && perm === CUSTOM ? (
            <div className="dv-row dv-row--field">
              <span className="dv-label">{t('device.tester.app.customLabel')}</span>
              <Input size="sm" mono value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t('device.tester.app.customPlaceholder')} aria-label={t('device.tester.app.customLabel')} className="dv-grow" />
            </div>
          ) : null}
          {permAvail.state === 'yes' ? (
            <div className="dv-row dv-row--field dv-row--wrap">
              <span className="dv-label" aria-hidden />
              <ChoiceButtons
                label={t('device.tester.app.permission')}
                options={[
                  { value: 'grant' as const, label: t('device.tester.app.grant') },
                  { value: 'revoke' as const, label: t('device.tester.app.revoke') },
                ]}
                last={permState}
                pendingKey={(v) => `perm-${v}`}
                isPending={isPending}
                onPick={(v) => changePermission(v)}
              />
              {sim || permOverride ? (
                <Button size="sm" variant="ghost" loading={isPending('perm-restore')} disabled={!permission || (busy && !isPending('perm-restore'))} title={sim ? t('device.tester.app.resetIosHint') : undefined} onClick={() => changePermission('restore')}>
                  {sim ? t('device.tester.app.resetIos') : t('device.tester.app.restore')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {permOverride ? <span className="dv-hint dv-setting__hint">{t('device.overrides.before', { value: overrideValueText(permOverride, permOverride.previous, t) })}</span> : null}
        </div>
      ) : null}

      {localeAvail.state !== 'no' && apps.length > 0 ? (
        <div className="dv-setting">
          <div className="dv-row dv-row--field dv-row--wrap">
            <span className="dv-label">{t('device.tester.app.locale')}</span>
            {localeAvail.state === 'blocked' ? (
              <Blocked availability={localeAvail} />
            ) : (
              <>
                <Select
                  size="sm"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  options={APP_LOCALES.map((l) => ({ value: l, label: l === 'system' ? t('device.tester.app.localeSystem') : localeName(l, lang) }))}
                  aria-label={t('device.tester.app.locale')}
                  className="dv-grow"
                />
                <Button
                  size="sm"
                  icon={Languages}
                  loading={isPending('locale')}
                  disabled={!appId || (busy && !isPending('locale'))}
                  onClick={() =>
                    appId &&
                    void run({
                      key: 'locale',
                      action: 'app-locale',
                      params: { appId, locale, ...user },
                      success: locale === 'system' ? t('device.tester.app.localeSystemDone', { app: app?.name ?? appId }) : t('device.tester.app.localeDone', { app: app?.name ?? appId, locale: localeName(locale, lang) }),
                      failure: t('device.tester.app.localeFailed'),
                    })
                  }
                >
                  {t('device.tester.app.localeApply')}
                </Button>
              </>
            )}
          </div>
          <span className="dv-hint dv-setting__hint">
            {[t('device.tester.app.localeHint'), localeOverride ? t('device.overrides.before', { value: overrideValueText(localeOverride, localeOverride.previous, t) }) : ''].filter(Boolean).join(' · ')}
          </span>
        </div>
      ) : null}

      {settingsAvail.state !== 'no' && apps.length > 0 ? (
        <div className="dv-action-row">
          <div className="dv-action-row__text">
            <span className="dv-action-row__title">{t('device.actionName.app-settings')}</span>
            {settingsAvail.state === 'blocked' ? <Blocked availability={settingsAvail} /> : <span className="dv-hint">{t('device.tester.app.settingsHint')}</span>}
          </div>
          {settingsAvail.state === 'yes' ? (
            <Button
              size="sm"
              icon={Settings2}
              loading={isPending('settings')}
              disabled={!appId}
              onClick={() =>
                appId &&
                void run({ key: 'settings', action: 'app-settings', params: { appId, ...user }, success: t('device.tester.app.settingsDone', { app: app?.name ?? appId }), failure: t('device.tester.app.settingsFailed') })
              }
            >
              {t('device.tester.app.settings')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {keychainAvail.state !== 'no' ? (
        <div className="dv-action-row">
          <div className="dv-action-row__text">
            <span className="dv-action-row__title">{t('device.tester.app.keychain')}</span>
            {keychainAvail.state === 'blocked' ? <Blocked availability={keychainAvail} /> : <span className="dv-hint">{t('device.tester.app.keychainHint')}</span>}
          </div>
          {keychainAvail.state === 'yes' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={KeyRound}
              className="dv-danger-text"
              loading={isPending('keychain')}
              onClick={async () => {
                const ok = await confirm({
                  title: t('device.tester.app.keychainConfirmTitle'),
                  message: t('device.tester.app.keychainConfirmMessage'),
                  confirmLabel: t('device.tester.app.keychainConfirm'),
                  danger: true,
                });
                if (ok) void run({ key: 'keychain', action: 'keychain-reset', success: t('device.tester.app.keychainDone'), failure: t('device.tester.app.keychainFailed') });
              }}
            >
              {t('device.tester.app.keychainConfirm')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </DeviceCard>
  );
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** Android's own full report (`adb bugreport`): start, progress from `DeviceInfo.bugReport`, stop, the finished files. */
export function DeviceReportCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const avail = actionAvailability(device, 'bug-report');
  const localStart = useDeviceReports((s) => s.running[device.id]);
  const allFiles = useDeviceReports((s) => s.files);
  const files = useMemo(() => allFiles.filter((f) => f.deviceId === device.id), [allFiles, device.id]);
  const server = device.bugReport;
  const running = !!server || localStart !== undefined;
  const startedAt = server?.startedAt ?? localStart ?? Date.now();
  const now = useNow(running);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  const progress = server?.progress;
  return (
    <DeviceCard section="bug-report" title={t('device.bugReport.title')} icon={FileArchive} description={t('device.bugReport.hint')}>
      {avail.state === 'blocked' ? (
        <Blocked availability={avail} />
      ) : running ? (
        <div className="dv-progress" role="status" aria-live="polite">
          <span className="dv-progress__text">
            <Spinner size={12} /> {progress !== undefined ? t('device.bugReport.running', { percent: Math.round(progress) }) : t('device.bugReport.runningNoPercent')}
            <span className="subtle"> · {t('device.bugReport.elapsed', { time: recordClock(Math.max(0, now - startedAt)) })}</span>
          </span>
          <div className="dv-progress__bar" aria-hidden>
            <span className="dv-progress__fill" style={{ width: `${Math.max(3, Math.min(100, progress ?? 3))}%` }} />
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={Square}
            loading={stopping}
            onClick={() => {
              setStopping(true);
              void cancelDeviceReport(device.id).finally(() => setStopping(false));
            }}
          >
            {t('device.bugReport.cancel')}
          </Button>
          {localStart === undefined ? <span className="dv-hint">{t('device.bugReport.elsewhere')}</span> : null}
        </div>
      ) : (
        <div className="dv-row">
          <Button size="sm" icon={FileArchive} onClick={() => void takeDeviceReport(device.id)}>
            {t('device.bugReport.start')}
          </Button>
        </div>
      )}
      {files.length > 0 ? (
        <ul className="dv-files">
          {files.map((f) => (
            <li key={f.url} className="dv-action-row">
              <div className="dv-action-row__text">
                <span className="dv-action-row__title mono truncate">{f.file?.split('/').pop() ?? f.url.split('/').pop()}</span>
                <span className="dv-hint">{t('device.bugReport.file', { size: formatBytes(f.bytes), time: formatDuration(f.durationSec * 1000) })}</span>
              </div>
              <Button size="sm" variant="secondary" onClick={() => window.open(f.url, '_blank', 'noopener')}>
                {t('device.bugReport.download')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </DeviceCard>
  );
}
