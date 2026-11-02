import { afterEach, describe, expect, it, vi } from 'vitest';
import { fold, fuzzyFilter, fuzzyMatch } from '../lib/fuzzy';
import { comboLabels, formatCombo, handleShortcutEvent, matchCombo, parseCombo, pushModalLayer, registerShortcut } from '../lib/shortcuts';
import { fnv1a, hashHue } from '../lib/hash';

describe('fuzzy matching', () => {
  it('matches subsequences case-insensitively and reports indices', () => {
    const m = fuzzyMatch('sdkand', 'SDK setup: Android');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2, 11, 12, 13]);
    expect(fuzzyMatch('xyz', 'SDK setup: Android')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('folds Turkish letters 1:1 so indices stay aligned', () => {
    expect(fold('İstek Şahin ığdır ÇÖÜ')).toBe('istek sahin igdir cou');
    expect(fold('İ').length).toBe(1);
    const m = fuzzyMatch('sistem kontrolu', 'Sistem kontrolü');
    expect(m).not.toBeNull();
    expect(m!.indices.length).toBe('sistem kontrolu'.length);
    expect(fuzzyMatch('agi', 'Ağ isteği')).not.toBeNull();
  });

  it('prefers word starts and consecutive runs', () => {
    const a = fuzzyMatch('net', 'Network')!.score;
    const b = fuzzyMatch('net', 'Unseen items')!.score;
    expect(a).toBeGreaterThan(b);
    const camel = fuzzyMatch('dm', 'DarkMode')!;
    expect(camel.indices).toEqual([0, 4]);
  });

  it('filters and ranks lists, weighting secondary texts lower', () => {
    const items = [
      { title: 'Settings', keywords: ['ayarlar'] },
      { title: 'System check', keywords: ['doctor', 'sistem kontrolü'] },
      { title: 'Export session', keywords: ['dışa aktar'] },
    ];
    const res = fuzzyFilter(items, 'sist', (i) => [i.title, ...i.keywords]);
    expect(res[0]!.item.title).toBe('System check');
    const tr = fuzzyFilter(items, 'disa aktar', (i) => [i.title, ...i.keywords]);
    expect(tr.map((r) => r.item.title)).toEqual(['Export session']);
    expect(tr[0]!.field).toBe(1);
    expect(fuzzyFilter(items, '', (i) => i.title)).toHaveLength(3);
    expect(fuzzyFilter(items, 's', (i) => i.title, { limit: 1 })).toHaveLength(1);
  });
});

describe('hash colors', () => {
  it('is stable and within 0..359', () => {
    expect(fnv1a('OkHttp')).toBe(fnv1a('OkHttp'));
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
    for (const tag of ['flutter', 'ActivityManager', 'com.apple.UIKit', 'auth']) {
      const h = hashHue(tag);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(hashHue(tag)).toBe(h);
    }
  });
});

const key = (k: string, mods: Partial<KeyboardEventInit> = {}, code?: string) =>
  new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...mods });

describe('shortcut combos', () => {
  it('parses modifiers and aliases', () => {
    expect(parseCombo('Mod+Shift+K')).toMatchObject({ mod: true, shift: true, key: 'k' });
    expect(parseCombo('Esc').key).toBe('escape');
    expect(parseCombo('Space').key).toBe(' ');
    expect(parseCombo('Up').key).toBe('arrowup');
    expect(parseCombo('Mod++').key).toBe('+');
  });

  it('maps Mod to ⌘ on macOS and Ctrl elsewhere', () => {
    const p = parseCombo('Mod+K');
    expect(matchCombo(p, key('k', { metaKey: true }), true)).toBe(true);
    expect(matchCombo(p, key('k', { ctrlKey: true }), true)).toBe(false);
    expect(matchCombo(p, key('k', { ctrlKey: true }), false)).toBe(true);
    expect(matchCombo(p, key('k'), false)).toBe(false);
  });

  it('matches symbols regardless of Shift (Turkish Q: ? = Shift+*)', () => {
    expect(matchCombo(parseCombo('?'), key('?', { shiftKey: true }), true)).toBe(true);
    expect(matchCombo(parseCombo('/'), key('/', { shiftKey: true }), true)).toBe(true);
    expect(matchCombo(parseCombo('M'), key('M', { shiftKey: true }), true)).toBe(false);
    expect(matchCombo(parseCombo('M'), key('m'), true)).toBe(true);
  });

  it('falls back to physical codes (Option changes e.key on macOS)', () => {
    expect(matchCombo(parseCombo('Alt+K'), key('˚', { altKey: true }, 'KeyK'), true)).toBe(true);
    expect(matchCombo(parseCombo('Mod+1'), key('!', { metaKey: true }, 'Digit1'), true)).toBe(true);
  });

  it('renders labels per platform', () => {
    expect(comboLabels('Mod+Shift+K', true)).toEqual(['⇧', '⌘', 'K']);
    expect(comboLabels('Mod+Backspace', false)).toEqual(['Ctrl', 'Backspace']);
    expect(formatCombo('Mod+K', true)).toBe('⌘K');
    expect(formatCombo('Mod+K', false)).toBe('Ctrl+K');
  });
});

