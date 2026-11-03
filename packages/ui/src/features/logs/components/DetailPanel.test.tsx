import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LogEntry } from '@durbun/protocol';
import '../../../i18n';
import '../i18n';
import { setLanguage } from '../../../i18n/core';
import { buildHighlighter } from '../model/highlight';
import { DetailPanel, crashReportDownload } from './DetailPanel';
import type { RowDisplay } from './LogRow';
import type { LogRow } from '../model/types';

vi.mock('../../../lib/download', () => ({ downloadUrl: vi.fn() }));
import { downloadUrl } from '../../../lib/download';

const UDID = '00008130-0001A2B3C4D5E6F7';
const FILE = 'Runner-2026-11-02-213004.ips';

/** An iOS crash report entry as server-ios builds it (crashReportEntry) plus the server's copy URL. */
function ips(p: Partial<LogEntry> = {}, data: Record<string, unknown> = {}): LogEntry {
  return {
    id: 41,
    ts: 1_793_650_000_000,
    deviceId: `ios:${UDID}`,
    source: 'device',
    origin: 'crash-report',
    level: 'fatal',
    kind: 'crash',
    tag: 'crash-report',
    process: 'Runner',
    pid: 811,
    message: 'Kumbara 3.1.0 (412) crashed: EXC_BAD_ACCESS (SIGSEGV)',
    error: { type: 'EXC_BAD_ACCESS', message: 'KERN_INVALID_ADDRESS at 0x10', stack: 'Thread 0 Crashed:\n0  Runner  0x0000000102f1c3a4 Runner + 115620' },
    data: {
      origin: 'crash-report',
      bundleId: 'com.mykynk.kumbara',
      reportTs: 1_793_650_000_000,
      previousLaunch: false,
      symbolicated: false,
      reportUrl: `/api/files/crash/${encodeURIComponent(UDID)}/${encodeURIComponent(FILE)}`,
      ...data,
    },
    ...p,
  };
}

const d: RowDisplay = {
  timeFormat: 'absolute',
  wrap: true,
  lang: 'tr',
  hl: buildHighlighter([], []),
  impliedProcesses: new Set(),
  identity: () => ({ dartPackages: [], javaPrefixes: [], modules: ['Runner'] }),
  appName: () => 'Kumbara',
};

function panel(e: LogEntry, row?: LogRow) {
  const noop = () => {};
  return render(<DetailPanel entry={e} row={row} index={0} total={1} d={d} onClose={noop} onPrev={noop} onNext={noop} onFilter={noop} onShowInContext={noop} onOpenNetwork={noop} />);
}

afterEach(() => {
  cleanup();
  setLanguage('en');
  vi.mocked(downloadUrl).mockClear();
});

describe('crash report download (.ips)', () => {
  it('takes only the server’s own crash-copy path', () => {
    expect(crashReportDownload(ips())).toEqual({ url: `/api/files/crash/${UDID}/${FILE}`, fileName: FILE });
    expect(crashReportDownload(ips({}, { reportUrl: 'https://example.com/x.ips' }))).toBeUndefined();
    expect(crashReportDownload(ips({}, { reportUrl: '/api/files/other.ips' }))).toBeUndefined();
    expect(crashReportDownload(ips({}, { reportUrl: 42 }))).toBeUndefined();
    // An imported recording: the copy stayed on the Mac that recorded it.
    expect(crashReportDownload(ips({ deviceId: 'import:1' }))).toBeUndefined();
  });

  it('the detail panel offers “İndir (.ips)” and says how to symbolicate', () => {
    setLanguage('tr');
    panel(ips());
    expect(screen.getByText(/Yığın sembolsüz/)).toBeTruthy();
    expect(screen.getByText(/dSYM dosyası bulunan bir Mac’te Xcode’la ya da Console’la açın/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /İndir \(\.ips\)/ }));
    expect(downloadUrl).toHaveBeenCalledWith(`/api/files/crash/${UDID}/${FILE}`, FILE);
  });

  it('no button without a report URL; no note for a symbolicated report', () => {
    setLanguage('en');
    panel(ips({}, { reportUrl: undefined, symbolicated: true }));
    expect(screen.queryByRole('button', { name: /Download \.ips/ })).toBeNull();
    expect(screen.queryByText(/Unsymbolicated stack/)).toBeNull();
  });
});

