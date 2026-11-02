import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, TextWrap, X } from 'lucide-react';
import { detectCodeLanguage, type CodeLanguage } from '../lib/json';
import { escapeHtml, highlightToHtml, markHtml, splitHtmlLines, type MarkRange } from '../lib/highlight';
import { isMac } from '../lib/platform';
import { t } from '../i18n/core';
import { IconButton } from './Button';
import { CopyButton } from './CopyButton';
import { SearchInput } from './SearchInput';

export interface CodeViewProps {
  code: string;
  /** Language, or 'auto' to detect from `contentType`/content (default 'auto'). */
  language?: CodeLanguage | 'auto';
  contentType?: string;
  lineNumbers?: boolean;
  /** Controlled soft-wrap. */
  wrap?: boolean;
  /** Initial soft-wrap when uncontrolled (default false). */
  defaultWrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  /** Toolbar with language, find, wrap and copy (default true). A node adds extra controls to it. */
  toolbar?: boolean | ReactNode;
  /** Find bar (Mod+F while the view is focused). Default true. */
  findable?: boolean;
  /** Without it the view fills its parent's height (parent must be a sized flex/grid child). */
  maxHeight?: number | string;
  /** Skip syntax highlighting above this many characters (default 150 000). */
  highlightLimit?: number;
  className?: string;
  'aria-label'?: string;
}

const LANG_LABEL: Record<CodeLanguage, string> = { json: 'JSON', xml: 'XML', html: 'HTML', javascript: 'JavaScript', css: 'CSS', plain: 'Text' };
const VIRTUAL_THRESHOLD = 1500;
const LINE_H = 19;
const MAX_MATCHES = 10_000;

interface Match {
  line: number;
  start: number;
  end: number;
}

