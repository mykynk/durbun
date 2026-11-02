/** Pure parsers for adb command output (unit-tested with real-world samples). */
import type { ConnectionType, DeviceState } from '@durbun/protocol';
import { posixBasename } from '../shared/text';

/* ───────────── adb devices -l ───────────── */

export interface AdbDeviceRow {
  serial: string;
  /** Raw adb state: device, offline, unauthorized, authorizing, connecting, no permissions, recovery, … */
  state: string;
  props: Record<string, string>;
}

export function parseAdbDevices(text: string): AdbDeviceRow[] {
  const rows: AdbDeviceRow[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || line.startsWith('List of devices')) continue;
    if (line.startsWith('adb server') || line.startsWith('adb: ') || line.startsWith('error:')) continue;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const serial = m[1]!;
    let rest = m[2]!;
    let state: string;
    if (rest.startsWith('no permissions')) {
      const close = rest.indexOf(')');
      state = 'no permissions';
      rest = close !== -1 ? rest.slice(close + 1) : rest.slice('no permissions'.length);
    } else {
      const sp = rest.search(/\s/);
      state = sp === -1 ? rest : rest.slice(0, sp);
      rest = sp === -1 ? '' : rest.slice(sp + 1);
    }
    const props: Record<string, string> = {};
    for (const tok of rest.split(/\s+/)) {
      const c = tok.indexOf(':');
      if (c > 0) props[tok.slice(0, c)] = tok.slice(c + 1);
    }
    rows.push({ serial, state, props });
  }
  return rows;
}

export function mapAdbState(state: string): DeviceState {
  switch (state) {
    case 'device':
      return 'online';
    case 'unauthorized':
    case 'authorizing':
    case 'no permissions':
      return 'unauthorized';
    default:
      return 'offline';
  }
}

export function isEmulatorSerial(serial: string): boolean {
  return serial.startsWith('emulator-');
}

/** USB, Wi-Fi (ip:port, mDNS service names) or local (emulator / localhost forward). */
export function connectionForSerial(serial: string): ConnectionType {
  if (isEmulatorSerial(serial)) return 'local';
  if (/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(serial)) return 'local';
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial)) return 'wifi';
  if (/^\[[0-9a-fA-F:.%\w]+\]:\d+$/.test(serial)) return 'wifi';
  if (/\._adb(-tls-connect)?\._tcp\.?$/.test(serial) || serial.includes('._adb-tls-connect._tcp')) return 'wifi';
  return 'usb';
}

/* ───────────── getprop / settings / wm / battery ───────────── */

export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]: \[(.*)\]\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export interface ScreenInfo {
  width: number;
  height: number;
  /** Scale factor (dpi / 160). */
  density?: number;
}

/** `wm size` + `wm density` output (override values win). */
export function parseWmOutput(text: string): ScreenInfo | undefined {
  let size: [number, number] | undefined;
  let override: [number, number] | undefined;
  let dpi: number | undefined;
  let overrideDpi: number | undefined;
  for (const line of text.split('\n')) {
    let m = /^\s*(Physical|Override) size:\s*(\d+)x(\d+)/.exec(line);
    if (m) {
      const v: [number, number] = [Number(m[2]), Number(m[3])];
      if (m[1] === 'Override') override = v;
      else size = v;
      continue;
    }
    m = /^\s*(Physical|Override) density:\s*(\d+)/.exec(line);
    if (m) {
      if (m[1] === 'Override') overrideDpi = Number(m[2]);
      else dpi = Number(m[2]);
    }
  }
  const s = override ?? size;
  if (!s) return undefined;
  const d = overrideDpi ?? dpi;
  const info: ScreenInfo = { width: s[0], height: s[1] };
  if (d) info.density = Math.round((d / 160) * 1000) / 1000;
  return info;
}

/** `dumpsys battery`. */
export function parseBattery(text: string): { level: number; charging: boolean } | undefined {
  const get = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(text);
    return m ? m[1] : undefined;
  };
  const levelStr = get('level');
  if (levelStr === undefined) return undefined;
  const level = Number(levelStr);
  const scale = Number(get('scale') ?? '100') || 100;
  if (!Number.isFinite(level)) return undefined;
  const status = Number(get('status') ?? '0');
  const plugged = ['AC powered', 'USB powered', 'Wireless powered', 'Dock powered'].some((k) => get(k) === 'true');
  return {
    level: Math.max(0, Math.min(100, Math.round((level / scale) * 100))),
    charging: status === 2 || (plugged && status === 5),
  };
}

/* ───────────── processes ───────────── */

function normalizeProcessName(name: string): string {
  return name.startsWith('/') ? posixBasename(name) : name;
}

