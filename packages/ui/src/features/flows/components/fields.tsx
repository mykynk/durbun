/**
 * Form fields of the node inspector. Text fields understand {{templates}}: typing `{{` (or the {…} button) lists
 * what the step can read — earlier steps' outputs (JSON paths from the last run), variables, inputs, environment.
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Braces, Plus, X } from 'lucide-react';
import { FLOW_CONDITION_OPS, templateSyntaxError, UNARY_OPS, type FlowConditionOp } from '@durbun/protocol';
import { IconButton, Popover, Select, Tooltip } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { applySuggestion, filterSuggestions, openTemplateAt, pipeSuggestions, type SuggestionKind, type TemplateSuggestion } from '../model/templates';
import { formatSpan, opLabel } from '../model/text';

/* ───────────── template scope ───────────── */

export interface TemplateScopeValue {
  suggestions: () => TemplateSuggestion[];
}

export const TemplateScope = createContext<TemplateScopeValue>({ suggestions: () => [] });

const KIND_KEY: Record<SuggestionKind, string> = {
  step: 'flows.tpl.kind.step',
  var: 'flows.tpl.kind.var',
  input: 'flows.tpl.kind.input',
  env: 'flows.tpl.kind.env',
  run: 'flows.tpl.kind.run',
  target: 'flows.tpl.kind.target',
  trigger: 'flows.tpl.kind.trigger',
  item: 'flows.tpl.kind.item',
  helper: 'flows.tpl.kind.helper',
  pipe: 'flows.tpl.kind.pipe',
};

/* ───────────── template input ───────────── */

export interface TemplateInputProps {
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  invalid?: boolean;
  id?: string;
  'aria-label'?: string;
  /** No {{template}} help (plain names). */
  plain?: boolean;
  className?: string;
  onBlur?(): void;
}

