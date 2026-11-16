/**
 * "App data" under the app actions: copy the selected app's data folder (`app-data`) into one .tar.gz on this Mac
 * and download it. One copy per device at a time; the run and the finished files live in a module store so they
 * survive switching devices. Availability (incl. the "not a debug build" heads-up) comes from data/explain.ts.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Download, FolderDown, Info, X } from 'lucide-react';
import type { AppDataPullData, DeviceInfo } from '@durbun/protocol';
import { Button, Callout, IconButton, Spinner, downloadUrl, formatBytes, toast } from '../../components';
import { sendCommand } from '../../data';
import { appDataAvailability } from '../../data/explain';
import { t, useT } from '../../i18n';
import { codeText, describeError } from './codes';
import { clock } from './media/format';
import './i18nAppData';

export interface AppDataFile extends AppDataPullData {
  deviceId: string;
  ts: number;
}

interface PullError {
  appId: string;
  title: string;
  text: string;
  detail?: string;
  code?: string;
}

interface AppDataState {
  running: Record<string, { appId: string; name: string; startedAt: number }>;
  errors: Record<string, PullError>;
  files: AppDataFile[];
}

export const useAppDataPulls = create<AppDataState>(() => ({ running: {}, errors: {}, files: [] }));

/** Reply data of `app-data`, or null when it is not one. */
export function appDataResult(data: unknown): AppDataPullData | null {
  if (!data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url.startsWith('/') || typeof r.appId !== 'string') return null;
  const fileName = typeof r.fileName === 'string' && r.fileName ? r.fileName : (r.url.split('/').pop() ?? 'app-data.tar.gz');
  return {
    url: r.url,
    file: typeof r.file === 'string' ? r.file : '',
    fileName,
    appId: r.appId,
    bytes: typeof r.bytes === 'number' ? r.bytes : 0,
    rawBytes: typeof r.rawBytes === 'number' ? r.rawBytes : 0,
    durationSec: typeof r.durationSec === 'number' ? r.durationSec : 0,
  };
}

const download = (f: Pick<AppDataPullData, 'url' | 'fileName'>) => downloadUrl(f.url, f.fileName);