/**
 * `ps -A -o PID,NAME` (toybox, Android 8+) or legacy toolbox `ps`
 * ("USER PID PPID VSIZE RSS WCHAN PC NAME").
 */
export function parsePs(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const lines = text.split('\n');
  let pidIdx = -1;
  let twoColumn = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (pidIdx === -1) {
      const i = tokens.indexOf('PID');
      if (i !== -1) {
        pidIdx = i;
        twoColumn = tokens.length === 2 && tokens[1] === 'NAME';
      }
      continue;
    }
    const pid = Number(tokens[pidIdx]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = twoColumn ? tokens.slice(1).join(' ') : tokens[tokens.length - 1]!;
    if (name) map.set(pid, normalizeProcessName(name));
  }
  return map;
}

/** `pidof <name>` → first pid, or undefined. */
export function parsePidof(text: string): number | undefined {
  const tok = text.trim().split(/\s+/)[0];
  const n = Number(tok);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/* ───────────── adb reverse / forward ───────────── */

export interface PortMapping {
  local: string;
  remote: string;
}

/** `adb reverse --list` / `adb forward --list` lines: "<serial|transport> tcp:A tcp:B". */
export function parsePortMappings(text: string): PortMapping[] {
  const out: PortMapping[] = [];
  for (const line of text.split('\n')) {
    const m = /(\S+:\S+)\s+(\S+:\S+)\s*$/.exec(line.trim());
    if (m && /^(tcp|localabstract|localreserved|localfilesystem|jdwp|vsock|dev):/.test(m[1]!)) {
      out.push({ local: m[1]!, remote: m[2]! });
    }
  }
  return out;
}

/** `adb forward tcp:0 tcp:N` prints the allocated local port. */
export function parseForwardPort(text: string): number | undefined {
  const m = /^\s*(\d{2,5})\s*$/m.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 65536 ? n : undefined;
}

/* ───────────── packages ───────────── */

/** `pm list packages [-3]` → package ids. */
export function parsePackageList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^package:(?:.*=)?([A-Za-z0-9_.]+)\s*$/.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

export interface PackageMeta {
  version?: string;
  debuggable?: boolean;
}

/**
 * Filtered `dumpsys package packages` output:
 *   "  Package [com.example.app] (1a2b3c):" / "    versionName=1.0.0" / "    flags=[ DEBUGGABLE HAS_CODE … ]"
 */
export function parsePackageDump(text: string): Map<string, PackageMeta> {
  const out = new Map<string, PackageMeta>();
  let current: PackageMeta | undefined;
  for (const line of text.split('\n')) {
    const pm = /^\s*Package \[([^\]]+)\]/.exec(line);
    if (pm) {
      current = out.get(pm[1]!) ?? {};
      out.set(pm[1]!, current);
      continue;
    }
    if (!current) continue;
    const vm = /^\s*versionName=(.*?)\s*$/.exec(line);
    if (vm) {
      if (!current.version && vm[1]) current.version = vm[1];
      continue;
    }
    const fm = /^\s*(?:pkg)?[Ff]lags=\[(.*)\]/.exec(line);
    if (fm && current.debuggable === undefined) {
      current.debuggable = /\bDEBUGGABLE\b/.test(fm[1]!);
    }
  }
  return out;
}

/* ───────────── /proc metrics ───────────── */

export interface ProcStat {
  /** utime + stime in clock ticks. */
  cpuTicks: number;
  threads?: number;
}

/** `/proc/<pid>/stat` (comm may contain spaces and parentheses). */
export function parseProcStat(text: string): ProcStat | undefined {
  const line = text.split('\n').find((l) => /^\d+ \(/.test(l));
  if (!line) return undefined;
  const close = line.lastIndexOf(')');
  if (close === -1) return undefined;
  const fields = line.slice(close + 2).split(' ');
  // fields[0] = state (field 3); utime = field 14, stime = field 15, num_threads = field 20
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  const threads = Number(fields[17]);
  return { cpuTicks: utime + stime, threads: Number.isFinite(threads) ? threads : undefined };
}

/** "VmRSS:	  123456 kB" → MB. */
export function parseVmRssMB(text: string): number | undefined {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : undefined;
}

/** CPU % of one core from two cumulative tick readings (USER_HZ = 100 on Android). */
export function cpuPercent(prevTicks: number, ticks: number, elapsedMs: number, hz = 100): number | undefined {
  if (elapsedMs <= 0 || ticks < prevTicks) return undefined;
  const pct = ((ticks - prevTicks) / hz / (elapsedMs / 1000)) * 100;
  return Math.round(pct * 10) / 10;
}
