import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { CornerDownLeft, Search } from 'lucide-react';
import { useT } from '../i18n';
import { ui, useUi } from '../data';
import { Dialog } from '../components/Dialog';
import { Kbd } from '../components/Kbd';
import { getAllCommands, type PaletteCommand } from '../lib/commands';
import { fuzzyFilter } from '../lib/fuzzy';
import { readStorage, writeStorage } from '../lib/persist';

const RECENT_KEY = 'palette.recent';
const MAX_RECENT = 5;

interface Row {
  cmd: PaletteCommand;
  indices: number[];
  /** Group heading shown before this row (empty query only). */
  heading?: string;
}

function HighlightedTitle({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  const parts: ReactNode[] = [];
  let buf = '';
  let inMatch = false;
  const flush = (key: number) => {
    if (!buf) return;
    parts.push(inMatch ? <b key={key}>{buf}</b> : <Fragment key={key}>{buf}</Fragment>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMatch) {
      flush(i);
      inMatch = m;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

/** Mod+K command palette: fuzzy search over navigation, scope switching and registered commands. */
export function CommandPalette() {
  const open = useUi((s) => s.palette);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(() => getAllCommands(), []);
  const recentIds = useMemo(() => readStorage<string[]>(RECENT_KEY, []), []);

  const rows = useMemo<Row[]>(() => {
    if (query.trim()) {
      return fuzzyFilter(commands, query, (c) => [c.title, `${c.group ?? ''} ${c.title} ${c.subtitle ?? ''}`, ...(c.keywords ?? [])], { limit: 80 }).map((r) => ({
        cmd: r.item,
        indices: r.indices,
      }));
    }
    const out: Row[] = [];
    const recent = recentIds.map((id) => commands.find((c) => c.id === id)).filter((c): c is PaletteCommand => Boolean(c));
    recent.forEach((cmd, i) => out.push({ cmd, indices: [], heading: i === 0 ? t('shell.palette.groups.recent') : undefined }));
    const groups = new Map<string, PaletteCommand[]>();
    for (const c of commands) {
      if (recent.includes(c)) continue;
      const g = c.group ?? t('shell.palette.groups.other');
      let list = groups.get(g);
      if (!list) groups.set(g, (list = []));
      list.push(c);
    }
    const order = [t('shell.palette.groups.navigation'), t('shell.palette.groups.general'), t('shell.palette.groups.data')];
    const scopeGroup = t('shell.palette.groups.scope');
    const sortedGroups = [...groups.keys()].sort((a, b) => {
      const ra = a === scopeGroup ? 99 : order.indexOf(a) >= 0 ? order.indexOf(a) : 50;
      const rb = b === scopeGroup ? 99 : order.indexOf(b) >= 0 ? order.indexOf(b) : 50;
      return ra - rb || a.localeCompare(b);
    });
    for (const g of sortedGroups) {
      const list = groups.get(g)!.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      list.forEach((cmd, i) => out.push({ cmd, indices: [], heading: i === 0 ? g : undefined }));
    }
    return out;
  }, [commands, query, recentIds, t]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (cmd: PaletteCommand) => {
    writeStorage(RECENT_KEY, [cmd.id, ...recentIds.filter((id) => id !== cmd.id)].slice(0, MAX_RECENT));
    ui.closePalette();
    // Let the palette unmount (and restore focus) before the command opens anything else.
    setTimeout(() => {
      try {
        void cmd.run();
      } catch (err) {
        console.error('[durbun] command failed', cmd.id, err);
      }
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActive((a) => (a + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((a) => (a - 1 + n) % n);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      if (n) setActive((a) => Math.min(n - 1, a + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      if (n) setActive((a) => Math.max(0, a - 8));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) run(row.cmd);
    }
  };

  const showGroupsInline = Boolean(query.trim());

  return (
    <Dialog open onClose={ui.closePalette} bare size="md" className="palette" initialFocus={inputRef} aria-label={t('shell.palette.title')}>
      <div className="palette__input-row">
        <Search size={16} className="palette__search-icon" aria-hidden />
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('shell.palette.placeholder')}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={rows[active] ? `palette-row-${active}` : undefined}
        />
        <Kbd combo="Escape" size="sm" />
      </div>
      <div ref={listRef} id="palette-list" className="palette__list" role="listbox" aria-label={t('shell.palette.title')}>
        {rows.length === 0 ? <div className="palette__empty">{t('shell.palette.empty', { query })}</div> : null}
        {rows.map((row, i) => {
          const Icon = row.cmd.icon;
          return (
            <Fragment key={`${row.cmd.id}-${i}`}>
              {row.heading ? <div className="palette__heading">{row.heading}</div> : null}
              <div
                id={`palette-row-${i}`}
                data-row={i}
                role="option"
                aria-selected={i === active}
                className={clsx('palette__item', i === active && 'is-active')}
                onPointerMove={() => i !== active && setActive(i)}
                onClick={() => run(row.cmd)}
              >
                <span className="palette__icon">{Icon ? <Icon size={15} aria-hidden /> : null}</span>
                <span className="palette__title truncate">
                  <HighlightedTitle text={row.cmd.title} indices={row.indices} />
                </span>
                {row.cmd.subtitle ? <span className="palette__subtitle truncate">{row.cmd.subtitle}</span> : null}
                {showGroupsInline && row.cmd.group ? <span className="palette__group">{row.cmd.group}</span> : null}
                {row.cmd.shortcut ? <Kbd combo={row.cmd.shortcut} size="sm" className="palette__kbd" /> : null}
                {i === active ? <CornerDownLeft size={13} className="palette__enter" aria-hidden /> : null}
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="palette__footer">
        <span>
          <Kbd combo="ArrowUp" size="sm" /> <Kbd combo="ArrowDown" size="sm" /> {t('shell.palette.navigate')}
        </span>
        <span>
          <Kbd combo="Enter" size="sm" /> {t('shell.palette.run')}
        </span>
        <span>
          <Kbd combo="Escape" size="sm" /> {t('common.close')}
        </span>
      </div>
    </Dialog>
  );
}