/** Read-only code viewer: highlight.js, line numbers, wrap toggle, find (with match navigation). */
export function CodeView({
  code,
  language = 'auto',
  contentType,
  lineNumbers = true,
  wrap: wrapProp,
  defaultWrap = false,
  onWrapChange,
  toolbar = true,
  findable = true,
  maxHeight,
  highlightLimit = 150_000,
  className,
  ...aria
}: CodeViewProps) {
  const [wrapState, setWrapState] = useState(defaultWrap);
  const wrap = wrapProp ?? wrapState;
  const setWrap = (w: boolean) => {
    if (wrapProp === undefined) setWrapState(w);
    onWrapChange?.(w);
  };
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  const normalized = useMemo(() => code.replace(/\r\n?/g, '\n'), [code]);
  const lang: CodeLanguage = useMemo(() => (language === 'auto' ? detectCodeLanguage(contentType, normalized.slice(0, 5000)) : language), [language, contentType, normalized]);
  const plainLines = useMemo(() => normalized.split('\n'), [normalized]);
  const htmlLines = useMemo(() => {
    if (lang === 'plain' || normalized.length > highlightLimit) return plainLines.map(escapeHtml);
    const lines = splitHtmlLines(highlightToHtml(normalized, lang));
    return lines.length === plainLines.length ? lines : plainLines.map(escapeHtml);
  }, [lang, normalized, plainLines, highlightLimit]);
  const maxChars = useMemo(() => plainLines.reduce((m, l) => Math.max(m, l.length), 0), [plainLines]);

  const matches = useMemo<Match[]>(() => {
    const q = query.toLowerCase();
    if (!findOpen || !q) return [];
    const out: Match[] = [];
    for (let li = 0; li < plainLines.length && out.length < MAX_MATCHES; li++) {
      const hay = plainLines[li]!.toLowerCase();
      if (hay.length !== plainLines[li]!.length) continue;
      let i = hay.indexOf(q);
      while (i >= 0 && out.length < MAX_MATCHES) {
        out.push({ line: li, start: i, end: i + q.length });
        i = hay.indexOf(q, i + q.length);
      }
    }
    return out;
  }, [query, findOpen, plainLines]);
  const matchesByLine = useMemo(() => {
    const map = new Map<number, MarkRange[]>();
    matches.forEach((m, idx) => {
      let arr = map.get(m.line);
      if (!arr) map.set(m.line, (arr = []));
      arr.push({ start: m.start, end: m.end, current: idx === current });
    });
    return map;
  }, [matches, current]);

  useEffect(() => setCurrent(0), [query]);

  const virtual = plainLines.length > VIRTUAL_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtual ? plainLines.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 24,
  });

  // Scroll the current match into view.
  useEffect(() => {
    const m = matches[current];
    if (!m) return;
    if (virtual) virtualizer.scrollToIndex(m.line, { align: 'center' });
    else scrollRef.current?.querySelector<HTMLElement>(`[data-line="${m.line}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, matches]);

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };
  const closeFind = () => {
    setFindOpen(false);
    setQuery('');
    scrollRef.current?.focus({ preventScroll: true });
  };
  const next = () => matches.length && setCurrent((c) => (c + 1) % matches.length);
  const prev = () => matches.length && setCurrent((c) => (c - 1 + matches.length) % matches.length);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (findable && mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openFind();
    } else if (e.key === 'Escape' && findOpen) {
      e.stopPropagation();
      closeFind();
    }
  };

  const renderLine = (i: number, style?: CSSProperties, measure?: (el: HTMLElement | null) => void) => {
    const ranges = matchesByLine.get(i);
    const html = ranges ? markHtml(htmlLines[i] ?? '', ranges) : (htmlLines[i] ?? '');
    return (
      <div key={i} ref={measure} data-index={i} data-line={i} className="code__line" style={style}>
        {lineNumbers ? <span className="code__ln">{i + 1}</span> : null}
        <span className="code__text" dangerouslySetInnerHTML={{ __html: html || '​' }} />
      </div>
    );
  };

  const gutterCh = String(plainLines.length).length;
  const items = virtual ? virtualizer.getVirtualItems() : [];
  const padTop = virtual && items.length ? items[0]!.start : 0;
  const padBottom = virtual && items.length ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

  return (
    <div
      className={clsx('code', wrap && 'code--wrap', !lineNumbers && 'code--no-ln', maxHeight !== undefined && 'code--max', className)}
      style={{ maxHeight, '--ln-ch': gutterCh, '--max-ch': maxChars } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      {toolbar ? (
        <div className="code__toolbar">
          <span className="code__lang">{LANG_LABEL[lang]}</span>
          <span className="code__meta tnum">{t('common.code.lines', { count: plainLines.length })}</span>
          {normalized.length > highlightLimit && lang !== 'plain' ? <span className="code__meta">· {t('common.code.noHighlight')}</span> : null}
          <span className="grow" />
          {typeof toolbar !== 'boolean' ? toolbar : null}
          {findable ? <IconButton icon={Search} label={t('common.code.find')} shortcut="Mod+F" size="sm" onClick={openFind} active={findOpen} /> : null}
          <IconButton icon={TextWrap} label={wrap ? t('common.code.noWrap') : t('common.code.wrap')} size="sm" active={wrap} onClick={() => setWrap(!wrap)} />
          <CopyButton size="sm" value={() => code} label={t('common.copyAll')} />
        </div>
      ) : null}
      {findOpen ? (
        <div className="code__find">
          <SearchInput
            size="sm"
            inputRef={findRef}
            value={query}
            onChange={setQuery}
            placeholder={t('common.code.findPlaceholder')}
            matches={{ current: matches.length ? current + 1 : 0, total: matches.length }}
            onNext={next}
            onPrev={prev}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
            className="grow"
          />
          <IconButton icon={X} label={t('common.close')} size="sm" onClick={closeFind} />
        </div>
      ) : null}
      <div ref={scrollRef} className="code__scroll selectable" tabIndex={0} role="region" aria-label={aria['aria-label'] ?? LANG_LABEL[lang]}>
        <div className="code__lines">
          {virtual ? (
            <>
              {padTop > 0 ? <div style={{ height: padTop }} aria-hidden /> : null}
              {items.map((it) => renderLine(it.index, undefined, wrap ? virtualizer.measureElement : undefined))}
              {padBottom > 0 ? <div style={{ height: padBottom }} aria-hidden /> : null}
            </>
          ) : (
            plainLines.map((_, i) => renderLine(i))
          )}
        </div>
      </div>
    </div>
  );
}
