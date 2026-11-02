import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LogEntry } from '@durbun/protocol';
import '../../../i18n';
import '../i18n';
import { setLanguage } from '../../../i18n/core';
import { buildHighlighter } from '../model/highlight';
import { DetailPanel, crashReportDownload } from './DetailPanel';
import type { RowDisplay } from './LogRow';

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

function panel(e: LogEntry) {
  const noop = () => {};
  return render(<DetailPanel entry={e} index={0} total={1} d={d} onClose={noop} onPrev={noop} onNext={noop} onFilter={noop} onShowInContext={noop} onOpenNetwork={noop} />);
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
