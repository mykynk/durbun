/**
 * Query field with live syntax highlighting + autocomplete (CONTRACT, see ./index.ts).
 *
 * Technique: a native <input> with transparent text sits on top of an aria-hidden layer that renders the
 * same text as colored token spans with identical font metrics (JetBrains Mono, no ligatures, same padding);
 * the layer follows the input's horizontal scroll. Caret, selection, IME, undo and spell-off behave natively.
 * While an IME composition is in progress the input shows its own text (the layer hides).
 *
 * The field keeps its own draft and only adopts `value` when it is not an echo of something typed here, so
 * a parent that updates `value` late (debounce, transition) can never drop keystrokes or move the caret.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
} from 'react';
import { clsx } from 'clsx';
import { CircleAlert, History, Search, X } from 'lucide-react';
import { IconButton, Kbd, Portal, Tooltip, useFeatureActive, useFloating, useShortcut } from '../../../components';
import { useT } from '../../../i18n';
import type { ParsedQuery, QuerySuggestData, QuerySuggestion } from './index';
import { parseLogQuery } from './parser';
import { suggestLogQuery } from './suggest';
import { queryErrorText } from './i18n';
import { matchingParen, QueryTokens } from './QueryHighlight';
import { foldCase } from './syntax';
import './query.css';

export { LogQueryHelp } from './LogQueryHelp';

export interface LogQueryInputProps {
  value: string;
  onChange(value: string): void;
  /** Enter while no suggestion is highlighted (the view stores it in the query history). */
  onSubmit?(value: string): void;
  /** Parsed form of `value` (the view parses once and passes it down) — highlighting + error underline. */
  parsed?: ParsedQuery;
  /** Called lazily when the autocomplete popup opens. */
  getSuggestData(): QuerySuggestData;
  placeholder?: string;
  /** Global shortcut(s) focusing the field, e.g. ['/', 'Mod+F']. */
  shortcut?: string | string[];
  shortcutEnabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Content rendered inside the field before the clear button (match counter, toggles…). */
  trailing?: ReactNode;
  className?: string;
  'aria-label'?: string;
  /** (addition) Focus the field on mount. */
  autoFocus?: boolean;
}

/** Errors appear after this pause in typing (immediately when the field is not being edited). */
const ERROR_DELAY_MS = 650;
const EMPTY_DATA: QuerySuggestData = { tags: [], processes: [], apps: [], history: [] };

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = value;
}

/** Viewport x of a source offset inside the highlight layer (collapsed DOM Range), or null. */
function offsetLeft(layer: HTMLElement | null, offset: number): number | null {
  if (!layer || typeof document.createRange !== 'function') return null;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      if (typeof range.getBoundingClientRect !== 'function') return null;
      return range.getBoundingClientRect().left;
    }
    remaining -= node.data.length;
    last = node;
  }
  if (last?.parentElement) return last.parentElement.getBoundingClientRect().right;
  return layer.getBoundingClientRect().left;
}

const raf = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