export function TemplateInput({ value, onChange, multiline, rows = 3, placeholder, invalid, id, plain, className, onBlur, ...aria }: TemplateInputProps) {
  const t = useT();
  const scope = useContext(TemplateScope);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ start: number; query: string; pipe: boolean; all: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();

  const all = useMemo(() => (menu ? (menu.pipe ? pipeSuggestions() : scope.suggestions()) : []), [menu?.pipe, !!menu, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => (menu ? filterSuggestions(all, menu.all ? '' : menu.query, 60) : []), [all, menu]);
  const syntax = plain ? null : templateSyntaxError(value);

  const refresh = (text: string, caret: number) => {
    if (plain) return;
    const open = openTemplateAt(text, caret);
    if (open) {
      setMenu({ ...open, all: false });
      setActive(0);
    } else if (menu && !menu.all) setMenu(null);
  };

  const apply = (s: TemplateSuggestion) => {
    const el = inputRef.current;
    if (!el || !menu) return;
    const caret = el.selectionStart ?? value.length;
    let next: { text: string; caret: number };
    if (menu.all) {
      // Inserted from the {…} button at the caret.
      const insert = `{{${s.expr}}}`;
      next = { text: value.slice(0, caret) + insert + value.slice(el.selectionEnd ?? caret), caret: caret + insert.length };
    } else next = applySuggestion(value, caret, menu, s.expr);
    onChange(next.text);
    setMenu(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!menu || items.length === 0) {
      if (menu && e.key === 'Escape') {
        e.stopPropagation();
        setMenu(null);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const s = items[active];
      if (s) apply(s);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    }
  };

  useEffect(() => {
    const el = wrapRef.current?.querySelector(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const common = {
    ref: inputRef,
    id,
    value,
    placeholder,
    spellCheck: false,
    autoComplete: 'off',
    className: clsx('fl-input', 'fl-tpl__field', multiline && 'is-multiline', (invalid || (syntax && !menu)) && 'is-invalid'),
    'aria-invalid': invalid || !!syntax || undefined,
    'aria-autocomplete': plain ? undefined : ('list' as const),
    'aria-controls': menu ? listId : undefined,
    onKeyDown,
    onBlur: () => {
      // Clicking a suggestion blurs first; the list closes after the click.
      setTimeout(() => {
        if (!wrapRef.current?.contains(document.activeElement)) setMenu(null);
      }, 120);
      onBlur?.();
    },
    onSelect: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      if (menu && !menu.all) refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
    },
    ...aria,
  };

  return (
    <div className={clsx('fl-tpl', className)} ref={wrapRef}>
      <div className="fl-tpl__box">
        {multiline ? (
          <textarea
            {...common}
            rows={rows}
            onChange={(e) => {
              onChange(e.target.value);
              refresh(e.target.value, e.target.selectionStart ?? 0);
            }}
          />
        ) : (
          <input
            {...common}
            type="text"
            onChange={(e) => {
              onChange(e.target.value);
              refresh(e.target.value, e.target.selectionStart ?? 0);
            }}
          />
        )}
        {plain ? null : (
          <Tooltip content={t('flows.tpl.insert')}>
            <button
              type="button"
              className="fl-tpl__btn"
              aria-label={t('flows.tpl.insert')}
              aria-haspopup="listbox"
              aria-expanded={!!menu?.all}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                inputRef.current?.focus();
                setMenu(menu?.all ? null : { start: 0, query: '', pipe: false, all: true });
                setActive(0);
              }}
            >
              <Braces size={13} aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      {/* While the suggestion list is open the template is still being typed: no error yet. */}
      {syntax && !menu ? <div className="fl-field-error">{t('flows.tpl.syntax', { error: syntax })}</div> : null}
      <Popover open={!!menu && items.length > 0} onClose={() => setMenu(null)} anchor={wrapRef} side="bottom" align="start" width="anchor" autoFocus={false} role="listbox" className="fl-tpl__menu">
        <div id={listId} role="listbox" aria-label={t('flows.tpl.title')} onMouseDown={(e) => e.preventDefault()}>
          {items.map((s, i) => (
            <div
              key={s.expr}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={clsx('fl-tpl__item', i === active && 'is-active')}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => apply(s)}
            >
              <span className={clsx('fl-tpl__kind', `is-${s.kind}`)}>{t(KIND_KEY[s.kind])}</span>
              <span className="fl-tpl__expr">{s.expr}</span>
              {s.sample !== undefined ? <span className="fl-tpl__sample">{s.sample}</span> : s.detail ? <span className="fl-tpl__detail">{s.detail}</span> : null}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}

/* ───────────── field frame ───────────── */

/** `name` marks the field so a problem in the list can take the user to it (`id`, `params.url`). */
export function FieldRow({ label, hint, error, children, htmlFor, required, aside, name }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string; required?: boolean; aside?: ReactNode; name?: string }) {
  const t = useT();
  return (
    <div className={clsx('fl-field', error && 'has-error')} data-field={name}>
      <div className="fl-field__head">
        <label className="fl-field__label" htmlFor={htmlFor}>
          {label}
          {required ? (
            <span className="fl-field__req" title={t('flows.field.required')}>
              *
            </span>
          ) : null}
        </label>
        {aside}
      </div>
      {children}
      {error ? <div className="fl-field-error">{error}</div> : hint ? <div className="fl-field__hint">{hint}</div> : null}
    </div>
  );
}

/* ───────────── list editors ───────────── */

/**
 * Stable React keys for rows that are plain values (no ids): removing a middle row keeps the focus, the caret and
 * the open suggestion list of the rows after it where they were. Rows added or removed elsewhere (undo) resync.
 */
export function useRowKeys(count: number): { keys: number[]; removed(i: number): void } {
  const keys = useRef<number[]>([]);
  const seq = useRef(0);
  while (keys.current.length < count) keys.current.push(++seq.current);
  if (keys.current.length > count) keys.current.length = count;
  return { keys: keys.current, removed: (i) => void keys.current.splice(i, 1) };
}

function RowList<T>({ rows, onChange, render, empty, addLabel, make, label }: { rows: T[]; onChange(rows: T[]): void; render(row: T, set: (row: T) => void, i: number): ReactNode; empty?: string; addLabel: string; make(): T; label: string }) {
  const t = useT();
  const { keys, removed } = useRowKeys(rows.length);
  return (
    <div className="fl-rows" role="group" aria-label={label}>
      {rows.length === 0 && empty ? <div className="fl-rows__empty">{empty}</div> : null}
      {rows.map((row, i) => (
        <div key={keys[i]} className="fl-rows__row">
          <div className="fl-rows__cells">{render(row, (next) => onChange(rows.map((r, j) => (j === i ? next : r))), i)}</div>
          <IconButton
            icon={X}
            size="xs"
            label={t('flows.field.removeRow')}
            onClick={() => {
              removed(i);
              onChange(rows.filter((_, j) => j !== i));
            }}
          />
        </div>
      ))}
      <button type="button" className="fl-rows__add" onClick={() => onChange([...rows, make()])}>
        <Plus size={12} aria-hidden />
        {addLabel}
      </button>
    </div>
  );
}

export function KeyValueEditor({ value, onChange, label, keyPlaceholder, valuePlaceholder }: { value: unknown; onChange(v: [string, string][]): void; label: string; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const t = useT();
  const rows = toPairs(value);
  return (
    <RowList
      label={label}
      rows={rows}
      onChange={onChange}
      addLabel={t('flows.field.addRow')}
      make={() => ['', ''] as [string, string]}
      render={(row, set) => (
        <div className="fl-kv">
          <input className="fl-input mono" value={row[0]} placeholder={keyPlaceholder ?? t('flows.field.name')} aria-label={t('flows.field.name')} spellCheck={false} onChange={(e) => set([e.target.value, row[1]])} />
          <TemplateInput value={row[1]} placeholder={valuePlaceholder ?? t('flows.field.value')} aria-label={t('flows.field.value')} onChange={(v) => set([row[0], v])} />
        </div>
      )}
    />
  );
}

export function toPairs(value: unknown): [string, string][] {
  if (Array.isArray(value)) return value.filter((r) => Array.isArray(r)).map((r) => [String((r as unknown[])[0] ?? ''), String((r as unknown[])[1] ?? '')]);
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
  return [];
}

interface RuleRow {
  left: string;
  op: FlowConditionOp;
  right?: string;
  message?: string;
}

export function RulesEditor({ value, onChange, withMessage, label }: { value: unknown; onChange(rows: RuleRow[]): void; withMessage?: boolean; label: string }) {
  const t = useT();
  const lang = useLanguage();
  const rows = (Array.isArray(value) ? value : []) as RuleRow[];
  const ops = FLOW_CONDITION_OPS.map((o) => ({ value: o.op, label: opLabel(o.op, lang) }));
  return (
    <RowList
      label={label}
      rows={rows}
      onChange={onChange}
      empty={t('flows.field.noRules')}
      addLabel={withMessage ? t('flows.field.addCheck') : t('flows.field.addRule')}
      make={() => ({ left: '', op: 'equals' as const, right: '' })}
      render={(row, set) => (
        <div className="fl-rule">
          <TemplateInput value={row.left ?? ''} placeholder={t('flows.field.ruleLeft')} aria-label={t('flows.field.ruleLeft')} onChange={(v) => set({ ...row, left: v })} />
          <div className="fl-rule__line">
            <Select
              size="sm"
              className="fl-rule__op"
              value={row.op}
              // An operator Dürbün does not know (a hand-edited or AI-made file) is shown as it is, not as the first option.
              options={ops.some((o) => o.value === row.op) ? ops : [{ value: row.op, label: t('flows.field.unknownOp', { op: String(row.op) }) }, ...ops]}
              aria-label={t('flows.field.ruleOp')}
              aria-invalid={!ops.some((o) => o.value === row.op) || undefined}
              onChange={(e) => {
                const op = e.target.value as FlowConditionOp;
                // A comparison needs a value to compare with: an empty one is shown (and checked) rather than missing.
                set(UNARY_OPS.has(op) ? { ...row, op } : { ...row, op, right: row.right ?? '' });
              }}
            />
            {UNARY_OPS.has(row.op) ? null : (
              <TemplateInput className="fl-rule__right" value={row.right ?? ''} placeholder={row.op === 'in' ? t('flows.field.ruleIn') : t('flows.field.ruleRight')} aria-label={t('flows.field.ruleRight')} onChange={(v) => set({ ...row, right: v })} />
            )}
          </div>
          {withMessage ? (
            <input className="fl-input" value={row.message ?? ''} placeholder={t('flows.field.checkMessage')} aria-label={t('flows.field.checkMessage')} onChange={(e) => set({ ...row, message: e.target.value || undefined })} />
          ) : null}
        </div>
      )}
    />
  );
}

interface ExtractRow {
  name: string;
  from: 'body' | 'header' | 'status' | 'bodyText';
  path?: string;
  regex?: string;
}

export function ExtractsEditor({ value, onChange, label }: { value: unknown; onChange(rows: ExtractRow[]): void; label: string }) {
  const t = useT();
  const rows = (Array.isArray(value) ? value : []) as ExtractRow[];
  const from = (['body', 'header', 'status', 'bodyText'] as const).map((f) => ({ value: f, label: t(`flows.field.extractFrom.${f}`) }));
  return (
    <RowList
      label={label}
      rows={rows}
      onChange={onChange}
      empty={t('flows.field.noExtracts')}
      addLabel={t('flows.field.addExtract')}
      make={() => ({ name: '', from: 'body' as const, path: '' })}
      render={(row, set) => (
        <div className="fl-extract">
          <div className="fl-extract__line">
            <input className="fl-input mono" value={row.name} placeholder={t('flows.field.varName')} aria-label={t('flows.field.varName')} spellCheck={false} onChange={(e) => set({ ...row, name: e.target.value })} />
            <Select size="sm" value={row.from} options={from} aria-label={t('flows.field.extractFromLabel')} onChange={(e) => set({ ...row, from: e.target.value as ExtractRow['from'] })} />
          </div>
          {row.from === 'body' || row.from === 'header' ? (
            <input
              className="fl-input mono"
              value={row.path ?? ''}
              placeholder={row.from === 'header' ? 'x-request-id' : 'data.items[0].id'}
              aria-label={row.from === 'header' ? t('flows.field.headerName') : t('flows.field.jsonPath')}
              spellCheck={false}
              onChange={(e) => set({ ...row, path: e.target.value })}
            />
          ) : null}
          <input className="fl-input mono" value={row.regex ?? ''} placeholder={t('flows.field.regexOptional')} aria-label={t('flows.field.regexOptional')} spellCheck={false} onChange={(e) => set({ ...row, regex: e.target.value || undefined })} />
        </div>
      )}
    />
  );
}

export function AssignmentsEditor({ value, onChange, label }: { value: unknown; onChange(rows: { name: string; value: string }[]): void; label: string }) {
  const t = useT();
  const rows = (Array.isArray(value) ? value : []) as { name: string; value: string }[];
  return (
    <RowList
      label={label}
      rows={rows}
      onChange={onChange}
      empty={t('flows.field.noVars')}
      addLabel={t('flows.field.addVar')}
      make={() => ({ name: '', value: '' })}
      render={(row, set) => (
        <div className="fl-kv">
          <input className="fl-input mono" value={row.name} placeholder={t('flows.field.varName')} aria-label={t('flows.field.varName')} spellCheck={false} onChange={(e) => set({ ...row, name: e.target.value })} />
          <TemplateInput value={String(row.value ?? '')} placeholder={t('flows.field.value')} aria-label={t('flows.field.value')} onChange={(v) => set({ ...row, value: v })} />
        </div>
      )}
    />
  );
}

/** Inputs of a sub-flow: one row per declared input, plus any extra keys already set. */
export function MappingEditor({
  value,
  onChange,
  inputs,
  label,
}: {
  value: unknown;
  onChange(v: Record<string, string>): void;
  inputs: { name: string; description?: string; required?: boolean; default?: unknown }[] | null;
  label: string;
}) {
  const t = useT();
  const map = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const names = [...(inputs ?? []).map((i) => i.name), ...Object.keys(map).filter((k) => !(inputs ?? []).some((i) => i.name === k))];
  const set = (name: string, v: string) => {
    const next: Record<string, string> = {};
    for (const [k, x] of Object.entries(map)) next[k] = typeof x === 'string' ? x : JSON.stringify(x);
    if (v === '') delete next[name];
    else next[name] = v;
    onChange(next);
  };
  if (inputs !== null && names.length === 0) return <div className="fl-rows__empty">{t('flows.field.noSubInputs')}</div>;
  return (
    <div className="fl-mapping" role="group" aria-label={label}>
      {names.map((name) => {
        const def = inputs?.find((i) => i.name === name);
        const v = map[name];
        return (
          <div key={name} className="fl-mapping__row">
            <span className="fl-mapping__name mono" title={def?.description}>
              {name}
              {def?.required ? <span className="fl-field__req">*</span> : null}
              {!def && inputs ? <span className="fl-mapping__unknown">{t('flows.field.unknownInput')}</span> : null}
            </span>
            <TemplateInput
              value={typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)}
              placeholder={def?.default !== undefined ? t('flows.field.defaultIs', { value: String(def.default) }) : def?.description ?? ''}
              aria-label={name}
              onChange={(x) => set(name, x)}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ───────────── durations ───────────── */

/**
 * A duration typed in seconds (or minutes) and stored in milliseconds. Valid values are kept as they are typed;
 * a half-typed one (empty, "0" on the way to "0,5", below the minimum) never clears the stored value: it is checked
 * when the field is left and shown as an error there. Leaving it empty clears it.
 */
export function DurationField({
  label,
  hint,
  valueMs,
  onChange,
  unit = 's',
  minMs = 0,
  maxMs,
  placeholderMs,
  name,
}: {
  label: ReactNode;
  hint?: ReactNode;
  valueMs: number | undefined;
  onChange(ms: number | undefined): void;
  unit?: 's' | 'min';
  minMs?: number;
  maxMs?: number;
  placeholderMs?: number;
  name?: string;
}) {
  const t = useT();
  const lang = useLanguage();
  const id = useId();
  const factor = unit === 'min' ? 60_000 : 1000;
  const fmt = (ms: number) => new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 3, useGrouping: false }).format(ms / factor);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parse = (text: string): { ms?: number; error?: string } => {
    const s = text.trim().replace(',', '.');
    if (s === '') return {};
    if (!/^\d+(\.\d+)?$/.test(s)) return { error: t('flows.field.numberInvalid') };
    const ms = Math.round(Number(s) * factor);
    if (ms < minMs) return { error: t('flows.field.numberMin', { value: formatSpan(minMs, lang) }) };
    if (maxMs !== undefined && ms > maxMs) return { error: t('flows.field.numberMax', { value: formatSpan(maxMs, lang) }) };
    return { ms };
  };
  const commit = () => {
    if (draft === null) return;
    const r = parse(draft);
    if (r.error) {
      setError(r.error);
      return;
    }
    setError(null);
    setDraft(null);
    if (r.ms !== valueMs) onChange(r.ms);
  };
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} error={error ?? undefined} name={name}>
      <input
        id={id}
        className={clsx('fl-input', error && 'is-invalid')}
        inputMode="decimal"
        autoComplete="off"
        value={draft ?? (valueMs === undefined ? '' : fmt(valueMs))}
        placeholder={placeholderMs !== undefined ? fmt(placeholderMs) : undefined}
        aria-invalid={!!error || undefined}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          setError(null);
          const r = parse(text);
          if (r.ms !== undefined && !r.error && r.ms !== valueMs) onChange(r.ms);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && (draft !== null || error)) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
            setError(null);
          }
        }}
      />
    </FieldRow>
  );
}

/** JSON (or text) body: the text is kept as typed; valid JSON is stored parsed. */
export function JsonEditor({ value, onChange, textMode, label, placeholder }: { value: unknown; onChange(v: unknown): void; textMode?: boolean; label: string; placeholder?: string }) {
  const t = useT();
  const shown = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
  const [text, setText] = useState(shown);
  const last = useRef(shown);
  useEffect(() => {
    // An outside change (undo, another field) replaces the text; our own echo does not.
    if (shown !== last.current) {
      setText(shown);
      last.current = shown;
    }
  }, [shown]);
  let invalid = false;
  if (!textMode && text.trim()) {
    try {
      JSON.parse(text);
    } catch {
      invalid = true;
    }
  }
  return (
    <div className="fl-json">
      <TemplateInput
        multiline
        rows={6}
        value={text}
        aria-label={label}
        placeholder={placeholder}
        onChange={(v) => {
          setText(v);
          let next: unknown = v;
          if (!textMode && v.trim()) {
            try {
              next = JSON.parse(v);
            } catch {
              next = v;
            }
          }
          if (!v.trim()) next = textMode ? '' : undefined;
          last.current = typeof next === 'string' ? next : next === undefined ? '' : JSON.stringify(next, null, 2);
          onChange(next);
        }}
      />
      {invalid ? <div className="fl-field-warn">{t('flows.field.jsonInvalid')}</div> : null}
    </div>
  );
}
