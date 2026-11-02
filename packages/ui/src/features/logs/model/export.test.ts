import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { exportFileName, exportJson, exportTimestamp, exportTxt, formatTxtEntry } from './export';
import type { LogRow } from './types';

const ts = new Date(2026, 10, 2, 14, 5, 12, 345).getTime();
const e = (partial: Partial<LogEntry> & { message: string }): LogEntry => ({ id: 1, ts, deviceId: 'demo:1', source: 'device', level: 'info', tag: 'flutter', ...partial });
const text = (x: LogEntry) => (x.source === 'system' ? `SYS:${x.message}` : x.message);

describe('export formatting', () => {
  it('formats local timestamps', () => {
    expect(exportTimestamp(ts)).toBe('2026-11-02 14:05:12.345');
  });

  it('writes logcat-like lines with process, pid and indented continuation lines', () => {
    const line = formatTxtEntry(e({ message: 'first\nsecond', level: 'error', process: 'com.mykynk.pati', pid: 4821 }), { text });
    expect(line).toBe('2026-11-02 14:05:12.345 E/flutter (com.mykynk.pati 4821): first\n    second');
  });

  it('appends error stacks that are not part of the message and the fold counter', () => {
    const line = formatTxtEntry(e({ source: 'app', message: 'Ödeme başarısız', error: { stack: '#0 a (package:pati/a.dart:1:1)' } }), { text }, 3);
    expect(line).toBe('2026-11-02 14:05:12.345 I/flutter: Ödeme başarısız  ×3\n    #0 a (package:pati/a.dart:1:1)');
  });

  it('renders lifecycle lines and markers as separators with the localized text', () => {
    const line = formatTxtEntry(e({ source: 'system', kind: 'lifecycle', message: 'App connected', tag: 'durbun' }), { text });
    expect(line).toBe('2026-11-02 14:05:12.345 ---- SYS:App connected ----');
  });

  it('exports rows with a header', () => {
    const rows: LogRow[] = [
      { id: 1, e: e({ id: 1, message: 'a' }), n: 1 },
      { id: 2, e: e({ id: 2, message: 'b', level: 'warn' }), n: 2, last: e({ id: 3, message: 'b', level: 'warn', ts: ts + 5 }) },
    ];
    const txt = exportTxt(rows, { text, header: ['Dürbün', '2 lines'] });
    expect(txt.split('\n')).toEqual(['# Dürbün', '# 2 lines', '', '2026-11-02 14:05:12.345 I/flutter: a', '2026-11-02 14:05:12.345 W/flutter: b  ×2', '']);
    const json = JSON.parse(exportJson(rows, { scope: 'All' }));
    expect(json.format).toBe('durbun-logs');
    expect(json.count).toBe(2);
    expect(json.scope).toBe('All');
    expect(json.logs[0].repeat).toBeUndefined();
    expect(json.logs[1].repeat).toBe(2);
    expect(json.logs[1].lastTs).toBe(ts + 5);
  });

  it('names files with a sortable timestamp', () => {
    expect(exportFileName('txt', ts)).toBe('durbun-logs-20261102-140512.txt');
    expect(exportFileName('json', ts)).toBe('durbun-logs-20261102-140512.json');
  });
});
