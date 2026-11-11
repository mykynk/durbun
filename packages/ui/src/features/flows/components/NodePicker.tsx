import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { Search, TriangleAlert } from 'lucide-react';
import { FLOW_NODE_GROUPS, FLOW_NODE_SPECS, type FlowNodeSpec } from '@durbun/protocol';
import { Popover } from '../../../components';
import { fold } from '../../../lib/fuzzy';
import { useLanguage, useT } from '../../../i18n';
import { nodeIcon } from '../model/icons';
import { GROUP_COLOR, groupTitle, nodeDescription, nodeTitle } from '../model/text';
import { codeText } from './CodeText';

export interface NodePickerProps {
  open: boolean;
  /** Client point the picker opens at. */
  at: { x: number; y: number } | null;
  /** Triggers cannot follow another step. */
  hideTriggers?: boolean;
  onPick(type: string): void;
  onClose(): void;
}

/** Search keywords besides the titles, so "deep link", "screenshot", "bekle" find the right step in both languages. */
const EXTRA_KEYWORDS: Record<string, string> = {
  'http.request': 'api endpoint get post put delete istek request',
  'wait.network': 'request istek api response yanıt',
  'logic.condition': 'if else eğer koşul branch dal',
  'logic.repeat': 'loop döngü poll tekrar foreach liste',
  'check.assert': 'assert expect doğrula kontrol test',
  'device.openUrl': 'deep link bağlantı url',
  'device.screenshot': 'ekran görüntüsü capture evidence kanıt',
  'device.startRecording': 'video kayıt record',
  'mock.add': 'fake sahte stub',
  'output.slack': 'mesaj message bildirim',
  'flow.call': 'sub-flow alt akış call reuse',
};

export function NodePicker({ open, at, hideTriggers, onPick, onClose }: NodePickerProps) {
  const t = useT();
  const lang = useLanguage();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const q = fold(query.trim());
    const specs = FLOW_NODE_SPECS.filter((s) => !(hideTriggers && s.group === 'trigger'));
    const match = (s: FlowNodeSpec) => {
      if (!q) return true;
      const hay = fold(`${nodeTitle(s.type, lang)} ${s.title} ${s.type} ${nodeDescription(s.type, lang)} ${EXTRA_KEYWORDS[s.type] ?? ''}`);
      return q.split(/\s+/).every((w) => hay.includes(w));
    };
    const out: FlowNodeSpec[] = [];
    for (const g of FLOW_NODE_GROUPS) for (const s of specs) if (s.group === g && match(s)) out.push(s);
    return out;
  }, [query, hideTriggers, lang]);

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
      <div className="fl-picker__list" ref={listRef} id="fl-picker-list" role="listbox" aria-label={t('flows.picker.title')}>
        {items.length === 0 ? <div className="fl-picker__empty">{t('flows.picker.none')}</div> : null}
        {items.map((s, i) => {
          const Icon = nodeIcon(s.type);
          const header = s.group !== lastGroup ? groupTitle(s.group, lang) : null;
          lastGroup = s.group;
          return (
            <div key={s.type}>
              {header ? <div className="fl-picker__group">{header}</div> : null}
              <div
                id={`fl-pick-${s.type}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={clsx('fl-picker__item', i === active && 'is-active')}
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
                  </span>
                  <span className="fl-picker__desc">{codeText(nodeDescription(s.type, lang))}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