describe('shortcut manager', () => {
  const regs: { dispose(): void }[] = [];
  afterEach(() => {
    regs.splice(0).forEach((r) => r.dispose());
  });

  it('ignores plain keys in text fields but allows Mod combos and Escape', () => {
    const plain = vi.fn();
    const mod = vi.fn();
    const esc = vi.fn();
    regs.push(registerShortcut('G', plain), registerShortcut('Mod+K', mod), registerShortcut('Escape', esc));
    const input = document.createElement('input');
    const inInput = (e: KeyboardEvent) => {
      Object.defineProperty(e, 'target', { value: input });
      return e;
    };
    // jsdom is not macOS: Mod = Ctrl.
    expect(handleShortcutEvent(inInput(key('g')))).toBe(false);
    expect(handleShortcutEvent(inInput(key('k', { ctrlKey: true })))).toBe(true);
    expect(handleShortcutEvent(inInput(key('Escape')))).toBe(true);
    expect(plain).not.toHaveBeenCalled();
    expect(mod).toHaveBeenCalledTimes(1);
    expect(esc).toHaveBeenCalledTimes(1);
    // Outside inputs the plain key works.
    expect(handleShortcutEvent(key('g'))).toBe(true);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('runs the most recent / highest priority handler; false falls through', () => {
    const order: string[] = [];
    regs.push(
      registerShortcut('J', () => {
        order.push('old');
      }),
      registerShortcut('J', () => {
        order.push('new');
        return false;
      }),
      registerShortcut(
        'J',
        () => {
          order.push('low');
        },
        { priority: -10 },
      ),
    );
    const e = key('j');
    expect(handleShortcutEvent(e)).toBe(true);
    expect(order).toEqual(['new', 'old']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('suppresses global shortcuts while a modal is open unless allowed', () => {
    const normal = vi.fn();
    const modal = vi.fn();
    regs.push(registerShortcut('Mod+B', normal), registerShortcut('Mod+K', modal, { allowInModal: true }));
    const pop = pushModalLayer();
    handleShortcutEvent(key('b', { metaKey: true, ctrlKey: false }));
    handleShortcutEvent(key('b', { ctrlKey: true }));
    handleShortcutEvent(key('k', { metaKey: true }));
    handleShortcutEvent(key('k', { ctrlKey: true }));
    pop();
    expect(normal).not.toHaveBeenCalled();
    expect(modal).toHaveBeenCalledTimes(1);
  });

  it('skips auto-repeat unless allowed, and leaves Space on buttons alone', () => {
    const toggle = vi.fn();
    const move = vi.fn();
    regs.push(registerShortcut('Space', toggle), registerShortcut('ArrowDown', move, { allowRepeat: true }));
    handleShortcutEvent(key(' ', { repeat: true }));
    expect(toggle).not.toHaveBeenCalled();
    handleShortcutEvent(key('ArrowDown', { repeat: true }));
    expect(move).toHaveBeenCalledTimes(1);
    const btn = document.createElement('button');
    const e = key(' ');
    Object.defineProperty(e, 'target', { value: btn });
    handleShortcutEvent(e);
    expect(toggle).not.toHaveBeenCalled();
    handleShortcutEvent(key(' '));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
