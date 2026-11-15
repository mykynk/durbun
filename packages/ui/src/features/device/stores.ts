/**
 * Session-scoped Device view state that must survive tab switches and device changes but not reloads:
 * the screenshot / recording gallery, running screen recordings and the installed-apps cache per device.
 */
import { create } from 'zustand';
import type { DeviceInfo, InstalledApp } from '@durbun/protocol';
import { toast } from '../../components';
import { sendCommand } from '../../data';
import { t } from '../../i18n';
import { codeText, describeError } from './codes';
import { deviceReportResult, parseInstalledApps, recordResult, selectedUserId } from './model';

/* ───────────── Media gallery ───────────── */

export interface Shot {
  id: string;
  deviceId: string;
  url: string;
  file?: string;
  width?: number;
  height?: number;
  ts: number;
}

export interface Recording {
  id: string;
  deviceId: string;
  url: string;
  file?: string;
  ts: number;
  durationSec: number;
}

interface MediaState {
  shots: Shot[];
  recordings: Recording[];
  /** Screenshot shown in the lightbox (null = closed). */
  openShotId: string | null;
}

export const useMedia = create<MediaState>()(() => ({ shots: [], recordings: [], openShotId: null }));

export function openShot(id: string | null): void {
  useMedia.setState({ openShotId: id });
}

let mediaSeq = 0;
const MAX_SHOTS = 60;

export function addShot(shot: Omit<Shot, 'id'>): Shot {
  const full = { ...shot, id: `shot-${++mediaSeq}` };
  useMedia.setState((s) => ({ shots: [full, ...s.shots].slice(0, MAX_SHOTS) }));
  return full;
}

export function removeShot(id: string): void {
  useMedia.setState((s) => ({ shots: s.shots.filter((x) => x.id !== id), openShotId: s.openShotId === id ? null : s.openShotId }));
}

export function addRecording(rec: Omit<Recording, 'id'>): Recording {
  const full = { ...rec, id: `rec-${++mediaSeq}` };
  useMedia.setState((s) => ({ recordings: [full, ...s.recordings].slice(0, 20) }));
  return full;
}

/* ───────────── Screen recording ───────────── */

/**
 * A recording this window started (`local`: its `screen-record` command is in flight) or is stopping. The
 * server's `DeviceInfo.recording` covers the rest (a recording started before a reload or in another window).
 */
export interface RecordingRun {
  /** Local clock when it started: the stopwatch counts from here. */
  startedAt: number;
  local: boolean;
  stopping: boolean;
}

export interface RecordingFailure {
  kind: 'start' | 'stop';
  /** The caught error (described at render time, so it follows the UI language). */
  error: unknown;
}

export const useRecorder = create<{ runs: Record<string, RecordingRun>; errors: Record<string, RecordingFailure> }>()(() => ({
  runs: {},
  errors: {},
}));

function setRun(deviceId: string, run: RecordingRun | undefined): void {
  useRecorder.setState((s) => {
    const runs = { ...s.runs };
    if (run) runs[deviceId] = run;
    else delete runs[deviceId];
    return { runs };
  });
}

function setRecordingError(deviceId: string, failure: RecordingFailure | undefined): void {
  useRecorder.setState((s) => {
    const errors = { ...s.errors };
    if (failure) errors[deviceId] = failure;
    else delete errors[deviceId];
    return { errors };
  });
}

export function clearRecordingError(deviceId: string): void {
  setRecordingError(deviceId, undefined);
}

/**
 * `screen-record` until `stopRecording` or the device's limit: resolves once the file is in the gallery (or the
 * recording failed). Runs outside the card, so switching tabs does not lose it.
 */
