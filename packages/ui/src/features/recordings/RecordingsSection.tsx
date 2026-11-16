import { useState } from 'react';
import { FolderClock, ShieldAlert, Trash2 } from 'lucide-react';
import { RECORDING_DEFAULTS, RECORDING_LIMITS } from '@durbun/protocol';
import { useLanguage, useT } from '../../i18n';
import { isConnected, useConnection, useServerSettings } from '../../data';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Controls';
import { Callout } from '../../components/Layout';
import { CopyButton } from '../../components/CopyButton';
import { confirm } from '../../components/Dialog';
import { formatBytes, formatNumber } from '../../lib/format';
import { Group, NumberField, OfflineNote, Row, SectionHeader, useServerPatch } from '../../shell/settingsParts';
import { isClosed, pauseText } from './model';
import { recordings, useRecordings } from './store';
import { askDeleteAll, RecorderStatusLine, useRecordingsPoll } from './RecordingsDialog';
import './recordings.css';

const GB = 1024;

/**
 * Settings → Recordings: on / off, how long and how much, where, what is in use, delete all, and a plain sentence on
 * what a recording holds. Turning recording off stops writing at once, then asks whether to delete what exists.
 */
export function RecordingsSection() {
  const t = useT();
  const lang = useLanguage();
  const s = useServerSettings((x) => x.settings);
  const connected = isConnected(useConnection((x) => x.status));
  const list = useRecordings((x) => x.list);
  const { save, savedKey } = useServerPatch();
  const [busy, setBusy] = useState(false);
  useRecordingsPoll(connected);

  const enabled = s.recordSessions !== false;
  const days = s.recordingsMaxDays ?? RECORDING_DEFAULTS.maxDays;
  const maxMB = s.recordingsMaxMB ?? RECORDING_DEFAULTS.maxMB;
  const status = list?.status;
  const closed = list?.recordings.filter(isClosed) ?? [];
  const perRecording = status?.maxRecordingBytes ?? Math.min(RECORDING_DEFAULTS.recordingMB, maxMB / 2) * 1024 * 1024;

  const setEnabled = async (on: boolean) => {
    setBusy(true);
    try {
      await save('recordSessions', { recordSessions: on });
      await recordings.refresh();
    } finally {
      setBusy(false);
    }
    if (on) return;
    const after = useRecordings.getState().list;
    const left = after?.recordings.filter(isClosed) ?? [];
    if (!left.length) return;
    const size = formatBytes(left.reduce((sum, r) => sum + r.bytes, 0));
    const remove = await confirm({
      title: t('recordings.settings.confirmOffTitle'),
      message: t('recordings.settings.confirmOffMessage', { count: left.length, size, days }),
      confirmLabel: t('recordings.settings.confirmOffDelete'),
      cancelLabel: t('recordings.settings.confirmOffKeep'),
      danger: true,
    });
    if (remove) await recordings.removeAll();
  };

  return (
    <>
      <SectionHeader title={t('recordings.title')} description={t('recordings.settings.desc')} />
      <OfflineNote />
      {status?.state === 'paused' && status.paused ? (
        <Callout tone="warn" compact title={t('recordings.status.paused')}>
          {pauseText(status.paused, lang)}
        </Callout>
      ) : null}
      <Group>
        <Row label={t('recordings.settings.enabled')} hint={t('recordings.settings.enabledHint')} saved={savedKey === 'recordSessions'}>
          <Toggle checked={enabled} disabled={!connected || busy} onChange={(v) => void setEnabled(v)} aria-label={t('recordings.settings.enabled')} />
        </Row>
        <Row
          label={t('recordings.settings.maxDays')}
          hint={t('recordings.settings.maxDaysHint')}
          saved={savedKey === 'recordingsMaxDays'}
          range={[RECORDING_LIMITS.recordingsMaxDays.min, RECORDING_LIMITS.recordingsMaxDays.max, t('recordings.settings.days')]}
        >
          <NumberField
            label={t('recordings.settings.maxDays')}
            value={days}
            min={RECORDING_LIMITS.recordingsMaxDays.min}
            max={RECORDING_LIMITS.recordingsMaxDays.max}
            unit={t('recordings.settings.days')}
            disabled={!connected}
            onCommit={(v) => void save('recordingsMaxDays', { recordingsMaxDays: v })}
          />
        </Row>
        <Row
          label={t('recordings.settings.maxMB')}
          hint={`${t('recordings.settings.maxMBHint', { per: formatBytes(perRecording) })} · ${t('shell.settings.range', {
            min: formatNumber(RECORDING_LIMITS.recordingsMaxMB.min / GB, { maxFractionDigits: 1 }),
            max: `${formatNumber(RECORDING_LIMITS.recordingsMaxMB.max / GB)} GB`,
          })}`}
          saved={savedKey === 'recordingsMaxMB'}
        >
          <NumberField
            label={t('recordings.settings.maxMB')}
            value={maxMB}
            scale={GB}
            step={0.5}
            min={RECORDING_LIMITS.recordingsMaxMB.min / GB}
            max={RECORDING_LIMITS.recordingsMaxMB.max / GB}
            unit="GB"
            disabled={!connected}
            onCommit={(v) => void save('recordingsMaxMB', { recordingsMaxMB: Math.max(RECORDING_LIMITS.recordingsMaxMB.min, v) })}
          />
        </Row>
      </Group>
      <Group>
        {status ? (
          <Row label={t('recordings.settings.where')}>
            <div className="rec-path">
              <code className="rec-path__text mono" title={status.dir}>
                <bdi dir="ltr">{status.dir}</bdi>
              </code>
              <CopyButton value={status.dir} size="sm" />
            </div>
          </Row>
        ) : null}
        <Row label={t('recordings.settings.used')} hint={status ? <RecorderStatusLine status={status} compact /> : undefined}>
          <div className="row gap-2">
            <span className="tnum muted text-sm">{status ? t('recordings.settings.usedValue', { size: formatBytes(status.usedBytes), count: list?.recordings.length ?? 0 }) : '—'}</span>
            <Button size="sm" variant="secondary" icon={FolderClock} onClick={recordings.openDialog}>
              {t('recordings.settings.show')}
            </Button>
          </div>
        </Row>
        <Row label={t('recordings.settings.deleteAll')} hint={t('recordings.settings.deleteAllHint')}>
          <Button size="sm" variant="danger" icon={Trash2} disabled={!connected || !closed.length} onClick={() => void askDeleteAll(t)}>
            {t('recordings.actions.deleteAll')}
          </Button>
        </Row>
      </Group>
      <Callout tone="info" icon={ShieldAlert} compact>
        {t('recordings.settings.privacy')}
      </Callout>
    </>
  );
}