export function LogQueryInput({
  value,
  onChange,
  onSubmit,
  parsed: parsedProp,
  getSuggestData,
  placeholder,
  shortcut,
  shortcutEnabled = true,
  inputRef,
  trailing,
  className,
  autoFocus,
  ...aria
}: LogQueryInputProps) {
  const t = useT();
  const featureActive = useFeatureActive();
  const uid = useId();
  const listId = `${uid}-suggestions`;
  const errorId = `${uid}-error`;

  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const layerX = useRef(0);
  const focusIntent = useRef(false);

  const callbacks = useRef({ onChange, onSubmit, getSuggestData });
  callbacks.current = { onChange, onSubmit, getSuggestData };

  /* ───────── draft (semi-controlled) ───────── */
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const emitted = useRef<string[]>([]);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (value === draftRef.current) {
      emitted.current = [];
      return;
    }
    if (emitted.current.includes(value)) return; // a late echo of something typed here
    emitted.current = [];
    draftRef.current = value;
    setDraft(value);
    if (inputEl.current && document.activeElement === inputEl.current) pendingCaret.current = value.length;
  }, [value]);

  const emit = useCallback((next: string) => {
    draftRef.current = next;
    setDraft(next);
    const list = emitted.current;
    list.push(next);
    if (list.length > 64) list.splice(0, list.length - 64);
    callbacks.current.onChange(next);
  }, []);

  const parsed = useMemo(() => (parsedProp && parsedProp.source === draft ? parsedProp : parseLogQuery(draft)), [parsedProp, draft]);

  /* ───────── focus, caret, composition ───────── */
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const [caret, setCaret] = useState(0);
  const caretRef = useRef(0);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);

  const syncScroll = useCallback(() => {
    const input = inputEl.current;
    const layer = layerRef.current;
    if (!input || !layer) return;
    const x = input.scrollLeft;
    if (x !== layerX.current) {
      layerX.current = x;
      layer.style.transform = x ? `translateX(${-x}px)` : '';
    }
  }, []);
  /**
   * Keep a collapsed caret inside the visible field. Browsers scroll to the caret when text is typed, but not
   * after script edits or when the field narrows later (clear button / error icon / view content appearing).
   */
  const ensureCaretVisible = useCallback(() => {
    const input = inputEl.current;
    if (!input || document.activeElement !== input || composingRef.current) return;
    if (input.selectionStart === null || input.selectionStart !== input.selectionEnd) return; // keep selections as the user made them
    syncScroll();
    const x = offsetLeft(layerRef.current, input.selectionStart);
    if (x === null) return;
    const box = input.getBoundingClientRect();
    if (x < box.left + 2) input.scrollLeft -= box.left + 2 - x;
    else if (x > box.right - 4) input.scrollLeft += x - (box.right - 4);
    syncScroll();
  }, [syncScroll]);

  const scheduleSync = useCallback(() => {
    syncScroll();
    raf(ensureCaretVisible);
  }, [syncScroll, ensureCaretVisible]);

  useEffect(() => {
    const input = inputEl.current;
    if (!input || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => ensureCaretVisible());
    ro.observe(input);
    return () => ro.disconnect();
  }, [ensureCaretVisible]);

  /* ───────── errors: shown after a pause in typing ───────── */
  const [errorShown, setErrorShown] = useState(false);
  const errorShownRef = useRef(false);
  errorShownRef.current = errorShown;
  useEffect(() => {
    if (!parsed.error) {
      setErrorShown(false);
      return;
    }
    if (errorShownRef.current) return; // already visible: ranges follow the text live
    if (!focusedRef.current) {
      setErrorShown(true);
      return;
    }
    const id = window.setTimeout(() => setErrorShown(true), ERROR_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [parsed]);

  /* ───────── suggestions ───────── */
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [items, setItems] = useState<QuerySuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState('');
  const dataRef = useRef<QuerySuggestData | null>(null);
  const showPopup = open && items.length > 0;

  // While the user is completing the very term that is incomplete (`tag:` + picking a value), the error
  // would only repeat what the popup already offers: keep it back until the popup closes.
  const firstError = parsed.error;
  const errorAtCaret = Boolean(showPopup && firstError && caret >= firstError.from && caret <= firstError.to);
  const errorVisible = errorShown && Boolean(firstError) && !errorAtCaret;
  const errorRanges = errorVisible ? (parsed.errors ?? (firstError ? [firstError] : undefined)) : undefined;
  const errorMessage = errorVisible ? queryErrorText(firstError) : '';

  const close = useCallback(() => {
    if (!openRef.current && dataRef.current === null) return;
    openRef.current = false;
    dataRef.current = null;
    setOpen(false);
    setItems([]);
    setActive(-1);
  }, []);

  const refresh = useCallback(
    (text: string, pos: number, mode: 'typing' | 'explicit' | 'caret') => {
      if (mode === 'caret' && !openRef.current) return;
      // Typing / moving onto a word boundary closes the popup (it reopens on the next word or with ↓).
      if (mode !== 'explicit' && text.trim() !== '') {
        const prev = text[pos - 1];
        if (prev === undefined || /[\s(|)]/.test(prev)) {
          close();
          return;
        }
      }
      if (!dataRef.current) {
        let data: QuerySuggestData = EMPTY_DATA;
        try {
          data = callbacks.current.getSuggestData() ?? EMPTY_DATA;
        } catch {
          data = EMPTY_DATA;
        }
        dataRef.current = data;
      }
      const list = suggestLogQuery(text, pos, dataRef.current);
      if (list.length === 0) {
        close();
        return;
      }
      const first = list[0]!;
      openRef.current = true;
      setItems(list);
      setActive(first.preselect ? 0 : -1);
      setTyped(first.kind === 'history' ? '' : text.slice(first.from, Math.max(first.from, pos)).replace(/^-?"/, ''));
      setOpen(true);
    },
    [close],
  );

  /** Set while an edit made here (accept / clear) flows through onChange: the caller handles the popup. */
  const quietEdit = useRef(false);

  /**
   * Replace [from, to) with `text`. Goes through the browser's editing pipeline when possible so ⌘Z / Ctrl+Z
   * can undo it like typing (execCommand), else sets the value directly.
   */
  const replaceRange = useCallback(
    (from: number, to: number, text: string): { next: string; pos: number } => {
      const cur = draftRef.current;
      const a = Math.max(0, Math.min(from, cur.length));
      const b = Math.max(a, Math.min(to, cur.length));
      const next = cur.slice(0, a) + text + cur.slice(b);
      const pos = a + text.length;
      const input = inputEl.current;
      let native = false;
      // Re-applied after the render either way: places the caret and scrolls it into view (script-driven
      // edits do not scroll the field by themselves).
      pendingCaret.current = pos;
      if (input && document.activeElement === input && typeof document.execCommand === 'function') {
        quietEdit.current = true;
        try {
          input.setSelectionRange(a, b);
          native = (text ? document.execCommand('insertText', false, text) : document.execCommand('delete', false)) && input.value === next;
        } catch {
          native = false;
        } finally {
          quietEdit.current = false;
        }
      }
      if (!native) {
        caretRef.current = pos;
        setCaret(pos);
        emit(next);
      }
      return { next, pos };
    },
    [emit],
  );

  const accept = useCallback(
    (s: QuerySuggestion) => {
      const { next, pos } = replaceRange(s.from, s.to, s.insert);
      if (s.kind === 'key') refresh(next, pos, 'explicit');
      else close();
    },
    [replaceRange, refresh, close],
  );

  /** Empty the field (undoable). `showHistory`: open the recent queries afterwards (clear button). */
  const clear = useCallback(
    (showHistory: boolean) => {
      inputEl.current?.focus();
      if (draftRef.current) replaceRange(0, draftRef.current.length, '');
      if (showHistory) refresh('', 0, 'explicit');
      else close();
    },
    [replaceRange, refresh, close],
  );

  /* ───────── DOM sync after every render: caret, scroll ───────── */
  useLayoutEffect(() => {
    // A hidden tab is `content-visibility: hidden`: reading layout there would force a render for nothing.
    if (!featureActive) return;
    const input = inputEl.current;
    const pos = pendingCaret.current;
    if (input && pos !== null) {
      pendingCaret.current = null;
      if (document.activeElement === input) {
        const p = Math.min(pos, input.value.length);
        input.setSelectionRange(p, p);
        ensureCaretVisible(); // programmatic selections do not scroll the field
      }
    }
    syncScroll();
  });

  /* ───────── popup anchor: under the token being completed ───────── */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || items.length === 0) return;
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const tokenX = offsetLeft(layerRef.current, items[0]!.from) ?? box.left;
    const x = Math.round(Math.max(box.left, Math.min(tokenX - 13, box.right - 200)));
    const y = Math.round(box.bottom);
    setAnchor((a) => (a && a.x === x && a.y === y ? a : { x, y }));
  }, [open, items, draft]);

  /* ───────── error tooltip on hover ───────── */
  const [hoverError, setHoverError] = useState<HTMLElement | null>(null);
  useEffect(() => setHoverError(null), [parsed, errorShown]);
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!errorRanges || open) {
      if (hoverError) setHoverError(null);
      return;
    }
    const field = fieldRef.current?.getBoundingClientRect();
    let hit: HTMLElement | null = null;
    if (field && e.clientX >= field.left && e.clientX <= field.right) {
      for (const span of layerRef.current?.querySelectorAll<HTMLElement>('.qt-err') ?? []) {
        const r = span.getBoundingClientRect();
        if (e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4) {
          hit = span;
          break;
        }
      }
    }
    if (hit !== hoverError) setHoverError(hit);
  };

  /* ───────── shortcut ───────── */
  useShortcut(
    shortcut ?? [],
    () => {
      const input = inputEl.current;
      if (!input) return false;
      focusIntent.current = true;
      input.focus();
      input.select();
    },
    { enabled: Boolean(shortcut) && shortcutEnabled && featureActive },
  );

  /* ───────── handlers ───────── */
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    const pos = e.target.selectionStart ?? next.length;
    caretRef.current = pos;
    setCaret(pos);
    emit(next);
    if (!composingRef.current && !quietEdit.current) refresh(next, pos, 'typing');
    scheduleSync();
  };

  const handleSelect = (e: SyntheticEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    // React also reports selection changes on keydown, before a programmatic edit (accepting a
    // suggestion) reaches the DOM: that caret belongs to the old text, ignore it.
    if (pendingCaret.current !== null || input.value !== draftRef.current) return;
    const pos = (input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd) ?? 0;
    if (pos !== caretRef.current) {
      caretRef.current = pos;
      setCaret(pos);
      if (input.selectionStart === input.selectionEnd) refresh(draftRef.current, pos, 'caret');
    }
    syncScroll();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const input = e.currentTarget;
    const pos = input.selectionStart ?? draftRef.current.length;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    switch (e.key) {
      case 'ArrowDown':
        if (!plain) break;
        e.preventDefault();
        if (!openRef.current) refresh(draftRef.current, pos, 'explicit');
        else setActive((a) => (items.length ? (a + 1) % items.length : -1));
        break;
      case 'ArrowUp':
        if (!plain || !openRef.current) break;
        e.preventDefault();
        setActive((a) => (items.length ? (a <= 0 ? items.length - 1 : a - 1) : -1));
        break;
      case 'Enter': {
        const pick = openRef.current && active >= 0 ? items[active] : undefined;
        if (pick) {
          e.preventDefault();
          accept(pick);
          break;
        }
        close();
        callbacks.current.onSubmit?.(draftRef.current);
        break;
      }
      case 'Tab':
        if (openRef.current && items.length > 0 && plain) {
          e.preventDefault();
          accept(items[active >= 0 ? active : 0]!);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (openRef.current) close();
        else if (draftRef.current) clear(false); // undoable with ⌘Z / Ctrl+Z
        else input.blur();
        break;
      case ' ':
        if (e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          refresh(draftRef.current, pos, 'explicit');
        }
        break;
      default:
        break;
    }
    scheduleSync();
  };

  const handleFocus = () => {
    focusedRef.current = true;
    setFocused(true);
    const intent = focusIntent.current;
    focusIntent.current = false;
    if (intent && !draftRef.current.trim()) refresh(draftRef.current, 0, 'explicit'); // recent queries
    scheduleSync();
  };

  const handleBlur = () => {
    focusedRef.current = false;
    setFocused(false);
    close();
    if (parsed.error) setErrorShown(true);
    scheduleSync();
  };

  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      inputEl.current = el;
      assignRef(inputRef, el);
    },
    [inputRef],
  );

  const firstShortcut = typeof shortcut === 'string' ? shortcut : shortcut?.[0];
  const parens = focused ? matchingParen(parsed.tokens, caret) : null;
  const ariaLabel = aria['aria-label'] ?? placeholder ?? t('logsQuery.label');

  return (
    <div
      ref={rootRef}
      className={clsx('lq', focused && 'is-focused', errorRanges && 'is-invalid', composing && 'is-composing', className)}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverError(null)}
    >
      <Search size={14} className="lq__icon" aria-hidden />
      <div ref={fieldRef} className="lq__field">
        <div className="lq__hl" aria-hidden="true">
          <div ref={layerRef} className="lq__hl-inner">
            <QueryTokens tokens={parsed.tokens} errors={errorRanges} parens={parens} />
          </div>
        </div>
        <input
          ref={setRefs}
          type="text"
          className="lq__input"
          value={draft}
          placeholder={placeholder ?? t('logsQuery.placeholder')}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={showPopup}
          aria-controls={showPopup ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showPopup && active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={errorRanges ? true : undefined}
          aria-describedby={errorRanges ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={autoFocus}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onScroll={syncScroll}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPointerDown={() => {
            if (document.activeElement !== inputEl.current) focusIntent.current = true;
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            setComposing(false);
            const input = e.currentTarget;
            refresh(input.value, input.selectionStart ?? input.value.length, 'typing');
            scheduleSync();
          }}
        />
      </div>
      {errorMessage ? (
        <Tooltip content={errorMessage} side="bottom">
          <span className="lq__err" role="img" tabIndex={0} aria-label={`${t('logsQuery.errorLabel')}: ${errorMessage}`}>
            <CircleAlert size={14} aria-hidden />
          </span>
        </Tooltip>
      ) : null}
      <span id={errorId} className="sr-only">
        {errorMessage}
      </span>
      {trailing}
      {draft ? (
        <IconButton icon={X} label={t('logsQuery.clear')} shortcut="Escape" size="xs" className="lq__clear" onMouseDown={(e) => e.preventDefault()} onClick={() => clear(true)} />
      ) : firstShortcut ? (
        <Kbd combo={firstShortcut} size="sm" className="lq__kbd" />
      ) : null}
      {showPopup ? (
        <SuggestionPopup
          id={listId}
          items={items}
          active={active}
          anchor={anchor}
          typed={typed}
          error={errorMessage}
          onHover={setActive}
          onPick={accept}
        />
      ) : null}
      {hoverError && errorMessage && !showPopup ? <ErrorTip anchorEl={hoverError} text={errorMessage} /> : null}
    </div>
  );
}