export async function startRecording(deviceId: string, limitSec: number): Promise<void> {
  if (useRecorder.getState().runs[deviceId]) return;
  const startedAt = Date.now();
  setRun(deviceId, { startedAt, local: true, stopping: false });
  setRecordingError(deviceId, undefined);
  try {
    const data = await sendCommand(
      { name: 'device.action', deviceId, action: 'screen-record', params: {} },
      // The reply comes after the limit at the latest, plus finishing and copying the file.
      { timeoutMs: (limitSec + 180) * 1000 },
    );
    recordingReady(deviceId, data, startedAt);
  } catch (err) {
    recordingFailed(deviceId, 'start', err);
  } finally {
    setRun(deviceId, undefined);
  }
}

/**
 * `screen-record-stop`. Its reply carries the same file as the `screen-record` reply, so a recording this window
 * did not start (`since` = the server's start time) still lands in the gallery.
 */
export async function stopRecording(deviceId: string, since?: number): Promise<void> {
  const run = useRecorder.getState().runs[deviceId];
  if (run?.stopping) return;
  const startedAt = run?.startedAt ?? since ?? Date.now();
  setRun(deviceId, run ? { ...run, stopping: true } : { startedAt, local: false, stopping: true });
  setRecordingError(deviceId, undefined);
  try {
    const data = await sendCommand({ name: 'device.action', deviceId, action: 'screen-record-stop', params: {} }, { timeoutMs: 180_000 });
    recordingReady(deviceId, data, startedAt);
  } catch (err) {
    // A recording that ended meanwhile (its limit) brings its file with its own reply.
    if ((err as { code?: unknown })?.code !== 'action.recording.notRunning') recordingFailed(deviceId, 'stop', err);
    const now = useRecorder.getState().runs[deviceId];
    if (now?.local) setRun(deviceId, { ...now, stopping: false });
  } finally {
    const now = useRecorder.getState().runs[deviceId];
    if (now && !now.local) setRun(deviceId, undefined);
  }
}

function recordingReady(deviceId: string, data: unknown, startedAt: number): void {
  const m = recordResult(data);
  if (!m) {
    toast.error(t('device.record.failed'), { description: codeText('action.invalidResult') });
    return;
  }
  // Both the start and the stop reply carry the file: the first one adds it.
  if (useMedia.getState().recordings.some((r) => r.url === m.url)) return;
  const durationSec = m.durationSec ?? Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const rec = addRecording({ deviceId, url: m.url, file: m.file, ts: startedAt, durationSec });
  toast.success(t('device.record.done'), {
    description: m.endedBy === 'limit' ? t('device.record.limitReached') : undefined,
    action: { label: t('device.record.open'), onClick: () => window.open(rec.url, '_blank', 'noopener') },
  });
}

function recordingFailed(deviceId: string, kind: RecordingFailure['kind'], err: unknown): void {
  const d = describeError(err);
  if (d.code === 'command.aborted') return;
  toast.error(t(kind === 'start' ? 'device.record.failed' : 'device.record.stopFailed'), { description: d.text });
  setRecordingError(deviceId, { kind, error: err });
}

/* ───────────── Installed apps ───────────── */

export interface InstalledAppsEntry {
  apps?: InstalledApp[];
  includeSystem: boolean;
  /** Android user the list is for (absent = the phone's default; set only on phones with several users). */
  userId?: number;
  loading: boolean;
  /** The caught error (described at render time, so it follows the UI language). */
  error?: unknown;
  loadedAt?: number;
}

export const useInstalledApps = create<{ byDevice: Record<string, InstalledAppsEntry> }>()(() => ({ byDevice: {} }));

const inflight = new Map<string, Promise<void>>();

function patch(deviceId: string, p: Partial<InstalledAppsEntry>): void {
  useInstalledApps.setState((s) => {
    const prev = s.byDevice[deviceId] ?? { includeSystem: false, loading: false };
    return { byDevice: { ...s.byDevice, [deviceId]: { ...prev, ...p } } };
  });
}

