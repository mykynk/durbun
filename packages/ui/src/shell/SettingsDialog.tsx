import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Archive, Bell, ExternalLink, Info, Network, Palette, RotateCcw, ScrollText, Send, Settings, Unplug, Wifi } from 'lucide-react';
import { DEFAULT_PORTS, type ServerSettings } from '@durbun/protocol';
import { errorText, useLanguage, useT } from '../i18n';
import {
  DEFAULT_NOISE_RULES,
  api,
  isConnected,
  ui,
  updateServerSettings,
  updateSlack,
  useConnection,
  usePrefs,
  useServerSettings,
  useSlackStatus,
  useUi,
  type SettingsSection,
} from '../data';
import { Dialog, confirm } from '../components/Dialog';
import { Button } from '../components/Button';
import { SegmentedControl, Toggle } from '../components/Controls';
import { Input, Select } from '../components/Form';
import { Chip } from '../components/Badges';
import { CopyButton } from '../components/CopyButton';
import { toast } from '../components/Toast';
import { formatDateTime, formatNumber, formatTime } from '../lib/format';
import { notificationPermission, requestNotificationPermission } from '../lib/notify';
import { errorMessage } from './actions';
import { DurbunMark } from '../components/Icons';
import { sdkHostLines } from './sdkHosts';
import { Snippet } from './Snippet';
import { SLACK_ADD_URL, toSlackText } from '../lib/slack';
import { Group, OfflineNote, Row, SectionHeader } from './settingsParts';
import { BackupSection } from '../features/transfer/BackupSection';

/** Inclusive ranges the server accepts (packages/server/src/config.ts SETTINGS_LIMITS); KB for bodies. */
const LIMITS = {
  maxLogEntries: [1_000, 1_000_000],
  maxNetworkEntries: [100, 100_000],
  maxBodyKB: [1, 10_240],
  maxBodyStoreMB: [16, 8_192],
  logcatTail: [0, 100_000],
  metricsIntervalMs: [250, 60_000],
} as const;

const SECTIONS: { id: SettingsSection; icon: typeof Palette }[] = [
  { id: 'appearance', icon: Palette },
  { id: 'logs', icon: ScrollText },
  { id: 'network', icon: Network },
  { id: 'connection', icon: Wifi },
  { id: 'slack', icon: Send },
  { id: 'backup', icon: Archive },
  { id: 'about', icon: Info },
];

