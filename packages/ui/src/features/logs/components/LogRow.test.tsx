import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LogEntry } from '@durbun/protocol';
import '../../../i18n';
import '../i18n';
import { setLanguage } from '../../../i18n/core';
import { buildHighlighter } from '../model/highlight';
import { EXPAND_LINES, LogRowView, type RowDisplay } from './LogRow';
import type { LogRow } from '../model/types';

const d: RowDisplay = {
  timeFormat: 'absolute',
  wrap: false,
  lang: 'tr',
  hl: buildHighlighter([], []),
  impliedProcesses: new Set(),
  identity: () => ({ dartPackages: [], javaPrefixes: [], modules: [] }),
  appName: () => 'Kumbara',
};

/** Today 22:20:02: an old record of today reads as a clock only (`crashWhen` adds the date on other days). */
const T0 = (() => {
  const x = new Date();
  x.setHours(22, 20, 2, 0);
  return x.getTime();
})();
const line = (p: Partial<LogEntry> & { id: number }): LogEntry => ({ ts: T0, deviceId: 'ios:1', source: 'device', level: 'info', tag: 't', message: 'm', ...p });
const show = (row: LogRow, dd: RowDisplay = d, expanded = 0) => render(<LogRowView row={row} time="22:20:02" selected={false} expanded={expanded} flash={false} d={dd} />);

afterEach(() => {
  cleanup();
  setLanguage('en');
});

describe('rows of several devices', () => {
  it('carry a device chip and name the device first in the source tooltip', () => {
    setLanguage('tr');
    const e = line({ id: 1, origin: 'logcat', deviceId: 'demo:1' });
    const { container } = show({ id: 1, e, n: 1 }, { ...d, device: (x) => (x.deviceId === 'demo:1' ? { name: 'Pixel 8 · Demo', hue: 212 } : undefined) });
    expect(container.querySelector('.lg-dev')?.textContent).toBe('Pixel 8 · Demo');
    expect(container.querySelector('.lg-src')?.getAttribute('title')).toBe('Pixel 8 · Demo · Cihaz logu · logcat');
  });

  it('have no chip while one device fills the list', () => {
    const { container } = show({ id: 1, e: line({ id: 1, origin: 'logcat' }), n: 1 });
    expect(container.querySelector('.lg-dev')).toBeNull();
    expect(container.querySelector('.lg-src')?.getAttribute('title')).not.toMatch(/Pixel/);
  });
});

describe('crash rows', () => {
  it('show the crashed build of the device’s record, also on the live row it duplicates', () => {
    setLanguage('tr');
    const live = line({ id: 5, kind: 'crash', level: 'fatal', origin: 'idevicesyslog', message: 'Runner crashed' });
    const rec = line({ id: 6, kind: 'crash', level: 'fatal', origin: 'crash-report', message: 'Kumbara 3.1.0 (310) crashed: EXC_BAD_ACCESS', data: { origin: 'crash-report', version: '3.1.0', build: '310', duplicateOf: 5 } });
    const { container } = show({ id: 5, e: live, n: 1, rec });
    const chip = container.querySelector('.lg-crash__build')!;
    expect(chip.textContent).toBe('3.1.0 (310)');
    expect(chip.getAttribute('title')).toMatch(/^3\.1\.0 \(310\) sürümünde çöktü · Cihazın çökme kaydından$/);
  });

  it('call an old device record “before watching” and mark a native tombstone unsymbolicated', () => {
    setLanguage('tr');
    const tomb = line({
      id: 7,
      kind: 'crash',
      level: 'fatal',
      origin: 'dropbox',
      deviceId: 'android:1',
      tag: 'data_app_native_crash',
      message: 'Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)',
      data: { origin: 'dropbox', dropboxTag: 'data_app_native_crash', previousLaunch: true, reportTs: T0 },
    });
    show({ id: 7, e: tomb, n: 1 });
    expect(screen.getByText(/İzlemeden önce · 22:20:02$/)).toBeTruthy();
    expect(screen.getByText('sembolsüz')).toBeTruthy();
    expect(screen.queryByText(/Önceki açılışta/)).toBeNull();
  });
});