/** Copy one app's data; the reply comes when the file is written (minutes for large data). */
export async function pullAppData(deviceId: string, app: { id: string; name: string }, userId?: number): Promise<void> {
  if (useAppDataPulls.getState().running[deviceId]) return;
  const startedAt = Date.now();
  useAppDataPulls.setState((s) => {
    const errors = { ...s.errors };
    delete errors[deviceId];
    return { running: { ...s.running, [deviceId]: { appId: app.id, name: app.name, startedAt } }, errors };
  });
  try {
    const data = await sendCommand(
      { name: 'device.action', deviceId, action: 'app-data', params: { appId: app.id, ...(userId === undefined ? {} : { userId }) } },
      { timeoutMs: 12 * 60_000 },
    );
    const r = appDataResult(data);
    if (!r) throw Object.assign(new Error('invalid'), { code: 'action.invalidResult' });
    const file: AppDataFile = { ...r, deviceId, ts: startedAt };
    useAppDataPulls.setState((s) => ({ files: [file, ...s.files.filter((f) => f.url !== file.url)].slice(0, 10) }));
    toast.success(t('device.appData.done', { app: app.name }), {
      description: formatBytes(r.bytes),
      action: { label: t('device.appData.download'), onClick: () => download(file) },
    });
  } catch (err) {
    const d = describeError(err);
    if (d.code === 'command.aborted') return;
    const title = t('device.appData.failed', { app: app.name });
    const text = d.code === 'action.invalidResult' ? (codeText('action.invalidResult') ?? d.text) : d.text;
    useAppDataPulls.setState((s) => ({ errors: { ...s.errors, [deviceId]: { appId: app.id, title, text, detail: d.detail, code: d.code } } }));
    toast.error(title, { description: text });
  } finally {
    useAppDataPulls.setState((s) => {
      const running = { ...s.running };
      delete running[deviceId];
      return { running };
    });
  }
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** Codes that are about the phone or the app, not a fault: said as a note, not as an error. */
const NOTE_CODES = new Set(['action.appData.notDebuggable', 'action.appData.empty', 'action.appData.locked', 'action.appData.notInstalled']);

export function AppDataRow({
  device,
  app,
  userId,
}: {
  device: DeviceInfo;
  app: { id: string; name: string; debuggable?: boolean; listed?: boolean } | undefined;
  userId?: number;
}) {
  const tr = useT();
  const { availability, notDebug } = appDataAvailability(device, app);
  const run = useAppDataPulls((s) => s.running[device.id]);
  const error = useAppDataPulls((s) => s.errors[device.id]);
  const files = useAppDataPulls((s) => s.files);
  const now = useNow(!!run);
  if (availability.state === 'no') return null;

  if (availability.state === 'blocked') {
    // A physical iPhone: where Xcode does it instead (no button).
    return (
      <div className="dv-appdata" data-testid="app-data">
        <div className="dv-action-row dv-appdata__row">
          <div className="dv-action-row__text">
            <span className="dv-action-row__title">{tr('device.appData.title')}</span>
            <span className="dv-hint">{codeText(availability.code, availability.params) ?? availability.code}</span>
          </div>
        </div>
      </div>
    );
  }

  const mine = run && app && run.appId === app.id;
  const appFiles = app ? files.filter((f) => f.deviceId === device.id && f.appId === app.id) : [];
  const shownError = error && app && error.appId === app.id ? error : undefined;
  return (
    <div className="dv-appdata" data-testid="app-data">
      <div className="dv-action-row dv-appdata__row">
        <div className="dv-action-row__text">
          <span className="dv-action-row__title">{tr('device.appData.title')}</span>
          <span className="dv-hint">{tr(device.platform === 'android' ? 'device.appData.hintAndroid' : 'device.appData.hintSim')}</span>
          {notDebug && !shownError ? (
            <span className="dv-hint dv-appdata__note">
              <Info size={12} aria-hidden /> {tr('device.appData.notDebug')}
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={FolderDown}
          loading={!!mine}
          disabled={!app || (!!run && !mine)}
          onClick={() => app && void pullAppData(device.id, app, userId)}
        >
          {tr('device.appData.pull')}
        </Button>
      </div>
      {run ? (
        <div className="dv-loading dv-appdata__status" role="status" aria-live="polite">
          <Spinner size={12} />
          <span>
            {mine ? tr('device.appData.running', { time: clock(Math.max(0, Math.round((now - run.startedAt) / 1000))) }) : tr('device.appData.otherApp', { app: run.name })}
            {mine ? <span className="subtle"> · {tr('device.appData.runningHint')}</span> : null}
          </span>
        </div>
      ) : null}
      {shownError ? (
        <Callout
          tone={shownError.code && NOTE_CODES.has(shownError.code) ? 'warn' : 'danger'}
          compact
          title={shownError.title}
          className="dv-error"
          actions={
            <IconButton
              icon={X}
              size="xs"
              label={tr('common.close')}
              onClick={() =>
                useAppDataPulls.setState((s) => {
                  const errors = { ...s.errors };
                  delete errors[device.id];
                  return { errors };
                })
              }
            />
          }
        >
          {shownError.text}
          {shownError.detail ? <span className="dv-error__detail mono">{shownError.detail}</span> : null}
        </Callout>
      ) : null}
      {appFiles.length > 0 ? (
        <ul className="dv-files">
          {appFiles.map((f) => (
            <li key={f.url} className="dv-action-row">
              <div className="dv-action-row__text">
                <span className="dv-action-row__title mono truncate" title={f.fileName}>
                  {f.fileName}
                </span>
                <span className="dv-hint">{tr('device.appData.file', { size: formatBytes(f.bytes), time: clock(Math.max(1, f.durationSec)) })}</span>
              </div>
              <Button size="sm" variant="secondary" icon={Download} onClick={() => download(f)}>
                {tr('device.appData.download')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
