import { describe, expect, it } from 'vitest';
import { SLACK_MAX_CHARS, toSlackMarkdown, toSlackText } from './slack';

const NOTE = '… (shortened to fit Slack)';

// The Flutter panel's slack_test.dart pins the same input and output.
const REPORT = [
  'POST https://api.example.com/login?next=<home>&x=1',
  '→ 500 Internal Server Error · 340 ms',
  '',
  '- Time: 2026-11-10 14:03:22.120 (UTC+03:00)',
  '',
  'Response body:',
  '````json',
  '{',
  '  "md": "```code```",',
  '  "html": "<b>&</b>"',
  '}',
  '````',
  '',
].join('\n');

describe('toSlackText', () => {
  it('escapes, plain fences, breaks backtick runs and adds the footer', () => {
    expect(toSlackText(REPORT, { cutNote: NOTE, footer: 'Sent with Dürbün · Ayşe' })).toBe(
      [
        'POST https://api.example.com/login?next=&lt;home&gt;&amp;x=1',
        '→ 500 Internal Server Error · 340 ms',
        '',
        '- Time: 2026-11-10 14:03:22.120 (UTC+03:00)',
        '',
        'Response body:',
        '```',
        '{',
        '  "md": "`​`​`code`​`​`",',
        '  "html": "&lt;b&gt;&amp;&lt;/b&gt;"',
        '}',
        '```',
        '',
        'Sent with Dürbün · Ayşe',
      ].join('\n'),
    );
  });

  it('cannot ping the channel', () => {
    expect(toSlackText('<!channel> <@U123> @here', { cutNote: NOTE })).toBe('&lt;!channel&gt; &lt;@U123&gt; @here');
  });

  it('cuts long texts, closes the open block and stays within the limit', () => {
    const long = ['GET https://x.test', '```', ...Array.from({ length: 5_000 }, (_, i) => `line ${i} & more`), '```'].join('\n');
    const text = toSlackText(long, { cutNote: NOTE, footer: 'Sent with Dürbün' });
    expect(text.length).toBeLessThanOrEqual(SLACK_MAX_CHARS);
    expect(text.endsWith(['```', NOTE, '', 'Sent with Dürbün'].join('\n'))).toBe(true);
    // No half entity at the cut.
    expect(text).not.toMatch(/&a?m?p?\n/);
  });

  it('never leaves a lone closing fence when the cut falls on a block start', () => {
    const text = toSlackText(['a'.repeat(50), '```json', 'b'.repeat(50), '```'].join('\n'), { cutNote: 'cut', maxChars: 64 });
    expect(text).toBe(['a'.repeat(50), 'cut'].join('\n'));
  });

  it('cuts a single huge line inside a block', () => {
    const text = toSlackText(['```', 'x'.repeat(200), '```'].join('\n'), { cutNote: 'cut', maxChars: 60 });
    expect(text).toMatch(/^```\nx+\n```\ncut$/);
    expect(text.length).toBeLessThanOrEqual(60);
  });
});

describe('toSlackMarkdown', () => {
  it('keeps the Markdown and the language, breaks backtick runs, italic footer', () => {
    expect(toSlackMarkdown(REPORT, { cutNote: NOTE, footer: 'Sent with Dürbün · Ayşe' })).toBe(
      [
        'POST https://api.example.com/login?next=<home>&x=1',
        '→ 500 Internal Server Error · 340 ms',
        '',
        '- Time: 2026-11-10 14:03:22.120 (UTC+03:00)',
        '',
        'Response body:',
        '```json',
        '{',
        '  "md": "`​`​`code`​`​`",',
        '  "html": "<b>&</b>"',
        '}',
        '```',
        '',
        '_Sent with Dürbün · Ayşe_',
      ].join('\n'),
    );
  });

  it('cuts long reports like the text version, closing the block and adding the note', () => {
    const long = ['```http', ...Array.from({ length: 5000 }, (_, i) => `h-${i}: ${'v'.repeat(20)}`), '```'].join('\n');
    const md = toSlackMarkdown(long, { cutNote: NOTE });
    expect(md.length).toBeLessThanOrEqual(SLACK_MAX_CHARS);
    expect(md.startsWith('```http\n')).toBe(true);
    expect(md.endsWith(`\n\`\`\`\n_${NOTE}_`)).toBe(true);
  });
});
