import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import javascript from 'highlight.js/lib/languages/javascript';
import css from 'highlight.js/lib/languages/css';
import type { CodeLanguage } from './json';

hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('css', css);

const HLJS_NAME: Record<CodeLanguage, string | null> = {
  json: 'json',
  xml: 'xml',
  html: 'xml',
  javascript: 'javascript',
  css: 'css',
  plain: null,
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Highlighted HTML for the whole text (escaped plain text for 'plain' or on failure). */
export function highlightToHtml(code: string, language: CodeLanguage): string {
  const name = HLJS_NAME[language];
  if (!name) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Split highlighted HTML into per-line HTML strings, closing open <span>s at each line end and
 * re-opening them on the next line (multi-line strings/comments keep their color).
 */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end < 0) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) stack.pop();
      else if (!tag.endsWith('/>')) stack.push(tag);
      cur += tag;
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      cur += '</span>'.repeat(stack.length);
      lines.push(cur);
      cur = stack.join('');
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}

export interface MarkRange {
  start: number;
  end: number;
  current?: boolean;
}

/**
 * Wrap text ranges (offsets in the line's plain text) of a highlighted HTML line in
 * <mark class="hl">, splitting marks around tags so nesting stays valid. Entities count as 1 char.
 */
export function markHtml(html: string, ranges: readonly MarkRange[]): string {
  if (ranges.length === 0) return html;
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0; // plain-text offset
  let ri = 0;
  let open = null as MarkRange | null;
  const openTag = (r: MarkRange) => `<mark class="hl${r.current ? ' hl--current' : ''}">`;
  const sync = () => {
    if (open && pos >= open.end) {
      out += '</mark>';
      open = null;
      ri++;
    }
    while (!open && ri < sorted.length && sorted[ri]!.end <= pos) ri++;
    if (!open && ri < sorted.length && pos >= sorted[ri]!.start && pos < sorted[ri]!.end) {
      open = sorted[ri]!;
      out += openTag(open);
    }
  };
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === '<') {
      const end = html.indexOf('>', i);
      const tag = end < 0 ? html.slice(i) : html.slice(i, end + 1);
      if (open) out += `</mark>${tag}${openTag(open)}`;
      else out += tag;
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    sync();
    if (ch === '&') {
      const semi = html.indexOf(';', i);
      const ent = semi > i && semi - i <= 10 ? html.slice(i, semi + 1) : '&';
      out += ent;
      i += ent.length;
    } else {
      out += ch;
      i++;
    }
    pos++;
    if (open && pos >= open.end) sync();
  }
  if (open) out += '</mark>';
  return out.replace(/<mark class="hl(?: hl--current)?"><\/mark>/g, '');
}
