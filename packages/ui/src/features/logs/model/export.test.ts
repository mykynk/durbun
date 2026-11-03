import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { exportCount, exportFileName, exportJson, exportTimestamp, exportTxt, formatTxtEntry, formatTxtRow } from './export';
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

  it('writes every event of a merged connection row, in arrival order, without a repeat counter', () => {
    const sep = (id: number, code: string): LogEntry => e({ id, ts: ts + id * 1000, source: 'system', kind: 'lifecycle', code, message: code, tag: 'durbun' });
    const events: LogEntry[] = [];
    let id = 10;
    for (let i = 0; i < 6; i++) events.push(sep(id++, 'device.disconnected'), sep(id++, 'device.connected'), sep(id++, 'logs.streamStarted'));
    const between = e({ id: 15, ts: ts + 15_500, message: 'between' }); // arrived while the cable flapped
    const after = e({ id: 40, ts: ts + 40_000, message: 'after' });
    const last = events[events.length - 1]!;
    const rows: LogRow[] = [
      { id: 15, e: { ...between }, n: 1 },
      { id: last.id, e: last, n: 1, flap: { key: events[0]!.id, events } },
      { id: 40, e: after, n: 1 },
    ];
    expect(exportCount(rows)).toBe(20);
    const lines = exportTxt(rows, { text }).trimEnd().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.filter((l) => l.includes('---- SYS:'))).toHaveLength(18);
    expect(lines.some((l) => l.includes('×'))).toBe(false);
    expect(lines[5]).toMatch(/I\/flutter: between$/);
    expect(lines[19]).toMatch(/after$/);
    const json = JSON.parse(exportJson(rows));
    expect(json.count).toBe(20);
    expect(json.logs.map((x: LogEntry) => x.id)).toEqual([...events.slice(0, 5).map((x) => x.id), 15, ...events.slice(5).map((x) => x.id), 40]);
    expect(json.logs.some((x: { repeat?: number }) => x.repeat !== undefined)).toBe(false);
    expect(formatTxtRow(rows[1]!, { text }).split('\n')).toHaveLength(18);
  });

  it('names files with a sortable timestamp', () => {
    expect(exportFileName('txt', ts)).toBe('durbun-logs-20261102-140512.txt');
    expect(exportFileName('json', ts)).toBe('durbun-logs-20261102-140512.json');
  });
});
