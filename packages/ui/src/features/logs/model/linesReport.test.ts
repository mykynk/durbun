import { describe, expect, it } from 'vitest';
import { MAX_SHARED_LINES_CHARS, buildLinesReport, type LinesShareLabels } from './shareReport';

const labels: LinesShareLabels = { range: 'Range', scope: 'Scope', app: 'App', device: 'Device', more: (n) => `${n} more characters` };

describe('buildLinesReport', () => {
  it('names the range and scope, fences the lines and notes masking', () => {
    const md = buildLinesReport({ title: '2 log lines', from: Date.UTC(2026, 10, 16, 10, 0, 0), to: Date.UTC(2026, 10, 16, 10, 0, 5), utcOffsetMinutes: 0, scope: 'All devices', text: 'a\nb\n', maskedNote: 'Secret values were masked' }, labels);
    expect(md.startsWith('2 log lines\n')).toBe(true);
    expect(md).toContain('- Range: ');
    expect(md).toContain('- Scope: All devices');
    expect(md).toContain('```\na\nb\n```');
    expect(md).toContain('_Secret values were masked_');
  });
  it('cuts long text at a line end and says how much is left out', () => {
    const line = 'x'.repeat(99);
    const text = Array.from({ length: 1000 }, () => line).join('\n');
    const md = buildLinesReport({ title: 't', from: 0, to: 0, text }, labels);
    expect(md.length).toBeLessThan(MAX_SHARED_LINES_CHARS + 500);
    expect(md).toMatch(/\d+ more characters/);
    expect(md).not.toMatch(/x{100}/);
  });
});
