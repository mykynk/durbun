import { describe, expect, it } from 'vitest';
import { MAX_SHARED_BODY_CHARS } from '../../network/model/shareReport';
import { buildLogReport, type LogShareInput, type LogShareLabels } from './shareReport';

const LABELS: LogShareLabels = {
  time: 'Time',
  app: 'App',
  device: 'Device',
  process: 'Process',
  message: 'Message',
  data: 'Data',
  error: 'Error',
  stack: 'Stack trace',
  more: (n) => `… ${n} more characters not shown`,
};

// The Flutter panel's share_report_test.dart pins the same English report.
const CRASH: LogShareInput = {
  level: 'fatal',
  kind: 'Crash',
  tag: 'flutter',
  ts: Date.UTC(2026, 10, 10, 11, 3, 22, 120),
  utcOffsetMinutes: 180,
  app: 'Shop 2.4.1 (com.example.shop)',
  device: 'Galaxy A73 (SM-A736B) · Android 14',
  message: 'Null check operator used on a null value',
  error: { type: '_TypeError', message: 'Null check operator used on a null value', stack: '#0      CartPage.build (package:shop/cart.dart:42:7)\n#1      StatelessElement.build' },
};

describe('buildLogReport', () => {
  it('reports a crash with its context and stack', () => {
    expect(buildLogReport(CRASH, LABELS)).toBe(
      [
        'FATAL · Crash · flutter',
        '',
        '- Time: 2026-11-10 14:03:22.120 (UTC+03:00) · 2026-11-10T11:03:22.120Z',
        '- App: Shop 2.4.1 (com.example.shop)',
        '- Device: Galaxy A73 (SM-A736B) · Android 14',
        '',
        'Message:',
        '```',
        'Null check operator used on a null value',
        '```',
        '',
        'Stack trace:',
        '```',
        '#0      CartPage.build (package:shop/cart.dart:42:7)',
        '#1      StatelessElement.build',
        '```',
      ].join('\n'),
    );
  });

  it('names an error the message does not mention and skips a stack the message already holds', () => {
    const text = buildLogReport(
      { level: 'error', ts: 0, utcOffsetMinutes: 0, process: 'com.example.shop 4211', message: 'Payment failed\n#0 pay (pay.dart:1)', error: { type: 'StateError', message: 'closed', stack: '#0 pay (pay.dart:1)' } },
      LABELS,
    );
    expect(text).toContain('- Process: com.example.shop 4211');
    expect(text).toContain('Error: StateError: closed');
    expect(text).not.toContain('Stack trace:');
    expect(text.startsWith('ERROR\n')).toBe(true);
  });

  it('adds the logged data as JSON', () => {
    const text = buildLogReport({ level: 'warn', ts: 0, utcOffsetMinutes: 0, message: 'Cart sync slow', data: { items: 3, ms: 1840 } }, LABELS);
    expect(text.endsWith(['Data:', '```json', '{', '  "items": 3,', '  "ms": 1840', '}', '```'].join('\n'))).toBe(true);
  });

  it('keeps a fence longer than backtick runs in the message and cuts very long text', () => {
    const fenced = buildLogReport({ level: 'info', ts: 0, utcOffsetMinutes: 0, message: 'see ```code```' }, LABELS);
    expect(fenced).toContain('````\nsee ```code```\n````');
    const long = buildLogReport({ level: 'info', ts: 0, utcOffsetMinutes: 0, message: 'x'.repeat(MAX_SHARED_BODY_CHARS + 7) }, LABELS);
    expect(long.endsWith('… 7 more characters not shown')).toBe(true);
  });
});
