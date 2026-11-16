import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { Search, TriangleAlert } from 'lucide-react';
import { FLOW_NODE_SPECS } from '@durbun/protocol';
import { Popover } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { nodeIcon } from '../model/icons';
import { rankSteps, stepSupport, type PickerTarget } from '../model/picker';
import { GROUP_COLOR, groupTitle, nodeDescription, nodeTitle } from '../model/text';
import { codeText } from './CodeText';

export interface NodePickerProps {
  open: boolean;
  /** Client point the picker opens at. */
  at: { x: number; y: number } | null;
  /** Triggers cannot follow another step. */
  hideTriggers?: boolean;
  /** The device the flow runs on: steps it cannot run are marked (they can still be added). */
  target?: PickerTarget | null;
  onPick(type: string): void;
  onClose(): void;
}

export function NodePicker({ open, at, hideTriggers, target, onPick, onClose }: NodePickerProps) {
  const t = useT();
  const lang = useLanguage();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const searching = !!query.trim();
  const items = useMemo(() => rankSteps(FLOW_NODE_SPECS.filter((s) => !(hideTriggers && s.group === 'trigger')), query, lang), [query, hideTriggers, lang]);
  const whereText = (places: string[]) => places.map((p) => t(`flows.picker.place.${p}`)).join(', ');

  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };
  const pick = (type: string) => {
    setQuery('');
    setActive(0);
    onPick(type);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (!n) return;
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      setActive(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = items[active];
      if (s) pick(s.type);
    }
  };

  let lastGroup = '';
  return (
    <Popover open={open && !!at} onClose={close} anchor={at} side="bottom" align="start" width={360} className="fl-picker" aria-label={t('flows.picker.title')}>
      <div className="fl-picker__search">
        <Search size={14} aria-hidden />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          placeholder={t('flows.picker.search')}
          aria-label={t('flows.picker.search')}
          aria-controls="fl-picker-list"
          aria-activedescendant={items[active] ? `fl-pick-${items[active]!.type}` : undefined}
          autoFocus
        />
      </div>
      {target ? <div className="fl-picker__target">{t('flows.picker.target', { device: target.name })}</div> : null}
      <div className="fl-picker__list" ref={listRef} id="fl-picker-list" role="listbox" aria-label={t('flows.picker.title')}>
        {items.length === 0 ? <div className="fl-picker__empty">{t('flows.picker.none')}</div> : null}
        {items.map((s, i) => {
          const Icon = nodeIcon(s.type);
          // A search ranks the best match first: group headers would repeat, so they show only without one.
          const header = !searching && s.group !== lastGroup ? groupTitle(s.group, lang) : null;
          lastGroup = s.group;
          const support = stepSupport(s, target ?? null);
          const unsupported = !support.ok ? t('flows.picker.unsupported', { device: target?.name ?? '', where: whereText(support.where) }) : null;
          return (
            <div key={s.type}>
              {header ? <div className="fl-picker__group">{header}</div> : null}
              <div
                id={`fl-pick-${s.type}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={clsx('fl-picker__item', i === active && 'is-active', unsupported && 'is-unsupported')}
                title={unsupported ?? undefined}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(s.type)}
              >
                <span className="fl-picker__icon" style={{ color: GROUP_COLOR[s.group] }} aria-hidden>
                  <Icon size={15} />
                </span>
                <span className="fl-picker__text">
                  <span className="fl-picker__name">
                    {nodeTitle(s.type, lang)}
                    {s.irreversible ? <TriangleAlert size={12} className="fl-picker__warn" aria-label={t('flows.picker.irreversible')} /> : null}
                    {s.needs?.sdk ? <span className="fl-picker__tag">SDK</span> : null}
                    {unsupported ? <span className="fl-picker__tag is-unsupported">{support.where.length ? t('flows.picker.onlyOn', { where: whereText(support.where) }) : t('flows.picker.notHere')}</span> : null}
                  </span>
                  <span className="fl-picker__desc">{codeText(nodeDescription(s.type, lang))}</span>
                  {unsupported ? <span className="sr-only">{unsupported}</span> : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
