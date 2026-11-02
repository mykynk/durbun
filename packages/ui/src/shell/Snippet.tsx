import { memo, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { CopyButton } from '../components/CopyButton';

export type SnippetLang = 'dart' | 'kotlin' | 'swift' | 'yaml' | 'js' | 'shell' | 'text';

/**
 * Tokenize a line for light highlighting: comments, strings, and keywords. Intentionally tiny —
 * snippets are short and only need to be readable, not perfectly parsed.
 */
const KEYWORDS: Record<SnippetLang, string[]> = {
  dart: ['import', 'Future', 'void', 'async', 'await', 'const', 'final', 'var', 'return', 'class', 'extends', 'if', 'else'],
  kotlin: ['import', 'val', 'var', 'fun', 'class', 'override', 'super', 'object', 'return', 'if', 'else'],
  swift: ['import', 'let', 'var', 'func', 'class', 'struct', 'return', 'if', 'else', '#if', '#endif'],
  yaml: [],
  js: ['import', 'from', 'const', 'let', 'if', 'return', 'export'],
  shell: ['npm', 'npx', 'cd', 'flutter', 'pod'],
  text: [],
};

function renderLine(line: string, lang: SnippetLang, key: number): ReactNode {
  if (lang === 'text') return <span key={key}>{line}</span>;
  const out: ReactNode[] = [];
  const kw = new Set(KEYWORDS[lang]);
  const commentStart = lang === 'yaml' || lang === 'shell' ? '#' : '//';
  let i = 0;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    // keywords and YAML keys
    const parts = buf.split(/(\b[#A-Za-z_][\w]*\b)/);
    parts.forEach((p, j) => {
      if (kw.has(p)) out.push(<span key={`${key}-${i}-${j}`} className="snip-kw">{p}</span>);
      else if (p) out.push(p);
    });
    buf = '';
  };
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith(commentStart) && (commentStart !== '#' || i === 0 || /\s/.test(line[i - 1]!))) {
      flush();
      out.push(
        <span key={`${key}-c`} className="snip-comment">
          {rest}
        </span>,
      );
      break;
    }
    if (lang !== 'swift' && rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      const len = end >= 0 ? end + 2 : rest.length;
      flush();
      out.push(
        <span key={`${key}-b${i}`} className="snip-comment">
          {rest.slice(0, len)}
        </span>,
      );
      i += len;
      continue;
    }
    const ch = line[i]!;
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      const len = end >= 0 ? end - i + 1 : line.length - i;
      flush();
      out.push(
        <span key={`${key}-s${i}`} className="snip-string">
          {line.slice(i, i + len)}
        </span>,
      );
      i += len;
      continue;
    }
    if (lang === 'yaml' && /^\s*[\w-]+:/.test(line) && i === 0) {
      const m = /^(\s*)([\w-]+)(:)/.exec(line)!;
      out.push(m[1]);
      out.push(
        <span key={`${key}-k`} className="snip-key">
          {m[2]}
        </span>,
      );
      out.push(m[3]);
      i = m[0].length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return <span key={key}>{out}</span>;
}

/** Copyable code snippet with a filename label and light syntax coloring. */
export const Snippet = memo(function Snippet({ code, lang = 'text', title, className }: { code: string; lang?: SnippetLang; title?: string; className?: string }) {
  const lines = code.split('\n');
  return (
    <figure className={clsx('snippet', className)}>
      {title ? (
        <figcaption className="snippet__title">
          <span className="mono">{title}</span>
        </figcaption>
      ) : null}
      <pre className="snippet__code selectable">
        <code>
          {lines.map((l, i) => (
            <span key={i} className="snippet__line">
              {renderLine(l, lang, i)}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
      <CopyButton value={code} size="sm" className="snippet__copy" />
    </figure>
  );
});
