import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Copy, Ellipsis, GripVertical, Pencil, Trash2 } from 'lucide-react';
import type { MockRule } from '@durbun/protocol';
import { DropdownMenu, IconButton, MethodBadge, TagChip, Toggle, Tooltip, type MenuItem } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { actionSummary, dropTarget, ruleLabel } from '../model/rules';

export interface RuleListProps {
  rules: readonly MockRule[];
  /** Rules shown (search); reordering is only possible when every rule is shown. */
  visibleIds: ReadonlySet<string> | null;
  selectedId: string | null;
  hits: ReadonlyMap<string, number>;
  appNames: ReadonlyMap<string, string>;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export function RuleList({ rules, visibleIds, selectedId, hits, appNames, onOpen, onToggle, onMove, onDuplicate, onDelete }: RuleListProps) {
  const t = useT();
  const lang = useLanguage();
  const [armed, setArmed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);
  const reorderable = visibleIds === null;

  const indexOf = (id: string) => rules.findIndex((r) => r.id === id);

  const onDragStart = (e: DragEvent<HTMLLIElement>, id: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDragId(id);
  };
  const onDragOver = (e: DragEvent<HTMLLIElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
  };
  const onDrop = (e: DragEvent<HTMLLIElement>, id: string) => {
    e.preventDefault();
    const from = dragId ? indexOf(dragId) : -1;
    const over = indexOf(id);
    if (from >= 0 && over >= 0 && drop) {
      const to = dropTarget(from, over, drop.pos);
      if (to !== from) onMove(from, to);
    }
    endDrag();
  };
  const endDrag = () => {
    setDragId(null);
    setDrop(null);
    setArmed(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (!reorderable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = e.key === 'ArrowUp' ? index - 1 : index + 1;
    if (to >= 0 && to < rules.length) onMove(index, to);
  };

  const shown = visibleIds ? rules.filter((r) => visibleIds.has(r.id)) : rules;

  return (
    <ul className="mk-list" aria-label={t('mocks.list.label')}>
      {shown.map((r) => {
        const index = indexOf(r.id);
        const name = ruleLabel(r);
        const count = hits.get(r.id) ?? 0;
        const menu: MenuItem[] = [
          { label: t('mocks.list.edit'), icon: Pencil, onSelect: () => onOpen(r.id) },
          { label: t('mocks.list.duplicate'), icon: Copy, onSelect: () => onDuplicate(r.id) },
          { type: 'separator' },
          { label: t('mocks.order.moveUp'), icon: ArrowUp, shortcut: 'Alt+ArrowUp', disabled: !reorderable || index === 0, onSelect: () => onMove(index, index - 1) },
          { label: t('mocks.order.moveDown'), icon: ArrowDown, shortcut: 'Alt+ArrowDown', disabled: !reorderable || index === rules.length - 1, onSelect: () => onMove(index, index + 1) },
          { type: 'separator' },
          { label: t('mocks.list.delete'), icon: Trash2, danger: true, onSelect: () => onDelete(r.id) },
        ];
        return (
          <li
            key={r.id}
            className={clsx(
              'mk-rule',
              r.id === selectedId && 'is-selected',
              !r.enabled && 'is-off',
              r.id === dragId && 'is-dragging',
              drop?.id === r.id && drop.id !== dragId && `is-drop-${drop.pos}`,
            )}
            draggable={reorderable && armed === r.id}
            onDragStart={(e) => onDragStart(e, r.id)}
            onDragOver={(e) => onDragOver(e, r.id)}
            onDrop={(e) => onDrop(e, r.id)}
            onDragEnd={endDrag}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            <span
              className={clsx('mk-rule__grip', !reorderable && 'is-disabled')}
              title={reorderable ? t('mocks.order.dragHint') : t('mocks.order.searchNoDrag')}
              onPointerDown={() => reorderable && setArmed(r.id)}
              onPointerUp={() => setArmed(null)}
              aria-hidden
            >
              <GripVertical size={14} />
            </span>
            <span className="mk-rule__pos tnum" aria-hidden>
              {index + 1}
            </span>
            <Toggle size="sm" checked={r.enabled} onChange={(v) => onToggle(r.id, v)} aria-label={`${r.enabled ? t('mocks.list.disable') : t('mocks.list.enable')}: ${name}`} />
            <button type="button" className="mk-rule__main" onClick={() => onOpen(r.id)} aria-current={r.id === selectedId ? 'true' : undefined}>
              <span className="mk-rule__line">
                {r.method === '*' ? <span className="mk-anymethod">{t('mocks.methodAny')}</span> : <MethodBadge method={r.method} />}
                <span className="mk-rule__name truncate">{name}</span>
              </span>
              <span className="mk-rule__line mk-rule__line--sub">
                <span className="mk-match">{t(`mocks.match.${r.match}`)}</span>
                <span className="mk-rule__url mono truncate" title={r.url}>
                  {r.url}
                </span>
              </span>
              <span className="mk-rule__line mk-rule__line--sub">
                <span className={clsx('mk-action', `mk-action--${r.action.type}`, r.action.type === 'respond' && r.action.status >= 400 && 'mk-action--err')}>{actionSummary(r.action, t, lang)}</span>
                {r.apps && r.apps.length > 0 ? (
                  r.apps.slice(0, 3).map((a) => <TagChip key={a} name={appNames.get(a) ?? a} title={a} maxWidth={140} />)
                ) : (
                  <span className="mk-allapps">{t('mocks.list.allApps')}</span>
                )}
                {r.apps && r.apps.length > 3 ? <span className="mk-allapps">+{r.apps.length - 3}</span> : null}
              </span>
            </button>
            <Tooltip content={t('mocks.list.hitsTitle')}>
              <span className={clsx('mk-rule__hits tnum', count > 0 && 'has-hits')}>{t('mocks.list.hits', { count })}</span>
            </Tooltip>
            <span className="mk-rule__tools">
              <IconButton icon={Copy} size="sm" label={t('mocks.list.duplicate')} onClick={() => onDuplicate(r.id)} />
              <IconButton icon={Trash2} size="sm" label={t('mocks.list.delete')} tone="danger" onClick={() => onDelete(r.id)} />
              <DropdownMenu items={menu} aria-label={t('mocks.list.more', { name })}>
                {(p) => <IconButton icon={Ellipsis} size="sm" label={t('mocks.list.more', { name })} {...p} />}
              </DropdownMenu>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