/** Load (or reload) `list-apps` for a device (and Android user). Errors are stored on the entry (never thrown). */
export function loadInstalledApps(deviceId: string, includeSystem: boolean, userId?: number): Promise<void> {
  const key = `${deviceId}|${includeSystem}|${userId ?? ''}`;
  const running = inflight.get(key);
  if (running) return running;
  patch(deviceId, { loading: true, includeSystem, userId, error: undefined });
  const params = userId === undefined ? { includeSystem } : { includeSystem, userId };
  const p = sendCommand({ name: 'device.action', deviceId, action: 'list-apps', params })
    .then((data) => patch(deviceId, { apps: parseInstalledApps(data), loading: false, loadedAt: Date.now(), error: undefined }))
    .catch((err: unknown) => patch(deviceId, { loading: false, error: err ?? new Error('list-apps failed') }))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ───────────── Android user ───────────── */

/** The Android user picked per device (phones with a work profile or several users); absent = the phone's default. */
export const useDeviceUser = create<{ byDevice: Record<string, number> }>()(() => ({ byDevice: {} }));

export function setDeviceUser(deviceId: string, userId: number): void {
  useDeviceUser.setState((s) => ({ byDevice: { ...s.byDevice, [deviceId]: userId } }));
}

/** `userId` for app actions: the picked user, else the one in the foreground; undefined on a phone with one user. */
export function useSelectedUser(device: Pick<DeviceInfo, 'id' | 'users'>): number | undefined {
  const picked = useDeviceUser((s) => s.byDevice[device.id]);
  return selectedUserId(device, picked);
}

/* ───────────── Device report (Android `bug-report`) ───────────── */

export interface DeviceReportFile {
  deviceId: string;
  url: string;
  file?: string;
  bytes: number;
  durationSec: number;
  ts: number;
}

/** Reports this window asked for (in flight), and the finished files of this session. */
export const useDeviceReports = create<{ running: Record<string, number>; files: DeviceReportFile[] }>()(() => ({ running: {}, files: [] }));

function setReportRun(deviceId: string, startedAt: number | undefined): void {
  useDeviceReports.setState((s) => {
    const running = { ...s.running };
    if (startedAt === undefined) delete running[deviceId];
    else running[deviceId] = startedAt;
    return { running };
  });
}

/**
 * `bug-report`: replies once the .zip is ready (1–3 minutes, up to 15). Runs outside the card, so switching tabs
 * does not lose it; progress comes with `DeviceInfo.bugReport`.
 */
export async function takeDeviceReport(deviceId: string): Promise<void> {
  if (useDeviceReports.getState().running[deviceId]) return;
  const startedAt = Date.now();
  setReportRun(deviceId, startedAt);
  try {
    const data = await sendCommand({ name: 'device.action', deviceId, action: 'bug-report', params: {} }, { timeoutMs: 16 * 60_000 });
    const r = deviceReportResult(data);
    if (!r) {
      toast.error(t('device.bugReport.failed'), { description: codeText('action.invalidResult') });
      return;
    }
    const file: DeviceReportFile = { deviceId, ...r, ts: startedAt };
    useDeviceReports.setState((s) => ({ files: [file, ...s.files].slice(0, 10) }));
    toast.success(t('device.bugReport.done'), { action: { label: t('device.bugReport.download'), onClick: () => window.open(file.url, '_blank', 'noopener') } });
  } catch (err) {
    const d = describeError(err);
    if (d.code === 'action.bugReport.cancelled') toast.info(t('device.bugReport.cancelled'));
    else if (d.code !== 'command.aborted') toast.error(t('device.bugReport.failed'), { description: d.text });
  } finally {
    setReportRun(deviceId, undefined);
  }
}

export async function cancelDeviceReport(deviceId: string): Promise<void> {
  try {
    await sendCommand({ name: 'device.action', deviceId, action: 'bug-report-cancel', params: {} });
  } catch (err) {
    const d = describeError(err);
    // Already finished or never ran: nothing to stop.
    if (d.code !== 'action.bugReport.notRunning') toast.error(t('device.bugReport.cancelFailed'), { description: d.text });
  }
}
