import { useEffect, useMemo, useState } from 'react';
import { Circle, Download, ExternalLink, Square, Video } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, downloadUrl, formatClock } from '../../components';
import { useT } from '../../i18n';
import { describeError } from './codes';
import { mediaFileName, recordClock, recordLimitSec } from './model';
import { clearRecordingError, startRecording, stopRecording, useMedia, useRecorder } from './stores';
import { ActionErrorCallout, DeviceCard, type ActionError } from './useAction';

function useClock(enabled: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [enabled, ms]);
  return now;
}

/**
 * Screen recording: Start runs until Stop or the device's limit (Android 3 min, iOS 10 min), then the file is
 * copied and shows up here. The state lives in `useRecorder` and `DeviceInfo.recording`, so it survives tab
 * switches, and a reload still shows (and can stop) a running recording.
 */
export function RecordCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const run = useRecorder((s) => s.runs[device.id]);
  const failure = useRecorder((s) => s.errors[device.id]);
  const server = device.recording;
  const active = !!run || !!server;
  const since = run?.startedAt ?? server?.startedAt ?? 0;
  const limitSec = server?.limitSec ?? recordLimitSec(device);
  const now = useClock(active && !run?.stopping);
  const elapsed = Math.min(Math.max(0, now - since), limitSec * 1000);
  // Stopped (by the user or the limit): the device finishes the file and Dürbün copies it.
  const finishing = !!run?.stopping || (active && elapsed >= limitSec * 1000);
  const canRecord = device.actions.includes('screen-record');
  const all = useMedia((s) => s.recordings);
  const recordings = useMemo(() => all.filter((r) => r.deviceId === device.id), [all, device.id]);

  const span = (sec: number) => (sec < 60 ? t('device.record.seconds', { n: sec }) : t('device.record.minutes', { n: Math.round(sec / 60) }));
  const error: ActionError | null = useMemo(() => {
    if (!failure) return null;
    const d = describeError(failure.error);
    return { title: t(failure.kind === 'start' ? 'device.record.failed' : 'device.record.stopFailed'), text: d.text, detail: d.detail };
  }, [failure, t]);

  return (
    <DeviceCard section="record" title={t('device.record.title')} icon={Video} description={t('device.record.hint')}>
      <ActionErrorCallout error={error} onDismiss={() => clearRecordingError(device.id)} />
      {active || canRecord ? (
        <div className="dv-row wrap">
          {active ? (
            <span className="dv-rec-live">
              <span className={finishing ? 'dv-rec-dot is-done' : 'dv-rec-dot'} aria-hidden />
              <span role="status">{finishing ? t('device.record.finishing') : t('device.record.recording')}</span>
              {finishing ? null : (
                <span className="dv-rec-live__clock tnum" role="timer">
                  {recordClock(elapsed)}
                  <span className="subtle"> / {recordClock(limitSec * 1000)}</span>
                </span>
              )}
            </span>
          ) : (
            <span className="dv-label">{t('device.record.limit', { limit: span(limitSec) })}</span>
          )}
          <span className="grow" />
          {active ? (
            <Button variant="danger" size="sm" icon={Square} loading={finishing} onClick={() => void stopRecording(device.id, server?.startedAt)}>
              {t('device.record.stop')}
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon={Circle} onClick={() => void startRecording(device.id, recordLimitSec(device))}>
              {t('device.record.start')}
            </Button>
          )}
        </div>
      ) : null}
      {finishing ? (
        <div className="dv-progress__bar" aria-hidden>
          <span className="dv-progress__fill is-indeterminate" />
        </div>
      ) : null}
      {recordings.length > 0 ? (
        <ul className="dv-recs" aria-label={t('device.record.list')}>
          {recordings.map((r) => (
            <li key={r.id} className="dv-rec">
              <video className="dv-rec__video" src={r.url} controls preload="metadata" />
              <div className="dv-rec__meta">
                <span className="tnum">{formatClock(r.ts, { ms: false })}</span>
                <span className="subtle tnum">· {recordClock(r.durationSec * 1000)}</span>
                <span className="grow" />
                <a className="btn btn--ghost btn--sm" href={r.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} aria-hidden />
                  <span className="btn__label">{t('device.record.open')}</span>
                </a>
                <Button size="sm" variant="ghost" icon={Download} onClick={() => downloadUrl(r.url, mediaFileName('recording', device, r.ts, r.file))}>
                  {t('device.record.download')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </DeviceCard>
  );
}
