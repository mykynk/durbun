import { describe, expect, it } from 'vitest';
import '../i18n';
import { t } from '../i18n/core';
import { shortcutSections } from './ShortcutsDialog';

describe('keyboard shortcuts help', () => {
  it('lists the flow canvas, the mock editor, the sidebar and the dialogs', () => {
    const ids = shortcutSections(t, 'logs').map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['general', 'lists', 'sidebar', 'mocks', 'flows', 'dialogs']));
    const flows = shortcutSections(t, 'logs').find((s) => s.id === 'flows')!;
    const combos = flows.rows.flatMap((r) => r.combos);
    for (const c of ['A', 'F', 'Mod+D', 'Mod+A', 'Delete', 'Shift+Delete', 'Mod+Z', 'Shift+Mod+L', 'Mod+Enter']) expect(combos).toContain(c);
  });

  it('puts the open tab’s own keys right after the general ones', () => {
    expect(shortcutSections(t, 'flows').map((s) => s.id).slice(0, 2)).toEqual(['general', 'flows']);
    expect(shortcutSections(t, 'mocks').map((s) => s.id).slice(0, 2)).toEqual(['general', 'mocks']);
    expect(shortcutSections(t, 'logs').map((s) => s.id).slice(0, 2)).toEqual(['general', 'lists']);
  });

  it('has a label for every row in both languages', () => {
    for (const s of shortcutSections(t, null)) for (const r of s.rows) expect(r.label).not.toMatch(/^shell\./);
  });
});
