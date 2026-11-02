import { isMac } from './platform';

/**
 * Keyboard shortcut parsing/matching and the global shortcut manager behind `useShortcut`.
 *
 * Combo syntax: modifiers joined with "+": `Mod` (⌘ on macOS, Ctrl elsewhere), `Ctrl`, `Meta`/`Cmd`,
 * `Alt`/`Option`, `Shift`, then one key: a letter, digit, symbol (`/`, `?`) or a named key
 * (`Enter`, `Escape`/`Esc`, `Space`, `Backspace`, `Delete`, `Tab`, `ArrowUp`/`Up`, `PageDown`, `Home`, `F1`…).
 * Symbols match regardless of Shift (on Turkish Q keyboards `?` is Shift+*).
 */

export interface ParsedCombo {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Normalized lower-case key ("k", "/", "escape", " ", "arrowup"). */
  key: string;
}

const ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  return: 'enter',
  plus: '+',
};

export function parseCombo(combo: string): ParsedCombo {
  const out: ParsedCombo = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' };
  let s = combo.trim();
  let key = '';
  if (s.endsWith('++')) {
    key = '+';
    s = s.slice(0, -2);
  }
  const parts = s.split('+').filter(Boolean);
  if (!key) key = parts.pop() ?? '';
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'mod') out.mod = true;
    else if (p === 'ctrl' || p === 'control') out.ctrl = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command') out.meta = true;
    else if (p === 'alt' || p === 'option' || p === 'opt') out.alt = true;
    else if (p === 'shift') out.shift = true;
  }
  const k = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  out.key = ALIASES[k] ?? k;
  return out;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const isLetter = (k: string) => k.length === 1 && k >= 'a' && k <= 'z';
const isDigit = (k: string) => k.length === 1 && k >= '0' && k <= '9';

export function matchCombo(p: ParsedCombo, e: KeyEventLike, mac: boolean = isMac): boolean {
  const wantMeta = p.meta || (p.mod && mac);
  const wantCtrl = p.ctrl || (p.mod && !mac);
  if (Boolean(e.metaKey) !== wantMeta) return false;
  if (Boolean(e.ctrlKey) !== wantCtrl) return false;
  if (Boolean(e.altKey) !== p.alt) return false;
  const symbol = p.key.length === 1 && !isLetter(p.key) && !isDigit(p.key) && p.key !== ' ';
  if (!symbol && Boolean(e.shiftKey) !== p.shift) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (key === p.key) return true;
  // Layout-independent fallback (Option/Alt changes e.key on macOS; non-Latin layouts).
  if (isLetter(p.key) && e.code === `Key${p.key.toUpperCase()}`) return true;
  if (isDigit(p.key) && (e.code === `Digit${p.key}` || e.code === `Numpad${p.key}`)) return true;
  return false;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return el.isContentEditable === true;
}

const INTERACTIVE_ROLES = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'checkbox', 'switch', 'radio', 'link']);

function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (['BUTTON', 'A', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return true;
  const role = el.getAttribute?.('role');
  return role ? INTERACTIVE_ROLES.has(role) : false;
}

/** Display labels for a combo, e.g. "Mod+K" → ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere. */
export function comboLabels(combo: string, mac: boolean = isMac): string[] {
  const p = parseCombo(combo);
  const out: string[] = [];
  if (p.ctrl || (p.mod && !mac)) out.push(mac ? '⌃' : 'Ctrl');
  if (p.alt) out.push(mac ? '⌥' : 'Alt');
  if (p.shift) out.push(mac ? '⇧' : 'Shift');
  if (p.meta || (p.mod && mac)) out.push(mac ? '⌘' : 'Win');
  out.push(keyLabel(p.key, mac));
  return out;
}

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  tab: '⇥',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

function keyLabel(key: string, mac: boolean): string {
  if (key === 'backspace') return mac ? '⌫' : 'Backspace';
  if (key === 'delete') return mac ? '⌦' : 'Del';
  const named = KEY_LABELS[key];
  if (named) return named;
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human readable combo string ("⌘K", "Ctrl+K"). */
export function formatCombo(combo: string, mac: boolean = isMac): string {
  const labels = comboLabels(combo, mac);
  return mac ? labels.join('') : labels.join('+');
}

/* ───────────── Global manager ───────────── */

export interface ShortcutOptions {
  /** Default true. */
  enabled?: boolean;
  /** Fire while focus is in a text field. Default: true for Mod/Ctrl/Meta combos and Escape, else false. */
  allowInInputs?: boolean;
  /** Fire while a modal dialog is open. Default false. */
  allowInModal?: boolean;
  /** Fire on auto-repeat (held key). Default false. */
  allowRepeat?: boolean;
  /** Default true. */
  preventDefault?: boolean;
  /** Higher runs first; ties: the most recently registered runs first. Default 0. */
  priority?: number;
}

/** Return `false` to let the event fall through to the next matching shortcut. */
export type ShortcutHandler = (e: KeyboardEvent) => void | boolean;

export interface ShortcutRegistration {
  combos: ParsedCombo[];
  handler: ShortcutHandler;
  opts: ShortcutOptions;
  order: number;
}

const registry: ShortcutRegistration[] = [];
let orderSeq = 0;
let modalDepth = 0;
let installed = false;

export function registerShortcut(combo: string | readonly string[], handler: ShortcutHandler, opts: ShortcutOptions = {}): ShortcutRegistration & { dispose(): void } {
  const reg: ShortcutRegistration = {
    combos: (typeof combo === 'string' ? [combo] : [...combo]).map(parseCombo),
    handler,
    opts,
    order: ++orderSeq,
  };
  registry.push(reg);
  install();
  return Object.assign(reg, {
    dispose() {
      const i = registry.indexOf(reg);
      if (i >= 0) registry.splice(i, 1);
    },
  });
}

/** Modal dialogs call this while open; global shortcuts are suppressed unless `allowInModal`. */
export function pushModalLayer(): () => void {
  modalDepth++;
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    modalDepth = Math.max(0, modalDepth - 1);
  };
}

export function modalLayerDepth(): number {
  return modalDepth;
}

export function handleShortcutEvent(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
  const editable = isEditableTarget(e.target);
  const ordered = [...registry].sort((a, b) => (b.opts.priority ?? 0) - (a.opts.priority ?? 0) || b.order - a.order);
  for (const r of ordered) {
    const o = r.opts;
    if (o.enabled === false) continue;
    if (modalDepth > 0 && !o.allowInModal) continue;
    if (e.repeat && !o.allowRepeat) continue;
    const combo = r.combos.find((c) => matchCombo(c, e));
    if (!combo) continue;
    const hasMod = combo.mod || combo.ctrl || combo.meta;
    if (editable && !(o.allowInInputs ?? (hasMod || combo.key === 'escape'))) continue;
    // Space/Enter on a focused button must keep activating the button.
    if (!hasMod && (combo.key === ' ' || combo.key === 'enter') && isInteractiveTarget(e.target)) continue;
    let result: void | boolean;
    try {
      result = r.handler(e);
    } catch (err) {
      console.error('[durbun] shortcut handler failed', err);
      result = undefined;
    }
    if (result === false) continue;
    if (o.preventDefault !== false) e.preventDefault();
    return true;
  }
  return false;
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    handleShortcutEvent(e);
  });
}
