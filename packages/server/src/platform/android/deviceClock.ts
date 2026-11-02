/**
 * Device wall-clock helpers. `dumpsys package` (firstInstallTime / lastUpdateTime) and `dumpsys dropbox`
 * print LOCAL device time as "yyyy-MM-dd HH:mm:ss" without a zone, so we convert with the device's
 * time zone: `persist.sys.timezone` (IANA name → correct offset for any date, DST included) when Node
 * knows it, else the current `date +%z` offset, else the host's local zone.
 */

export interface DeviceClock {
  /** IANA zone from `getprop persist.sys.timezone`, e.g. "Europe/Istanbul". */
  tzName?: string;
  /** Current UTC offset from `date +%z` in minutes (+0300 → 180). */
  offsetMinutes?: number;
}

/** "+0300" / "-0430" → minutes, or undefined. */
export function parseUtcOffset(text: string | undefined): number | undefined {
  const m = /^\s*([+-])(\d\d):?(\d\d)\s*$/.exec(text ?? '');
  if (!m) return undefined;
  const v = Number(m[2]) * 60 + Number(m[3]);
  if (v > 14 * 60) return undefined;
  return m[1] === '-' ? -v : v;
}

/** A plausible IANA zone name (validated against Node's ICU on use). */
export function parseTzName(text: string | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (!t || t.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(t)) return undefined;
  return formatter(t) ? t : undefined;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(tz);
  if (cached !== undefined) return cached;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    f = null;
  }
  if (formatters.size > 32) formatters.clear();
  formatters.set(tz, f);
  return f;
}

/** Offset (ms) of `tz` at the instant `utcMs` (whole seconds). */
function zoneOffsetMs(utcMs: number, f: Intl.DateTimeFormat): number {
  const parts = f.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?$/;

/** "2026-11-02 11:43:03" (device local time) → epoch ms, or undefined for anything else. */
export function deviceLocalToEpoch(text: string | undefined, clock: DeviceClock = {}): number | undefined {
  const m = LOCAL_RE.exec((text ?? '').trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return undefined;
  const frac = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // Year 1970 (epoch 0 printed in local time) means "unknown" in PackageManager dumps.
  if (y < 2000) return undefined;
  const f = clock.tzName ? formatter(clock.tzName) : null;
  if (f) {
    try {
      const first = wall - zoneOffsetMs(wall, f);
      return wall - zoneOffsetMs(first, f) + frac;
    } catch {
      /* fall through */
    }
  }
  if (clock.offsetMinutes !== undefined) return wall - clock.offsetMinutes * 60_000 + frac;
  return new Date(y, mo - 1, d, h, mi, s).getTime() + frac;
}
