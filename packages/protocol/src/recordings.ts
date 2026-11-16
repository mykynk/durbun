/**
 * Session recorder (SPEC §13): every run of the Dürbün server is written to the Mac's disk while it captures, so
 * a session can be opened again after Dürbün quit or crashed. Nothing leaves the Mac; recordings are not part of
 * backups or `.durbun` packages.
 *
 *   GET    /api/recordings                  SessionRecordingList (newest first, the recorder's status)
 *   DELETE /api/recordings                  every recording except the one being written → SessionRecordingList
 *   DELETE /api/recordings/:id              one recording → SessionRecordingList (409 recorder.live for this run's)
 *   GET    /api/recordings/:id/export       SessionExport download (masked unless mask=0), what opening it shows
 *   POST   /api/recordings/:id/open         SessionRecordingOpen: loads it into its own read-only view
 *   DELETE /api/recordings/:id/open         { ok: true }: the view is closed and its memory freed
 *
 * An opened recording is never mixed into the live data: a window shows it by connecting `WS /ui?view=<id>` and
 * adding `view=<id>` to the network / HAR / export / bug report requests; the hello then carries `recording`.
 * Settings: ServerSettings.recordSessions / recordingsMaxDays / recordingsMaxMB (absent = the defaults below).
 */
import type { DevicePlatform, I18nParams } from './index';

/** Limits of the recordings folder when the settings do not name others. */
export const RECORDING_DEFAULTS = {
  /** Recordings whose last write is older than this go. */
  maxDays: 7,
  /** All recordings together (MB on disk, compressed); the oldest go first. */
  maxMB: 1024,
  /** One recording at most (MB on disk); past it the recording's oldest part goes. Never above half of maxMB. */
  recordingMB: 256,
} as const;

/** Inclusive ranges of the two settings (values outside are clamped by the server). */
export const RECORDING_LIMITS = {
  recordingsMaxDays: { min: 1, max: 90 },
  recordingsMaxMB: { min: 100, max: 51_200 },
} as const;

/** One recording as the list shows it. */
export interface SessionRecording {
  /** Folder name: start time (UTC) + 4 hex, e.g. "20261115T184012Z-a1b2". */
  id: string;
  startedAt: number;
  /** The newest data written (epoch ms). */
  lastWriteAt: number;
  /** When the recording was closed (Dürbün quit, recording turned off); interrupted ones: the last write. */
  endedAt?: number;
  /**
   * 'recording': this run, still being written · 'ended': closed normally · 'interrupted': Dürbün stopped without
   * closing it (a crash, a forced quit, a power loss); its last seconds may be missing.
   */
  state: 'recording' | 'ended' | 'interrupted';
  /** Size on disk. */
  bytes: number;
  /** Lines, requests, error lines (error / fatal), crashes (crash / ANR lines). Interrupted: may miss the last seconds. */
  counts: { logs: number; requests: number; errors: number; crashes: number };
  /** Devices that sent something (at most 20). */
  devices: { id: string; name: string; platform: DevicePlatform }[];
  /** App sessions (SDK / VM) seen, one per app and device (at most 20). */
  apps: { name: string; bundleId: string; deviceId: string; version?: string }[];
  /** The per-recording limit removed its oldest part. */
  trimmed?: boolean;
  /** Records that arrived while writing was paused and are missing. */
  gaps?: number;
  serverVersion?: string;
}

/** Why the recorder does not write right now (an i18n code with params and the English text). */
export interface RecorderPause {
  /** recorder.diskFull {dir} · recorder.diskLow {free} · recorder.noAccess {dir, error} · recorder.writeFailed {error} · recorder.tooSlow */
  code: string;
  params?: I18nParams;
  message: string;
  since: number;
}

export interface RecorderStatus {
  /** ServerSettings.recordSessions (absent = on). */
  enabled: boolean;
  /** 'off' · 'waiting': on, nothing captured yet this run · 'recording' · 'paused': writing stopped (`paused` says why). */
  state: 'off' | 'waiting' | 'recording' | 'paused';
  paused?: RecorderPause;
  /** Id of the recording being written. */
  current?: string;
  /** The recordings folder (absolute). */
  dir: string;
  /** Every recording together, on disk. */
  usedBytes: number;
  maxDays: number;
  maxBytes: number;
  /** Per recording. */
  maxRecordingBytes: number;
}

export interface SessionRecordingList {
  status: RecorderStatus;
  /** Newest first. */
  recordings: SessionRecording[];
  /** The newest recording of an earlier run (what "Open the previous session" opens). */
  previous?: string;
}

/** POST /api/recordings/:id/open. */
export interface SessionRecordingOpen {
  recording: SessionRecording;
  /** What the view holds. */
  loaded: { logs: number; requests: number };
  /** The older part left out: the view holds the newest data within the live memory limits. */
  left: { logs: number; requests: number };
  /** Lines that could not be read (a torn end after a crash). */
  damaged?: number;
}
