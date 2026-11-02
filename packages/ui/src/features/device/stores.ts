/**
 * Session-scoped Device view state that must survive tab switches and device changes but not reloads:
 * the screenshot / recording gallery and the installed-apps cache per device.
 */
import { create } from 'zustand';
import type { InstalledApp } from '@durbun/protocol';
import { sendCommand } from '../../data';
import { parseInstalledApps } from './model';

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