/** Settings: UI preferences (local) + server settings (`settings.update`). */
export function SettingsDialog() {
  const section = useUi((s) => s.settings);
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={section !== null} onClose={ui.closeSettings} bare size="lg" className="settings" aria-label={t('shell.settings.title')} initialFocus={contentRef}>
      {section ? (
        <div className="settings__layout">
          <nav className="settings__nav" aria-label={t('shell.settings.title')}>
            <div className="settings__nav-title">
              <Settings size={15} aria-hidden />
              {t('shell.settings.title')}
            </div>
            {SECTIONS.map(({ id, icon: Icon }) => (
              <button key={id} type="button" className={clsx('settings__nav-item', section === id && 'is-active')} aria-current={section === id ? 'page' : undefined} onClick={() => ui.openSettings(id)}>
                <Icon size={15} aria-hidden />
                {t(`shell.settings.sections.${id}`)}
              </button>
            ))}
          </nav>
          <div className="settings__content" ref={contentRef} tabIndex={-1}>
            {section === 'appearance' ? <AppearanceSection /> : null}
            {section === 'logs' ? <LogsSection /> : null}
            {section === 'network' ? <NetworkSection /> : null}
            {section === 'connection' ? <ConnectionSection /> : null}
            {section === 'slack' ? <SlackSection /> : null}
            {section === 'backup' ? <BackupSection /> : null}
            {section === 'about' ? <AboutSection /> : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/* ───────────── Appearance ───────────── */

function AppearanceSection() {
  const t = useT();
  const p = usePrefs();
  const [perm, setPerm] = useState(notificationPermission());
  const sampleTs = useRef(Date.now()).current;

  const onNotify = async (on: boolean) => {
    if (on && perm !== 'granted') {
      const res = await requestNotificationPermission();
      setPerm(res);
      if (res !== 'granted') {
        toast.warn(t('shell.settings.notifyDenied'));
        return;
      }
    }
    p.setPref('notifyOnCrash', on);
  };

  return (
    <>
      <SectionHeader title={t('shell.settings.sections.appearance')} description={t('shell.settings.appearanceDesc')} />
      <Group>
        <Row label={t('shell.theme.title')}>
          <SegmentedControl
            value={p.theme}
            onChange={(v) => p.setPref('theme', v)}
            aria-label={t('shell.theme.title')}
            options={[
              { value: 'system', label: t('shell.theme.system') },
              { value: 'dark', label: t('shell.theme.dark') },
              { value: 'light', label: t('shell.theme.light') },
            ]}
          />
        </Row>
        <Row label={t('shell.settings.language')}>
          <SegmentedControl
            value={p.language}
            onChange={(v) => p.setPref('language', v)}
            aria-label={t('shell.settings.language')}
            options={[
              { value: 'tr', label: 'Türkçe' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Row>
      </Group>
      <Group title={t('shell.settings.logText')}>
        <Row label={t('shell.settings.logFontSize')} hint={t('shell.settings.logFontSizeHint')}>
          <div className="row gap-3">
            <input
              type="range"
              className="range"
              min={11}
              max={16}
              step={0.5}
              value={p.logFontSize}
              onChange={(e) => p.setPref('logFontSize', Number(e.target.value))}
              aria-label={t('shell.settings.logFontSize')}
            />
            <span className="tnum setting-value">{formatNumber(p.logFontSize, { maxFractionDigits: 1 })} px</span>
          </div>
        </Row>
        <Row label={t('shell.settings.density')}>
          <SegmentedControl
            value={p.density}
            onChange={(v) => p.setPref('density', v)}
            aria-label={t('shell.settings.density')}
            options={[
              { value: 'compact', label: t('shell.settings.densityCompact') },
              { value: 'comfortable', label: t('shell.settings.densityComfortable') },
            ]}
          />
        </Row>
        <Row label={t('shell.settings.timeFormat')} hint={t('shell.settings.timeFormatHint')}>
          <SegmentedControl
            value={p.timeFormat}
            onChange={(v) => p.setPref('timeFormat', v)}
            aria-label={t('shell.settings.timeFormat')}
            options={[
              { value: 'absolute', label: t('shell.settings.timeAbsolute'), tooltip: formatTime(sampleTs) },
              { value: 'relative', label: t('shell.settings.timeRelative'), tooltip: formatTime(sampleTs, { format: 'relative', base: sampleTs - 12_345 }) },
              { value: 'delta', label: t('shell.settings.timeDelta'), tooltip: formatTime(sampleTs, { format: 'delta', prev: sampleTs - 12 }) },
            ]}
          />
        </Row>
        <Row label={t('shell.settings.wrap')}>
          <Toggle checked={p.wrapLines} onChange={(v) => p.setPref('wrapLines', v)} aria-label={t('shell.settings.wrap')} />
        </Row>
        <div className="log-preview mono" aria-hidden>
          <span className="log-preview__time">{formatTime(sampleTs, { format: p.timeFormat, base: sampleTs - 12_345, prev: sampleTs - 12 })}</span>
          <span className="lvl lvl--pill lvl--info">INFO</span>
          <span className="log-preview__msg">{t('shell.settings.previewLine')}</span>
        </div>
      </Group>
      <Group title={t('shell.settings.notifications')}>
        <Row
          label={
            <span className="row gap-2">
              <Bell size={14} aria-hidden />
              {t('shell.settings.notifyOnCrash')}
            </span>
          }
          hint={perm === 'unsupported' ? t('shell.settings.notifyUnsupported') : perm === 'denied' ? t('shell.settings.notifyDenied') : t('shell.settings.notifyHint')}
        >
          <Toggle checked={p.notifyOnCrash && perm === 'granted'} disabled={perm === 'unsupported'} onChange={(v) => void onNotify(v)} aria-label={t('shell.settings.notifyOnCrash')} />
        </Row>
      </Group>
    </>
  );
}

/* ───────────── Server settings helpers ───────────── */

function useServerPatch() {
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

function NumberField({
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

function TextField({ value, onCommit, placeholder, disabled, label }: { value: string; onCommit: (v: string) => void; placeholder?: string; disabled?: boolean; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      size="sm"
      mono
      className="setting-text"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/* ───────────── Logs ───────────── */

function LogsSection() {
  const t = useT();
  const p = usePrefs();
  const s = useServerSettings((x) => x.settings);
  const connected = isConnected(useConnection((x) => x.status));
  const { save, savedKey } = useServerPatch();
  const [newApp, setNewApp] = useState('');
  const customNoise = p.noiseRules.length !== DEFAULT_NOISE_RULES.length || p.noiseRules.some((r, i) => r.value !== DEFAULT_NOISE_RULES[i]?.value || !r.enabled);

  const addWatched = () => {
    const id = newApp.trim();
    if (!id || s.watchedApps.includes(id)) return;
    void save('watchedApps', { watchedApps: [...s.watchedApps, id] });
    setNewApp('');
  };

  return (
    <>
      <SectionHeader title={t('shell.settings.sections.logs')} description={t('shell.settings.logsDesc')} />
      <Group title={t('shell.settings.view')}>
        <Row label={t('shell.settings.showNetworkInLogs')} hint={t('shell.settings.showNetworkInLogsHint')}>
          <Toggle checked={p.showNetworkInLogs} onChange={(v) => p.setPref('showNetworkInLogs', v)} aria-label={t('shell.settings.showNetworkInLogs')} />
        </Row>
        <Row label={t('shell.settings.hideNoise')} hint={t('shell.settings.hideNoiseHint', { count: p.noiseRules.filter((r) => r.enabled).length })}>
          <div className="row gap-2">
            {customNoise ? (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => p.setPref('noiseRules', DEFAULT_NOISE_RULES)}>
                {t('shell.settings.resetNoise')}
              </Button>
            ) : null}
            <Toggle checked={p.hideNoise} onChange={(v) => p.setPref('hideNoise', v)} aria-label={t('shell.settings.hideNoise')} />
          </div>
        </Row>
      </Group>
      <Group title={t('shell.settings.server')}>
        <OfflineNote />
        <Row label={t('shell.settings.maxLogEntries')} hint={t('shell.settings.maxLogEntriesHint')} range={[LIMITS.maxLogEntries[0], LIMITS.maxLogEntries[1]]} saved={savedKey === 'maxLogEntries'}>
          <NumberField
            label={t('shell.settings.maxLogEntries')}
            value={s.maxLogEntries}
            min={LIMITS.maxLogEntries[0]}
            max={LIMITS.maxLogEntries[1]}
            disabled={!connected}
            onCommit={(v) => void save('maxLogEntries', { maxLogEntries: v })}
          />
        </Row>
        <Row label={t('shell.settings.logcatTail')} hint={t('shell.settings.logcatTailHint')} range={[LIMITS.logcatTail[0], LIMITS.logcatTail[1]]} saved={savedKey === 'logcatTail'}>
          <NumberField label={t('shell.settings.logcatTail')} value={s.logcatTail} min={LIMITS.logcatTail[0]} max={LIMITS.logcatTail[1]} disabled={!connected} onCommit={(v) => void save('logcatTail', { logcatTail: v })} />
        </Row>
        <Row label={t('shell.settings.iosDeviceLogScope')} hint={t('shell.settings.iosDeviceLogScopeHint')} saved={savedKey === 'iosDeviceLogScope'}>
          <SegmentedControl
            size="sm"
            value={s.iosDeviceLogScope ?? 'apps'}
            onChange={(v) => void save('iosDeviceLogScope', { iosDeviceLogScope: v })}
            aria-label={t('shell.settings.iosDeviceLogScope')}
            options={[
              { value: 'apps', label: t('shell.settings.scopeApps'), disabled: !connected },
              { value: 'all', label: t('shell.settings.scopeAll'), disabled: !connected },
            ]}
          />
        </Row>
        <Row label={t('shell.settings.iosSimLogScope')} hint={t('shell.settings.iosSimLogScopeHint')} saved={savedKey === 'iosSimLogScope'}>
          <SegmentedControl
            size="sm"
            value={s.iosSimLogScope}
            onChange={(v) => void save('iosSimLogScope', { iosSimLogScope: v })}
            aria-label={t('shell.settings.iosSimLogScope')}
            options={[
              { value: 'apps', label: t('shell.settings.scopeApps'), disabled: !connected },
              { value: 'all', label: t('shell.settings.scopeAll'), disabled: !connected },
            ]}
          />
        </Row>
        <Row label={t('shell.settings.iosSimLogLevel')} hint={t('shell.settings.iosSimLogLevelHint')} saved={savedKey === 'iosSimLogLevel'}>
          <Select
            size="sm"
            value={s.iosSimLogLevel}
            disabled={!connected}
            aria-label={t('shell.settings.iosSimLogLevel')}
            onChange={(e) => void save('iosSimLogLevel', { iosSimLogLevel: e.target.value as ServerSettings['iosSimLogLevel'] })}
            options={[
              { value: 'default', label: t('shell.settings.simLevelDefault') },
              { value: 'info', label: t('shell.settings.simLevelInfo') },
              { value: 'debug', label: t('shell.settings.simLevelDebug') },
            ]}
          />
        </Row>
        <Row label={t('shell.settings.watchedApps')} hint={t('shell.settings.watchedAppsHint')} saved={savedKey === 'watchedApps'}>
          <div className="col gap-2 setting-wide">
            <div className="row gap-2">
              <Input
                size="sm"
                mono
                value={newApp}
                placeholder="com.example.app"
                disabled={!connected}
                aria-label={t('shell.settings.watchedApps')}
                onChange={(e) => setNewApp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addWatched();
                }}
              />
              <Button size="sm" onClick={addWatched} disabled={!connected || !newApp.trim()}>
                {t('common.add')}
              </Button>
            </div>
            {s.watchedApps.length > 0 ? (
              <div className="row wrap gap-1">
                {s.watchedApps.map((id) => (
                  <Chip key={id} size="sm" mono onRemove={() => void save('watchedApps', { watchedApps: s.watchedApps.filter((x) => x !== id) })}>
                    {id}
                  </Chip>
                ))}
              </div>
            ) : null}
          </div>
        </Row>
      </Group>
    </>
  );
}

/* ───────────── Network ───────────── */

function NetworkSection() {
  const t = useT();
  const s = useServerSettings((x) => x.settings);
  const connected = isConnected(useConnection((x) => x.status));
  const { save, savedKey } = useServerPatch();
  return (
    <>
      <SectionHeader title={t('shell.settings.sections.network')} description={t('shell.settings.networkDesc')} />
      <Group>
        <OfflineNote />
        <Row label={t('shell.settings.captureBodies')} hint={t('shell.settings.captureBodiesHint')} saved={savedKey === 'captureBodies'}>
          <Toggle checked={s.captureBodies} disabled={!connected} onChange={(v) => void save('captureBodies', { captureBodies: v })} aria-label={t('shell.settings.captureBodies')} />
        </Row>
        <Row label={t('shell.settings.maxBodyBytes')} hint={t('shell.settings.maxBodyBytesHint')} range={[LIMITS.maxBodyKB[0], LIMITS.maxBodyKB[1], 'KB']} saved={savedKey === 'maxBodyBytes'}>
          <NumberField
            label={t('shell.settings.maxBodyBytes')}
            value={s.maxBodyBytes}
            scale={1024}
            unit="KB"
            min={LIMITS.maxBodyKB[0]}
            max={LIMITS.maxBodyKB[1]}
            disabled={!connected}
            onCommit={(v) => void save('maxBodyBytes', { maxBodyBytes: v })}
          />
        </Row>
        <Row label={t('shell.settings.maxBodyStoreMB')} hint={t('shell.settings.maxBodyStoreMBHint')} range={[LIMITS.maxBodyStoreMB[0], LIMITS.maxBodyStoreMB[1], 'MB']} saved={savedKey === 'maxBodyStoreMB'}>
          <NumberField
            label={t('shell.settings.maxBodyStoreMB')}
            value={s.maxBodyStoreMB}
            unit="MB"
            min={LIMITS.maxBodyStoreMB[0]}
            max={LIMITS.maxBodyStoreMB[1]}
            disabled={!connected}
            onCommit={(v) => void save('maxBodyStoreMB', { maxBodyStoreMB: v })}
          />
        </Row>
        <Row label={t('shell.settings.maxNetworkEntries')} hint={t('shell.settings.maxNetworkEntriesHint')} range={[LIMITS.maxNetworkEntries[0], LIMITS.maxNetworkEntries[1]]} saved={savedKey === 'maxNetworkEntries'}>
          <NumberField
            label={t('shell.settings.maxNetworkEntries')}
            value={s.maxNetworkEntries}
            min={LIMITS.maxNetworkEntries[0]}
            max={LIMITS.maxNetworkEntries[1]}
            disabled={!connected}
            onCommit={(v) => void save('maxNetworkEntries', { maxNetworkEntries: v })}
          />
        </Row>
      </Group>
    </>
  );
}

/* ───────────── Connection ───────────── */

function ConnectionSection() {
  const t = useT();
  const s = useServerSettings((x) => x.settings);
  const server = useConnection((x) => x.server);
  const connected = isConnected(useConnection((x) => x.status));
  const { save, savedKey } = useServerPatch();
  const sdkPort = server?.ports.sdk ?? DEFAULT_PORTS.sdk;
  const httpPort = server?.ports.http ?? DEFAULT_PORTS.http;

  const onLan = async (on: boolean) => {
    if (on) {
      const ok = await confirm({ title: t('shell.settings.lanConfirmTitle'), message: t('shell.settings.lanConfirmMessage'), confirmLabel: t('shell.settings.lanConfirm') });
      if (!ok) return;
    }
    void save('allowLan', { allowLan: on });
  };

  return (
    <>
      <SectionHeader title={t('shell.settings.sections.connection')} description={t('shell.settings.connectionDesc')} />
      <Group>
        <OfflineNote />
        <Row label={t('shell.settings.allowLan')} hint={t('shell.settings.allowLanHint', { port: sdkPort })} saved={savedKey === 'allowLan'}>
          <Toggle checked={s.allowLan} disabled={!connected} onChange={(v) => void onLan(v)} aria-label={t('shell.settings.allowLan')} />
        </Row>
        {s.allowLan ? <LanHosts hosts={server?.hostAddresses ?? []} ports={{ http: httpPort, sdk: sdkPort }} /> : null}
        <Row label={t('shell.settings.autoAttachVm')} hint={t('shell.settings.autoAttachVmHint')} saved={savedKey === 'autoAttachVmService'}>
          <Toggle checked={s.autoAttachVmService} disabled={!connected} onChange={(v) => void save('autoAttachVmService', { autoAttachVmService: v })} aria-label={t('shell.settings.autoAttachVm')} />
        </Row>
        <Row
          label={t('shell.settings.metricsInterval')}
          hint={t('shell.settings.metricsIntervalHint')}
          range={[LIMITS.metricsIntervalMs[0], LIMITS.metricsIntervalMs[1], 'ms']}
          saved={savedKey === 'metricsIntervalMs'}
        >
          <NumberField
            label={t('shell.settings.metricsInterval')}
            value={s.metricsIntervalMs}
            unit="ms"
            min={LIMITS.metricsIntervalMs[0]}
            max={LIMITS.metricsIntervalMs[1]}
            disabled={!connected}
            onCommit={(v) => void save('metricsIntervalMs', { metricsIntervalMs: v })}
          />
        </Row>
      </Group>
      <Group title={t('shell.settings.tools')}>
        <Row label={t('shell.settings.adbPath')} hint={t('shell.settings.adbPathHint')} saved={savedKey === 'adbPath'}>
          {/* '' unsets the path on the server (undefined would be dropped from the JSON patch). */}
          <TextField label={t('shell.settings.adbPath')} value={s.adbPath ?? ''} placeholder={t('shell.settings.autoDetect')} disabled={!connected} onCommit={(v) => void save('adbPath', { adbPath: v })} />
        </Row>
        <Row label={t('shell.settings.idevicesyslogPath')} hint={t('shell.settings.idevicesyslogPathHint')} saved={savedKey === 'idevicesyslogPath'}>
          <TextField
            label={t('shell.settings.idevicesyslogPath')}
            value={s.idevicesyslogPath ?? ''}
            placeholder={t('shell.settings.autoDetect')}
            disabled={!connected}
            onCommit={(v) => void save('idevicesyslogPath', { idevicesyslogPath: v })}
          />
        </Row>
      </Group>
    </>
  );
}

/* ───────────── Slack ───────────── */

/**
 * Send to Slack: one incoming webhook, kept by the server in its data directory (never in settings.json,
 * never shown again: the field only takes a new URL). Messages go only when someone clicks Send.
 */
function SlackSection() {
  const t = useT();
  const lang = useLanguage();
  const status = useSlackStatus();
  const connected = isConnected(useConnection((x) => x.status));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const linked = !!status?.configured;

  const run = async (kind: 'save' | 'test' | 'remove', job: () => Promise<void>) => {
    setBusy(kind);
    try {
      await job();
    } catch (err) {
      toast.error(kind === 'test' ? t('common.slack.failed') : t('shell.settings.saveFailed'), { description: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run('save', async () => {
      if (!draft.trim()) return;
      await updateSlack({ webhookUrl: draft.trim() });
      setDraft('');
      toast.success(t('shell.settings.slackLinked'));
    });
  const test = () =>
    run('test', async () => {
      const footer = status?.sender ? t('common.slack.footerFrom', { sender: status.sender }) : t('common.slack.footer');
      await api.sendToSlack(toSlackText(t('shell.settings.slackTestText'), { cutNote: t('common.slack.cutNote'), footer }));
      toast.success(t('common.slack.sent'));
    });
  const remove = async () => {
    const ok = await confirm({ title: t('shell.settings.slackRemoveTitle'), message: t('shell.settings.slackRemoveMessage'), confirmLabel: t('shell.settings.slackRemove'), danger: true });
    if (ok) await run('remove', async () => void (await updateSlack({ webhookUrl: null })));
  };
  // Not through `run`: the name commits on blur, which must not disable the button being clicked.
  const saveSender = async (v: string) => {
    try {
      await updateSlack({ sender: v || null });
      setSavedKey('sender');
      setTimeout(() => setSavedKey(null), 1600);
    } catch (err) {
      toast.error(t('shell.settings.saveFailed'), { description: errorText(err) });
    }
  };

  return (
    <>
      <SectionHeader title={t('shell.settings.sections.slack')} description={t('shell.settings.slackDesc')} />
      <Group>
        <OfflineNote />
        {linked ? null : (
          <Row label={t('shell.settings.slackApp')} hint={t('shell.settings.slackAppHint')}>
            {/* Opens in the browser: Slack's sign-in and the page's exchange never run inside Dürbün. */}
            <a className="btn btn--primary btn--sm" href={`${SLACK_ADD_URL}?lang=${lang}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden />
              <span className="btn__label">{t('shell.settings.slackAppAdd')}</span>
            </a>
          </Row>
        )}
        <Row label={t('shell.settings.slackWebhook')} hint={linked ? t('shell.settings.slackLinkedTo', { hint: status?.hint ?? '' }) : t('shell.settings.slackWebhookHint')}>
          {linked ? (
            <Button size="sm" variant="ghost" icon={Unplug} loading={busy === 'remove'} disabled={!connected || busy !== null} onClick={() => void remove()}>
              {t('shell.settings.slackRemove')}
            </Button>
          ) : (
            <form
              className="slack-link"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {/* A password field: the URL is the secret, and settings get shown in screen shares. */}
              <Input
                size="sm"
                mono
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="setting-text"
                value={draft}
                placeholder="https://hooks.slack.com/services/…"
                disabled={!connected}
                aria-label={t('shell.settings.slackWebhook')}
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button size="sm" type="submit" loading={busy === 'save'} disabled={!connected || !draft.trim() || busy !== null}>
                {t('shell.settings.slackLink')}
              </Button>
            </form>
          )}
        </Row>
        {linked ? (
          <Row label={t('shell.settings.slackTest')} hint={t('shell.settings.slackTestHint')}>
            <Button size="sm" icon={Send} loading={busy === 'test'} disabled={!connected || busy !== null} onClick={() => void test()}>
              {t('shell.settings.slackTestSend')}
            </Button>
          </Row>
        ) : null}
        <Row label={t('shell.settings.slackSender')} hint={t('shell.settings.slackSenderHint')} saved={savedKey === 'sender'}>
          <TextField label={t('shell.settings.slackSender')} value={status?.sender ?? ''} placeholder={t('shell.settings.slackSenderPlaceholder')} disabled={!connected || status === null} onCommit={(v) => void saveSender(v)} />
        </Row>
      </Group>
      <Group title={t('shell.settings.slackPanel')}>
        <div className="slack-panel">
          <p className="setting-row__hint">{t('shell.settings.slackPanelHint')}</p>
          <Snippet lang="shell" code={'export DURBUN_SLACK_WEBHOOK=https://hooks.slack.com/services/…   # ~/.zshrc, never the repo\nflutter run --dart-define=DURBUN_SLACK_WEBHOOK=$DURBUN_SLACK_WEBHOOK'} />
        </div>
      </Group>
    </>
  );
}

/** LAN mode on: this Mac's addresses and the exact line each SDK needs to reach it over Wi-Fi. */
function LanHosts({ hosts, ports }: { hosts: string[]; ports: { http: number; sdk: number } }) {
  const t = useT();
  const [host, setHost] = useState(hosts[0] ?? '');
  const current = hosts.includes(host) ? host : (hosts[0] ?? '');
  if (hosts.length === 0) {
    return (
      <div className="lan-hosts">
        <p className="setting-row__hint">{t('shell.sdk.noHosts')}</p>
      </div>
    );
  }
  return (
    <div className="lan-hosts">
      <div className="host-list">
        <span className="muted text-sm">{t('shell.settings.hostAddresses')}</span>
        {hosts.map((h) => (
          <span key={h} className={clsx('host-chip mono', h === current && hosts.length > 1 && 'is-active')}>
            {hosts.length > 1 ? (
              <button type="button" className="host-chip__pick" onClick={() => setHost(h)} aria-pressed={h === current}>
                {h}
              </button>
            ) : (
              h
            )}
            <CopyButton size="xs" value={h} />
          </span>
        ))}
      </div>
      <p className="lan-hosts__lead">{t('shell.settings.lanSdkHost')}</p>
      <ul className="lan-hosts__list">
        {sdkHostLines(current, ports).map((line) => (
          <li key={line.sdk} className="lan-hosts__row">
            <span className="lan-hosts__sdk">{t(`shell.sdk.tabs.${line.sdk}`)}</span>
            <code className="lan-hosts__code mono selectable">{line.code}</code>
            <CopyButton size="xs" value={line.code} />
          </li>
        ))}
      </ul>
      <p className="setting-row__hint">{t('shell.settings.lanRnNote', { port: ports.http })}</p>
      <p className="setting-row__hint">{t('shell.sdk.iosLocalNetwork')}</p>
    </div>
  );
}

/* ───────────── About ───────────── */

/** `process.platform` → product name. */
const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function AboutSection() {
  const t = useT();
  const server = useConnection((x) => x.server);
  const resetPrefs = usePrefs((x) => x.resetPrefs);
  const onReset = async () => {
    const ok = await confirm({ title: t('shell.settings.resetUiTitle'), message: t('shell.settings.resetUiMessage'), confirmLabel: t('shell.settings.resetUi'), danger: true });
    if (ok) {
      resetPrefs();
      toast.success(t('shell.settings.resetUiDone'));
    }
  };
  const rows: [string, string | undefined][] = server
    ? [
        [t('shell.about.version'), server.version],
        [t('shell.about.protocol'), String(server.protocol)],
        [t('shell.about.ports'), `HTTP ${server.ports.http} · SDK ${server.ports.sdk}`],
        [t('shell.about.startedAt'), formatDateTime(server.startedAt)],
        [t('shell.about.dataDir'), server.dataDir],
        [t('shell.about.platform'), PLATFORM_NAMES[server.platform] ?? server.platform],
        [t('shell.about.hosts'), server.hostAddresses.join(', ') || '—'],
      ]
    : [];
  return (
    <>
      <SectionHeader title={t('shell.about.title')} />
      <div className="about-hero">
        <DurbunMark tile size={44} />
        <div>
          <div className="about-hero__name">Dürbün</div>
          <div className="muted text-sm">{t('shell.about.tagline')}</div>
        </div>
      </div>
      <Group>
        {server ? (
          <dl className="about-list">
            {rows.map(([k, v]) => (
              <div key={k} className="about-list__row">
                <dt>{k}</dt>
                <dd className="mono selectable">
                  {v}
                  {v && k === t('shell.about.dataDir') ? <CopyButton size="xs" value={v} /> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <OfflineNote />
        )}
      </Group>
      <Group title={t('shell.settings.uiPrefs')}>
        <Row label={t('shell.settings.resetUi')} hint={t('shell.settings.resetUiHint')}>
          <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => void onReset()}>
            {t('shell.settings.resetUi')}
          </Button>
        </Row>
      </Group>
    </>
  );
}
