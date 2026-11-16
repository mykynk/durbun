import { useMemo } from 'react';
import { Keyboard } from 'lucide-react';
import { useT } from '../i18n';
import { ui, useUi, type TabId } from '../data';
import { Dialog } from '../components/Dialog';
import { Kbd } from '../components/Kbd';
import { getAllCommands } from '../lib/commands';

interface ShortcutRow {
  combos: string[];
  label: string;
  /** How the combos read: "or" (default) or a range ("Mod+1 … Mod+6"). */
  join?: 'or' | 'range' | 'slash';
}

interface ShortcutSection {
  id: string;
  title: string;
  rows: ShortcutRow[];
  /** The tab the section belongs to: shown right after "General" while that tab is open. */
  tab?: TabId;
}

type T = ReturnType<typeof useT>;

/**
 * Every keyboard shortcut of the app, by place. The lists mirror the `useShortcut` registrations of each view (the
 * canvas, the mock editor, the dialogs); registered palette commands with a shortcut that is not listed here are
 * added under "View commands", so nothing a view adds goes missing.
 */
export function shortcutSections(t: T, tab: TabId | null): ShortcutSection[] {
  const sections: ShortcutSection[] = [
    {
      id: 'general',
      title: t('shell.shortcuts.general'),
      rows: [
        { combos: ['Mod+K'], label: t('shell.shortcuts.palette') },
        { combos: ['?'], label: t('shell.shortcuts.help') },
        { combos: ['Mod+1', 'Mod+6'], label: t('shell.shortcuts.tabs'), join: 'range' },
        { combos: ['Mod+,'], label: t('shell.settings.title') },
        { combos: ['Mod+B'], label: t('shell.shortcuts.sidebar') },
        { combos: ['M'], label: t('shell.marker.add') },
        { combos: ['Escape'], label: t('shell.shortcuts.escape') },
      ],
    },
    {
      id: 'lists',
      title: t('shell.shortcuts.lists'),
      rows: [
        { combos: ['/', 'Mod+F'], label: t('shell.shortcuts.search') },
        { combos: ['Space'], label: t('shell.shortcuts.pause') },
        { combos: ['G'], label: t('shell.shortcuts.follow') },
        { combos: ['ArrowUp', 'ArrowDown'], label: t('shell.shortcuts.move'), join: 'slash' },
        { combos: ['K', 'J'], label: t('shell.shortcuts.moveVim'), join: 'slash' },
        { combos: ['PageUp', 'PageDown'], label: t('shell.shortcuts.page'), join: 'slash' },
        { combos: ['Enter'], label: t('shell.shortcuts.open') },
        { combos: ['Shift+F10'], label: t('shell.shortcuts.menu') },
        { combos: ['Mod+Backspace'], label: t('shell.shortcuts.clear') },
        { combos: ['Shift+Mod+Backspace'], label: t('shell.shortcuts.clearNoConfirm') },
      ],
    },
    {
      id: 'sidebar',
      title: t('shell.shortcuts.sidebarTitle'),
      rows: [
        { combos: ['ArrowUp', 'ArrowDown'], label: t('shell.shortcuts.sidebarMove'), join: 'slash' },
        { combos: ['Home', 'End'], label: t('shell.shortcuts.sidebarEnds'), join: 'slash' },
        { combos: ['I'], label: t('shell.shortcuts.sidebarInfo') },
      ],
    },
    {
      id: 'mocks',
      tab: 'mocks',
      title: t('shell.shortcuts.mocksTitle'),
      rows: [
        { combos: ['Alt+ArrowUp', 'Alt+ArrowDown'], label: t('shell.shortcuts.mockOrder'), join: 'slash' },
        { combos: ['Mod+S'], label: t('shell.shortcuts.mockSave') },
        { combos: ['Escape'], label: t('shell.shortcuts.mockClose') },
      ],
    },
    {
      id: 'flows',
      tab: 'flows',
      title: t('shell.shortcuts.flowsTitle'),
      rows: [
        { combos: ['A'], label: t('shell.shortcuts.flowAdd') },
        { combos: ['Mod+Enter'], label: t('shell.shortcuts.flowRun') },
        { combos: ['F'], label: t('shell.shortcuts.flowFit') },
        { combos: ['Delete', 'Backspace'], label: t('shell.shortcuts.flowDelete') },
        { combos: ['Shift+Delete'], label: t('shell.shortcuts.flowDeleteBridged') },
        { combos: ['Mod+D'], label: t('shell.shortcuts.flowDuplicate') },
        { combos: ['Mod+C', 'Mod+X', 'Mod+V'], label: t('shell.shortcuts.flowClipboard'), join: 'slash' },
        { combos: ['Mod+A'], label: t('shell.shortcuts.flowSelectAll') },
        { combos: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], label: t('shell.shortcuts.flowNudge'), join: 'slash' },
        { combos: ['Mod+Z'], label: t('shell.shortcuts.flowUndo') },
        { combos: ['Shift+Mod+Z', 'Mod+Y'], label: t('shell.shortcuts.flowRedo') },
        { combos: ['Shift+Mod+L'], label: t('shell.shortcuts.flowTidy') },
        { combos: ['Escape'], label: t('shell.shortcuts.flowDeselect') },
      ],
    },
    {
      id: 'dialogs',
      title: t('shell.shortcuts.dialogsTitle'),
      rows: [
        { combos: ['Mod+Enter'], label: t('shell.shortcuts.dialogSend') },
        { combos: ['Mod+S'], label: t('shell.shortcuts.dialogSave') },
        { combos: ['Escape'], label: t('shell.shortcuts.dialogClose') },
      ],
    },
  ];
  // The open tab's own keys come right after the general ones.
  const own = sections.findIndex((s) => s.tab && s.tab === tab);
  if (own > 1) sections.splice(1, 0, ...sections.splice(own, 1));
  return sections;
}

/** "?" — keyboard shortcuts reference (static list + registered feature commands). */
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcuts);
  const tab = useUi((s) => s.tab);
  const t = useT();
  const sections = useMemo(() => {
    if (!open) return [];
    const list = shortcutSections(t, tab);
    const known = new Set(list.flatMap((s) => s.rows.flatMap((r) => r.combos)));
    for (let i = 1; i <= 9; i++) known.add(`Mod+${i}`);
    const feature: ShortcutRow[] = getAllCommands()
      .filter((c) => c.shortcut && !known.has(c.shortcut))
      .map((c) => ({ combos: [c.shortcut!], label: c.group ? `${c.group} · ${c.title}` : c.title }));
    return feature.length ? [...list, { id: 'feature', title: t('shell.shortcuts.feature'), rows: feature }] : list;
  }, [open, t, tab]);

  return (
    <Dialog open={open} onClose={ui.closeShortcuts} title={t('shell.shortcuts.title')} icon={Keyboard} size="xl" description={t('shell.shortcuts.description')}>
      <div className="shortcuts">
        {sections.map((s) => (
          <section key={s.id} className="shortcuts__section" aria-labelledby={`shortcuts-${s.id}`}>
            <h3 className="shortcuts__title" id={`shortcuts-${s.id}`}>
              {s.title}
            </h3>
            <dl className="shortcuts__list">
              {s.rows.map((r) => (
                <div key={r.label} className="shortcuts__row">
                  <dt>{r.label}</dt>
                  <dd>
                    {r.combos.map((c, i) => (
                      <span key={c} className="shortcuts__combo">
                        {i > 0 ? <span className="shortcuts__or">{r.join === 'range' ? '…' : r.join === 'slash' ? '/' : t('shell.shortcuts.or')}</span> : null}
                        <Kbd combo={c} />
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
