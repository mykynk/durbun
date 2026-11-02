import { useMemo } from 'react';
import { Keyboard } from 'lucide-react';
import { useT } from '../i18n';
import { ui, useUi } from '../data';
import { Dialog } from '../components/Dialog';
import { Kbd } from '../components/Kbd';
import { getAllCommands } from '../lib/commands';

interface ShortcutRow {
  combos: string[];
  label: string;
}

/** "?" — keyboard shortcuts reference (static list + registered feature commands). */
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcuts);
  const t = useT();
  const sections = useMemo(() => {
    if (!open) return [];
    const general: ShortcutRow[] = [
      { combos: ['Mod+K'], label: t('shell.shortcuts.palette') },
      { combos: ['?'], label: t('shell.shortcuts.help') },
      { combos: ['Mod+1', 'Mod+5'], label: t('shell.shortcuts.tabs') },
      { combos: ['Mod+,'], label: t('shell.settings.title') },
      { combos: ['Mod+B'], label: t('shell.shortcuts.sidebar') },
      { combos: ['Escape'], label: t('shell.shortcuts.escape') },
    ];
    const lists: ShortcutRow[] = [
      { combos: ['/', 'Mod+F'], label: t('shell.shortcuts.search') },
      { combos: ['Space'], label: t('shell.shortcuts.pause') },
      { combos: ['G'], label: t('shell.shortcuts.follow') },
      { combos: ['M'], label: t('shell.marker.add') },
      { combos: ['Mod+Backspace'], label: t('shell.shortcuts.clear') },
      { combos: ['ArrowUp', 'ArrowDown'], label: t('shell.shortcuts.move') },
      { combos: ['K', 'J'], label: t('shell.shortcuts.moveVim') },
      { combos: ['Enter'], label: t('shell.shortcuts.open') },
    ];
    const known = new Set([...general, ...lists].flatMap((r) => r.combos));
    for (let i = 1; i <= 9; i++) known.add(`Mod+${i}`);
    const feature: ShortcutRow[] = getAllCommands()
      .filter((c) => c.shortcut && !known.has(c.shortcut))
      .map((c) => ({ combos: [c.shortcut!], label: c.group ? `${c.group} · ${c.title}` : c.title }));
    return [
      { title: t('shell.shortcuts.general'), rows: general },
      { title: t('shell.shortcuts.lists'), rows: lists },
      ...(feature.length ? [{ title: t('shell.shortcuts.feature'), rows: feature }] : []),
    ];
  }, [open, t]);

  return (
    <Dialog open={open} onClose={ui.closeShortcuts} title={t('shell.shortcuts.title')} icon={Keyboard} size="lg" description={t('shell.shortcuts.description')}>
      <div className="shortcuts">
        {sections.map((s) => (
          <section key={s.title} className="shortcuts__section">
            <h3 className="shortcuts__title">{s.title}</h3>
            <dl className="shortcuts__list">
              {s.rows.map((r) => (
                <div key={r.label} className="shortcuts__row">
                  <dt>{r.label}</dt>
                  <dd>
                    {r.combos.map((c, i) => (
                      <span key={c} className="shortcuts__combo">
                        {i > 0 ? <span className="shortcuts__or">{r.combos.length === 2 && r.combos[0]!.startsWith('Mod+') && r.combos[1]!.startsWith('Mod+') && /\d$/.test(c) ? '…' : t('shell.shortcuts.or')}</span> : null}
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