describe('a flapping connection', () => {
  const sep = (id: number, code: string, s: number): LogEntry => ({ ...line({ id, ts: T0 + s * 1000 }), source: 'system', kind: 'lifecycle', code, params: { device: 'Yusuf iPhone’u', deviceId: 'ios:1' }, message: code });

  it('reads as one line and lists the events when expanded', () => {
    setLanguage('tr');
    const events: LogEntry[] = [];
    for (let i = 0; i < 6; i++) events.push(sep(10 + i * 2, 'device.disconnected', i * 8), sep(11 + i * 2, 'device.connected', i * 8 + 2));
    const last = events[events.length - 1]!;
    const row: LogRow = { id: last.id, e: last, n: 1, flap: { key: events[0]!.id, events } };
    const { container } = show(row);
    expect(container.querySelector('.lg-sep__text')?.textContent).toBe('Yusuf iPhone’u: bağlantı 6 kez koptu ve geri geldi · 42 sn içinde');
    expect(container.querySelector('.lg-flap')).toBeNull();
    cleanup();
    const open = show(row, d, EXPAND_LINES);
    expect(open.container.querySelectorAll('.lg-flap__ev')).toHaveLength(12);
    expect(open.container.querySelector('.lg-flap__hint')?.textContent).toMatch(/USB kablosu/);
  });

  it('one drop that came back says how long it took', () => {
    setLanguage('en');
    const events = [sep(1, 'device.disconnected', 0), sep(2, 'device.connected', 5), sep(3, 'logs.streamStarted', 6)];
    const { container } = show({ id: 3, e: events[2]!, n: 1, flap: { key: 1, events } });
    expect(container.querySelector('.lg-sep__text')?.textContent).toBe('Yusuf iPhone’u: the connection dropped and came back after 5 s');
  });

  it('measures the outage, not the connected time before it, and names the device in any scope', () => {
    setLanguage('tr');
    const at = (id: number, code: string, ms: number): LogEntry => ({ ...sep(id, code, 0), ts: T0 + ms, params: { deviceId: 'ios:1' } });
    const events = [at(1, 'device.connected', 0), at(2, 'logs.streamStarted', 400), at(3, 'device.disconnected', 10_000), at(4, 'device.connected', 12_000), at(5, 'logs.streamStarted', 12_500)];
    // logs.* separators carry no device name: the hub's name comes through `deviceName` (one device, no chip).
    const { container } = show({ id: 5, e: events[4]!, n: 1, flap: { key: 1, events } }, { ...d, deviceName: (id) => (id === 'ios:1' ? 'Yusuf iPhone’u' : undefined) });
    expect(container.querySelector('.lg-sep__text')?.textContent).toBe('Yusuf iPhone’u: bağlantı koptu, 2 sn sonra geri geldi');
    expect(container.querySelector('.lg-repeat')).toBeNull();
  });

  it('prints one clock when the merged events fall in the same second', () => {
    const events = [sep(1, 'device.disconnected', 0), sep(2, 'device.connected', 0)];
    const { container } = show({ id: 2, e: events[1]!, n: 1, flap: { key: 1, events } });
    expect(container.querySelector('.lg-flaprow .lg-sep__time')?.textContent).toBe('22:20:02');
  });
});

describe('crash banner with several devices', () => {
  it('says which device crashed', async () => {
    const { CrashBanner } = await import('./Banners');
    setLanguage('tr');
    const e = line({ id: 9, kind: 'crash', level: 'fatal', source: 'app', deviceId: 'demo:1', message: 'Unhandled exception: Null check operator used on a null value' });
    const { container } = render(<CrashBanner crashes={[e]} appName={() => 'Pati'} device={() => ({ name: 'Pixel 8 · Demo', short: 'Pixel 8', hue: 152 })} onGoto={() => {}} onDismiss={() => {}} />);
    expect(container.querySelector('.lg-banner__title')?.textContent).toBe('Pati çöktü');
    expect(container.querySelector('.lg-banner__dev')?.textContent).toBe('Pixel 8');
    expect(container.querySelector('.lg-banner__dev')?.getAttribute('title')).toBe('Pixel 8 · Demo');
  });
});
