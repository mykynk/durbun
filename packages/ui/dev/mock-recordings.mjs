// /api/recordings of the dev mock: session recordings (SPEC §13), same routes, shapes and codes as the server
// (packages/server/src/recordings/routes.ts; checked by packages/server/test/http/recordingsContract.test.ts).
// Seeded with yesterday evening's session (the launch offer), one that was interrupted and an older trimmed one;
// the session of this mock run is "being recorded". `--recordings empty` starts with none, `--recordings paused`
// pauses recording (disk almost full), `--recordings off` starts with recording turned off.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;
const RECORDING_ID = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

const p2 = (n) => String(n).padStart(2, '0');
function recordingId(ms, suffix) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z-${suffix}`;
}
function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}
/** Yesterday at hh:mm local time. */
function daysAgoAt(days, hh, mm, now) {
  const d = new Date(now - days * DAY);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

const PIXEL = { id: 'android:emulator-5554', name: 'Pixel 8', platform: 'android' };
const IPHONE = { id: 'ios:00008120-001A2B3C4D5E6F70', name: 'Jane’s iPhone', platform: 'ios' };
const GALAXY = { id: 'android:R5CT20XYZ', name: 'Galaxy S23', platform: 'android' };

/**
 * @param {{ mode?: string, dir?: string, now?: number, liveDevices?: () => {id:string,name:string,platform:string}[], liveCounts?: () => {logs:number,requests:number,errors:number,crashes:number} }} opts
 */
export function createMockRecordings(opts = {}) {
  const now0 = opts.now ?? Date.now();
  const startedAt = now0;
  const dir = opts.dir ?? '~/Library/Application Support/Dürbün/recordings';
  let enabled = opts.mode !== 'off';
  let maxDays = 7;
  let maxMB = 1024;
  const paused = opts.mode === 'paused' ? { code: 'recorder.diskLow', params: { free: 0.7 * 1024 ** 3, min: 1024 ** 3 }, message: 'Recording paused: less than 1 GB is free on this Mac’s disk', since: now0 } : undefined;
  const liveId = recordingId(startedAt, 'a1b2');
  let liveClosedAt;

  const seeded = opts.mode === 'empty' ? [] : seed(now0);
  /** Closed recordings, newest first. */
  let closed = seeded;

  function seed(now) {
    const prevStart = daysAgoAt(1, 21, 40, now);
    const crashStart = daysAgoAt(2, 14, 5, now);
    const oldStart = daysAgoAt(5, 10, 12, now);
    return [
      {
        id: recordingId(prevStart, 'c3d4'),
        startedAt: prevStart,
        lastWriteAt: prevStart + 2 * HOUR + 14 * MIN,
        endedAt: prevStart + 2 * HOUR + 14 * MIN,
        state: 'ended',
        bytes: Math.round(48.2 * MB),
        counts: { logs: 12408, requests: 316, errors: 3, crashes: 1 },
        devices: [PIXEL, IPHONE],
        apps: [
          { name: 'Pati', bundleId: 'com.mykynk.pati', deviceId: PIXEL.id, version: '1.4.2' },
          { name: 'Kasa', bundleId: 'com.mykynk.kasa', deviceId: IPHONE.id, version: '2.0.1' },
        ],
        serverVersion: '0.3.0',
      },
      {
        id: recordingId(crashStart, 'e5f6'),
        startedAt: crashStart,
        lastWriteAt: crashStart + 37 * MIN,
        state: 'interrupted',
        bytes: Math.round(9.6 * MB),
        counts: { logs: 3120, requests: 88, errors: 12, crashes: 0 },
        devices: [GALAXY],
        apps: [{ name: 'Kumbara', bundleId: 'com.mykynk.kumbara', deviceId: GALAXY.id, version: '3.1.0' }],
        gaps: 412,
        serverVersion: '0.3.0',
      },
      {
        id: recordingId(oldStart, '0a1b'),
        startedAt: oldStart,
        lastWriteAt: oldStart + 6 * HOUR + 3 * MIN,
        endedAt: oldStart + 6 * HOUR + 3 * MIN,
        state: 'ended',
        bytes: 256 * MB,
        counts: { logs: 498_210, requests: 9_841, errors: 77, crashes: 2 },
        devices: [PIXEL],
        apps: [{ name: 'Pati', bundleId: 'com.mykynk.pati', deviceId: PIXEL.id, version: '1.4.0' }],
        trimmed: true,
        serverVersion: '0.3.0',
      },
    ];
  }

  function liveRecording() {
    const counts = opts.liveCounts?.() ?? { logs: 0, requests: 0, errors: 0, crashes: 0 };
    const devices = opts.liveDevices?.() ?? [];
    const lastWriteAt = liveClosedAt ?? Date.now();
    const bytes = Math.round(counts.logs * 140 + counts.requests * 2400) + 4096;
    return { id: liveId, startedAt, lastWriteAt, ...(liveClosedAt ? { endedAt: liveClosedAt } : {}), state: liveClosedAt ? 'ended' : 'recording', bytes, counts, devices, apps: [], serverVersion: '0.3.0' };
  }

  /** The recording of this run exists once recording was on (the mock always has content). */
  let liveExists = enabled && opts.mode !== 'empty';
  let liveDeleted = false;

  function all() {
    const out = [];
    if (liveExists && !liveDeleted) out.push(liveRecording());
    return [...out, ...closed];
  }
  const currentId = () => (enabled && !liveClosedAt && liveExists ? liveId : undefined);

  function status() {
    const used = all().reduce((s, r) => s + r.bytes, 0);
    const maxBytes = maxMB * MB;
    const state = !enabled ? 'off' : paused ? 'paused' : currentId() ? 'recording' : 'waiting';
    return {
      enabled,
      state,
      ...(state === 'paused' ? { paused } : {}),
      ...(currentId() ? { current: currentId() } : {}),
      dir,
      usedBytes: used,
      maxDays,
      maxBytes,
      maxRecordingBytes: Math.min(256 * MB, Math.floor(maxBytes / 2)),
    };
  }

  function list() {
    const recordings = all();
    const out = { status: status(), recordings };
    const previous = recordings.find((r) => r.id !== currentId() && r.startedAt < startedAt);
    if (previous) out.previous = previous.id;
    return out;
  }

  const find = (id) => all().find((r) => r.id === id);
  /** Opened views (id → SessionRecordingOpen). */
  const opened = new Map();

  function openResult(r) {
    const loaded = { logs: Math.min(r.counts.logs, 50_000), requests: Math.min(r.counts.requests, 5_000) };
    const out = { recording: r, loaded, left: { logs: r.counts.logs - loaded.logs, requests: r.counts.requests - loaded.requests } };
    if (r.state === 'interrupted') out.damaged = 1;
    return out;
  }

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(status === 204 ? undefined : JSON.stringify(body));
  }
  const unknown = (res) => json(res, 404, { error: 'Recording not found', code: 'recorder.unknown' });
  const notAllowed = (res, allow) => json(res, 405, { error: 'Method not allowed', code: 'method.notAllowed' }, { Allow: allow });

  /**
   * Handles /api/recordings…; returns false for other paths. `exportOf(recording, mask)` builds the session file
   * (the mock exports its frozen copy).
   */
  function handle(req, res, pathname, query, { exportOf, onDeleted } = {}) {
    if (pathname !== '/api/recordings' && !pathname.startsWith('/api/recordings/')) return false;
    const segs = pathname.split('/').filter(Boolean).slice(1).map((s) => decodeURIComponent(s));
    const method = req.method ?? 'GET';
    const [, id, action] = segs;
    if (segs.length === 1) {
      if (method === 'GET' || method === 'HEAD') return json(res, 200, list()), true;
      if (method === 'DELETE') {
        const gone = [...closed.map((r) => r.id), ...(liveClosedAt && !liveDeleted ? [liveId] : [])];
        closed = [];
        if (liveClosedAt) liveDeleted = true;
        for (const g of gone) {
          opened.delete(g);
          onDeleted?.(g);
        }
        return json(res, 200, list()), true;
      }
      return notAllowed(res, 'GET, HEAD, DELETE'), true;
    }
    if (segs.length === 2 && id) {
      if (method !== 'DELETE') return notAllowed(res, 'DELETE'), true;
      if (!RECORDING_ID.test(id)) return unknown(res), true;
      if (id === currentId()) return json(res, 409, { error: 'This recording is still being written: turn recording off first', code: 'recorder.live' }), true;
      if (id === liveId && liveClosedAt && !liveDeleted) liveDeleted = true;
      else if (closed.some((r) => r.id === id)) closed = closed.filter((r) => r.id !== id);
      else return unknown(res), true;
      opened.delete(id);
      onDeleted?.(id);
      return json(res, 200, list()), true;
    }
    if (segs.length === 3 && id && action === 'export') {
      if (method !== 'GET') return notAllowed(res, 'GET'), true;
      const r = RECORDING_ID.test(id) ? find(id) : undefined;
      if (!r) return unknown(res), true;
      if (r.state === 'recording') return json(res, 409, { error: 'This recording is the session being captured now: export the live data instead', code: 'recorder.live' }), true;
      const mask = query.get('mask') !== '0';
      const body = exportOf ? exportOf(r, mask) : { format: 'durbun-session', version: 1, exportedAt: Date.now(), masked: mask, devices: [], apps: [], logs: [], network: [], metrics: [] };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="durbun-recording-${fileStamp(r.startedAt)}.durbun.json"`, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body, null, 2));
      return true;
    }
    if (segs.length === 3 && id && action === 'open') {
      if (method === 'POST') {
        if (!RECORDING_ID.test(id)) return unknown(res), true;
        if (id === currentId()) return json(res, 409, { error: 'This recording is the session being captured now: its data is the live data', code: 'recorder.live' }), true;
        const r = find(id);
        if (!r) return unknown(res), true;
        const out = openResult(r);
        opened.set(id, out);
        setTimeout(() => json(res, 200, out), 450);
        return true;
      }
      if (method === 'DELETE') return json(res, 200, { ok: true }), true;
      return notAllowed(res, 'POST, DELETE'), true;
    }
    json(res, 404, { error: 'Not found', code: 'api.notFound' });
    return true;
  }

  return {
    handle,
    list,
    /** The opened recording a `view=<id>` points at (loaded on demand, like the server), or undefined. */
    view(id) {
      if (!id || !RECORDING_ID.test(id) || id === currentId()) return undefined;
      const known = opened.get(id);
      if (known) return known;
      const r = find(id);
      if (!r) return undefined;
      const out = openResult(r);
      opened.set(id, out);
      return out;
    },
    /** settings.update: recordSessions / recordingsMaxDays / recordingsMaxMB. */
    applySettings(s) {
      if (typeof s.recordingsMaxDays === 'number') maxDays = s.recordingsMaxDays;
      if (typeof s.recordingsMaxMB === 'number') maxMB = s.recordingsMaxMB;
      if (s.recordSessions === false && enabled) {
        enabled = false;
        if (liveExists) liveClosedAt = Date.now();
      } else if (s.recordSessions === true && !enabled) {
        enabled = true;
      }
    },
  };
}