/* ───────────────────────────── popup ───────────────────────────── */

interface SuggestionPopupProps {
  id: string;
  items: QuerySuggestion[];
  active: number;
  anchor: { x: number; y: number } | null;
  typed: string;
  error: string;
  onHover(index: number): void;
  onPick(s: QuerySuggestion): void;
}

function SuggestionPopup({ id, items, active, anchor, typed, error, onHover, onPick }: SuggestionPopupProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const placement = useFloating(Boolean(anchor), anchor, ref, { side: 'bottom', align: 'start', offset: 4 });
  const history = items[0]?.kind === 'history';

  useLayoutEffect(() => {
    if (active < 0) return;
    const el = document.getElementById(`${id}-${active}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active]);

  return (
    <Portal>
      <div
        ref={ref}
        className="lq-pop"
        style={{
          top: placement?.top ?? -9999,
          left: placement?.left ?? -9999,
          maxHeight: placement ? Math.min(placement.maxHeight, 420) : undefined,
          visibility: placement ? 'visible' : 'hidden',
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {history ? (
          <div className="lq-pop__section" aria-hidden="true">
            <History size={12} aria-hidden />
            {t('logsQuery.history')}
          </div>
        ) : null}
        <div className="lq-pop__list" role="listbox" id={id} aria-label={t(history ? 'logsQuery.history' : 'logsQuery.suggestions')}>
          {items.map((s, i) => (
            <SuggestionRow key={`${i}:${s.kind}:${s.label}`} id={`${id}-${i}`} s={s} index={i} active={i === active} typed={typed} onHover={onHover} onPick={onPick} />
          ))}
        </div>
        {error ? (
          <div className="lq-pop__error">
            <CircleAlert size={13} aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="lq-pop__foot" aria-hidden="true">
          <span className="lq-pop__hint">
            <Kbd combo="ArrowUp" size="sm" />
            <Kbd combo="ArrowDown" size="sm" />
            {t('logsQuery.hint.navigate')}
          </span>
          <span className="lq-pop__hint">
            <Kbd combo="Tab" size="sm" />
            <Kbd combo="Enter" size="sm" />
            {t('logsQuery.hint.accept')}
          </span>
          <span className="lq-pop__hint">
            <Kbd combo="Escape" size="sm" />
            {t('logsQuery.hint.close')}
          </span>
        </div>
      </div>
    </Portal>
  );
}

interface SuggestionRowProps {
  id: string;
  s: QuerySuggestion;
  index: number;
  active: boolean;
  typed: string;
  onHover(index: number): void;
  onPick(s: QuerySuggestion): void;
}

const SuggestionRow = memo(function SuggestionRow({ id, s, index, active, typed, onHover, onPick }: SuggestionRowProps) {
  const level = s.kind === 'value' && s.key === 'level' ? s.label : undefined;
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={clsx('lq-opt', `lq-opt--${s.kind}`, active && 'is-active')}
      onPointerMove={() => {
        if (!active) onHover(index);
      }}
      onClick={() => onPick(s)}
    >
      {s.kind === 'history' ? <History size={13} className="lq-opt__icon" aria-hidden /> : null}
      {level ? <span className={`lq-opt__dot lq-dot--${level}`} aria-hidden /> : null}
      <span className="lq-opt__label">
        <Emphasis text={s.label} typed={s.kind === 'history' ? '' : typed} />
      </span>
      {s.detail ? <span className="lq-opt__detail">{s.detail}</span> : null}
    </div>
  );
});

/** Label with the typed part emphasized (case-insensitive, İ ≡ i). */
function Emphasis({ text, typed }: { text: string; typed: string }) {
  const needle = foldCase(typed);
  const hay = foldCase(text);
  const at = needle ? hay.indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="lq-opt__match">{text.slice(at, at + needle.length)}</span>
      {text.slice(at + needle.length)}
    </>
  );
}

/* ───────────────────────────── error tooltip ───────────────────────────── */

function ErrorTip({ anchorEl, text }: { anchorEl: HTMLElement; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useMemo(() => ({ current: anchorEl }), [anchorEl]);
  const placement = useFloating(true, anchor, ref, { side: 'bottom', align: 'start', offset: 8 });
  return (
    <Portal>
      <div
        ref={ref}
        role="tooltip"
        className={clsx('tooltip lq-errtip', placement && `tooltip--${placement.side}`)}
        style={{ top: placement?.top ?? -9999, left: placement?.left ?? -9999, visibility: placement ? 'visible' : 'hidden' }}
      >
        <CircleAlert size={13} className="lq-errtip__icon" aria-hidden />
        <span className="tooltip__text">{text}</span>
      </div>
    </Portal>
  );
}
