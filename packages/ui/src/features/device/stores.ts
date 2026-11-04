/**
 * Session-scoped Device view state that must survive tab switches and device changes but not reloads:
 * the screenshot / recording gallery, running screen recordings and the installed-apps cache per device.
 */
import { create } from 'zustand';
import type { InstalledApp } from '@durbun/protocol';
import { toast } from '../../components';
import { sendCommand } from '../../data';
import { t } from '../../i18n';
import { codeText, describeError } from './codes';
import { parseInstalledApps, recordResult } from './model';

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

/** Load (or reload) `list-apps` for a device. Errors are stored on the entry (never thrown). */
export function loadInstalledApps(deviceId: string, includeSystem: boolean): Promise<void> {
  const key = `${deviceId}|${includeSystem}`;
  const running = inflight.get(key);
  if (running) return running;
  patch(deviceId, { loading: true, includeSystem, error: undefined });
  const p = sendCommand({ name: 'device.action', deviceId, action: 'list-apps', params: { includeSystem } })
    .then((data) => patch(deviceId, { apps: parseInstalledApps(data), loading: false, loadedAt: Date.now(), error: undefined }))
    .catch((err: unknown) => patch(deviceId, { loading: false, error: err ?? new Error('list-apps failed') }))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
