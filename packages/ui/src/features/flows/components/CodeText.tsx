import type { ReactNode } from 'react';

/** Catalog texts mark names and values with backticks (`true`, `keep`); they read as code, not as quotes. */
export function codeText(text: string): ReactNode {
  if (!text.includes('`')) return text;
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i} className="fl-code">{part}</code> : part));
}