describe('what the device’s record adds (crashed build, foreground, its copy on the live row)', () => {
  /** A dropbox data_app_crash record as server-android builds it (dropboxToCrash). */
  const dropbox = (data: Record<string, unknown> = {}): LogEntry => ({
    id: 77,
    ts: 1_793_640_000_000,
    deviceId: 'android:R5CT',
    source: 'device',
    origin: 'dropbox',
    level: 'fatal',
    kind: 'crash',
    tag: 'data_app_crash',
    process: 'com.mykynk.kumbara',
    message: 'java.lang.IllegalStateException: sepet boş\n\tat com.mykynk.kumbara.Basket.total(Basket.kt:12)',
    error: { type: 'java.lang.IllegalStateException', message: 'sepet boş' },
    data: { origin: 'dropbox', dropboxTag: 'data_app_crash', package: 'com.mykynk.kumbara', version: '3.1.0', build: '310', foreground: true, reportTs: 1_793_640_000_000, previousLaunch: true, ...data },
  });

  it('names the build that crashed and that it was on screen («3.1.0 (310) sürümünde çöktü · ön plandaydı»)', () => {
    setLanguage('tr');
    panel(dropbox());
    expect(screen.getByText(/3\.1\.0 \(310\) sürümünde çöktü · ön plandaydı/)).toBeTruthy();
    expect(screen.getByText('Çöken sürüm')).toBeTruthy();
    expect(screen.getByText('Evet, ekrandaydı')).toBeTruthy();
    // A record from before Dürbün watched is not called "the previous launch" (dropbox keeps a day, .ips any age).
    expect(screen.getAllByText(/İzlemeden önce/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Önceki açılışta çöktü/)).toBeNull();
  });

  it('marks an Android native tombstone as unsymbolicated, with the Android way to read it', () => {
    setLanguage('tr');
    const tomb = dropbox({ dropboxTag: 'data_app_native_crash', foreground: undefined });
    panel({ ...tomb, tag: 'data_app_native_crash', message: 'Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)\nbacktrace:\n  #00 pc 000000000004f2a8  /data/app/lib/arm64/libapp.so', error: { type: 'SIGSEGV', message: 'Fatal signal 11' } });
    expect(screen.getByText(/Yığın sembolsüz/)).toBeTruthy();
    expect(screen.getByText(/ndk-stack/)).toBeTruthy();
    expect(screen.queryByText(/Xcode/)).toBeNull();
  });

  it('does not repeat the exception type of an .ips summary («EXC_BAD_ACCESS: EXC_BAD_ACCESS (SIGSEGV)»)', () => {
    setLanguage('en');
    const { container } = panel(ips({ error: { type: 'EXC_BAD_ACCESS', message: 'EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x10 · Termination: SIGNAL 11' } }));
    const head = container.querySelector('.lg-detail__errhead')!;
    expect(head.textContent).toBe('EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x10 · Termination: SIGNAL 11');
    expect(head.querySelector('.lg-detail__errtype')?.textContent).toBe('EXC_BAD_ACCESS');
  });

  it('keeps “type: message” when the message does not start with the type', () => {
    setLanguage('en');
    const { container } = panel(ips({ error: { type: 'EXC_BAD_ACCESS', message: 'KERN_INVALID_ADDRESS at 0x10' } }));
    expect(container.querySelector('.lg-detail__errhead')!.textContent).toBe('EXC_BAD_ACCESS: KERN_INVALID_ADDRESS at 0x10');
  });

  it('offers the .ips of a report hidden as a duplicate on the live crash row it duplicates', () => {
    setLanguage('tr');
    const live: LogEntry = { id: 40, ts: 1_793_650_000_000, deviceId: `ios:${UDID}`, source: 'device', origin: 'idevicesyslog', level: 'fatal', kind: 'crash', tag: 'Runner', process: 'Runner', message: 'Runner crashed: EXC_BAD_ACCESS' };
    const rec = ips({}, { duplicateOf: 40, version: '3.1.0', build: '412' });
    panel(live, { id: 40, e: live, n: 1, rec });
    expect(screen.getByText(/Cihaz bu çökmeyi kendisi de kaydetti/)).toBeTruthy();
    expect(screen.getByText(/3\.1\.0 \(412\) sürümünde çöktü/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /İndir \(\.ips\)/ }));
    expect(downloadUrl).toHaveBeenCalledWith(`/api/files/crash/${UDID}/${FILE}`, FILE);
  });

  it('shows whole-second device log times without a made-up “.000”', () => {
    setLanguage('en');
    const line: LogEntry = { id: 9, ts: 1_793_650_000_000, deviceId: `ios:${UDID}`, source: 'device', origin: 'idevicesyslog', level: 'info', tag: 'bluetoothd', process: 'bluetoothd', message: 'scan' };
    const { container } = panel(line);
    const head = container.querySelector('.lg-detail__time')!;
    expect(head.textContent).not.toMatch(/\.000$/);
    expect(head.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    cleanup();
    const sdk = panel({ ...line, origin: 'sdk', source: 'app' });
    expect(sdk.container.querySelector('.lg-detail__time')!.textContent).toMatch(/\.000$/);
  });
});
