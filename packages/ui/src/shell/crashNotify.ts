import { useEffect } from 'react';
import type { LogEntry } from '@durbun/protocol';
import { isCrashEntry, keptAfter, logStore, type LogStore } from '../data/logStore';
import { isImportedDevice, useHub } from '../data/stores/hub';
import { ui } from '../data/stores/ui';
import { bugReport } from '../features/report/store';
import { getPrefs } from '../data/stores/prefs';
import { isLiveEntry, isQuietCrashRecord, mergeCrashes } from '../features/logs/live';
import { deviceAppForEntry, sessionForEntry } from '../features/logs/model/appOf';
import { deviceDisplayName } from '../i18n';
import { notifyDesktop } from '../lib/notify';

/** At most one notification in this window: a crash loop does not flood the notification centre. */
export const NOTIFY_GAP_MS = 5000;

/**
 * Calls `onCrash` once for every NEW live crash, ANR or Flutter error on any device, whatever the scope and the
 * open tab (SPEC §1.1 #7, crashes are loud). Not: replayed history, imported recordings, device crash records the
 * server matched to a live line or that predate Dürbün, and the device's copy of a crash the app already reported.
 * Returns the unsubscribe function.
 */
export function watchLiveCrashes(store: Pick<LogStore, 'entries' | 'kept' | 'generation' | 'lastId' | 'lowerBound' | 'subscribe'>, onCrash: (e: LogEntry) => void): () => void {
  let recent: LogEntry[] = [];
  let gen = store.generation;
  let cursor = store.lastId;
  const wanted = (e: LogEntry) => isCrashEntry(e) && isLiveEntry(e) && !isImportedDevice(e.deviceId) && !isQuietCrashRecord(e);
  return store.subscribe(() => {
    if (store.generation !== gen) {
      gen = store.generation;
      // A resync replaced the store (ids restart after a server restart): replayed history is skipped by isLiveEntry.
      if (store.lastId < cursor) cursor = 0;
    }
    const entries = store.entries;
    const from = store.lowerBound(cursor + 1);
    const trimmed = keptAfter(store.kept, cursor);
    if (from >= entries.length && trimmed.length === 0) return;
    const found: LogEntry[] = [];
    for (const e of trimmed) if (wanted(e)) found.push(e);
    for (let i = from; i < entries.length; i++) if (wanted(entries[i]!)) found.push(entries[i]!);
    cursor = Math.max(cursor, entries.length > 0 ? entries[entries.length - 1]!.id : 0, trimmed.length > 0 ? trimmed[trimmed.length - 1]!.id : 0);
    if (found.length === 0) return;
    const fresh: LogEntry[] = [];
    recent = mergeCrashes(recent, found, fresh);
    for (const e of fresh) onCrash(e);
  });
}

/** A click on the notification: the crash line in Logs, with "Report a bug" open on it. */
function openCrash(logId: number): void {
  ui.focusLog(logId);
  bugReport.open({ kind: 'log', logId });
}

/** Desktop notification for live crashes on any connected device, from app start (mounted once in App). */
export function useCrashNotifications(): void {
  useEffect(() => {
    let last = 0;
    return watchLiveCrashes(logStore, (e) => {
      if (!getPrefs().notifyOnCrash) return;
      const now = Date.now();
      if (now - last < NOTIFY_GAP_MS) return;
      last = now;
      const { apps, deviceApps, devices } = useHub.getState();
      const session = sessionForEntry(e, apps);
      const da = session ? undefined : deviceAppForEntry(e, deviceApps);
      const appName = session?.app.name || da?.name || da?.id;
      const device = devices[e.deviceId];
      void import('../features/logs/crashNotice')
        .then(({ crashNotice }) => {
          const { title, body } = crashNotice(e, appName, device ? deviceDisplayName(device) : undefined);
          notifyDesktop(title, { body, tag: 'durbun-crash', onClick: () => openCrash(e.id) });
        })
        .catch(() => {
          /* the chunk could not load (dev server restart): no notification is better than an error */
        });
    });
  }, []);
}
