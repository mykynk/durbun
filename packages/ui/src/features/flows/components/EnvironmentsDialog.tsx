import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { ClipboardPaste, CopyPlus, Eye, EyeOff, Globe, Lock, Plus, Trash, X } from 'lucide-react';
import { VAR_NAME_RE, type FlowEnvironment, type FlowEnvironments } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, IconButton, Tooltip, confirm, toast, useShortcut } from '../../../components';
import { useT } from '../../../i18n';
import { flowErrorText } from '../model/errors';
import { emptyEnvironments, newEnvId, parseEnvText, saveEnvironments, useEnvironments } from '../model/envStore';

export interface EnvironmentsDialogProps {
  open: boolean;
  onClose(): void;
  /** Keys the open flow reads ({{env.x}}), to point out missing ones. */
  usedKeys?: readonly string[];
}

/** "Ortamlar": named sets of variables (test, staging…) flows read as {{env.<key>}}. */
export function EnvironmentsDialog({ open, onClose, usedKeys = [] }: EnvironmentsDialogProps) {
  const t = useT();
  const server = useEnvironments();
  const [draft, setDraft] = useState<FlowEnvironments | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<ReadonlySet<string>>(new Set());
  const [pasting, setPasting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const base = server ? structuredClone(server) : emptyEnvironments();
    setDraft(base);
    setCurrent(base.activeId ?? base.environments[0]?.id ?? null);
    setReveal(new Set());
    setPasting(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!server]);

  const env = draft?.environments.find((e) => e.id === current);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(server ?? emptyEnvironments());
  const keyProblems = useMemo(() => {
    const out = new Map<string, string>();
    for (const e of draft?.environments ?? []) {
      const seen = new Set<string>();
      e.vars.forEach((v, i) => {
        const k = `${e.id}:${i}`;
        if (!v.key.trim()) out.set(k, t('flows.env.keyEmpty'));
        else if (!VAR_NAME_RE.test(v.key.trim())) out.set(k, t('flows.env.keyInvalid'));
        else if (seen.has(v.key.trim())) out.set(k, t('flows.env.keyDuplicate'));
        seen.add(v.key.trim());
      });
    }
    return out;
  }, [draft, t]);

  const updateEnv = (id: string, fn: (e: FlowEnvironment) => FlowEnvironment) => setDraft((d) => (d ? { ...d, environments: d.environments.map((e) => (e.id === id ? fn(e) : e)) } : d));

  const addEnv = (copyOf?: FlowEnvironment) => {
    if (!draft) return;
    const name = copyOf ? t('flows.env.copyName', { name: copyOf.name }) : t('flows.env.newName', { n: draft.environments.length + 1 });
    const id = newEnvId(draft, name);
    const env: FlowEnvironment = { id, name, vars: copyOf ? copyOf.vars.map((v) => ({ ...v })) : [{ key: 'baseUrl', value: '' }] };
    setDraft({ ...draft, environments: [...draft.environments, env], activeId: draft.activeId ?? id });
    setCurrent(id);
  };

  const removeEnv = async (e: FlowEnvironment) => {
    if (!draft) return;
    const ok = await confirm({ title: t('flows.env.deleteTitle'), message: t('flows.env.deleteMessage', { name: e.name }), confirmLabel: t('flows.env.delete'), danger: true });
    if (!ok) return;
    const rest = draft.environments.filter((x) => x.id !== e.id);
    setDraft({ ...draft, environments: rest, activeId: draft.activeId === e.id ? rest[0]?.id : draft.activeId });
    setCurrent(rest[0]?.id ?? null);
  };

  const save = async () => {
    if (!draft || keyProblems.size) return;
    setSaving(true);
    try {
      const clean: FlowEnvironments = { ...draft, environments: draft.environments.map((e) => ({ ...e, vars: e.vars.map((v) => ({ ...v, key: v.key.trim() })) })) };
      await saveEnvironments(clean);
      toast.success(t('flows.env.saved'));
      onClose();
    } catch (err) {
      toast.error(t('flows.env.saveFailed'), { description: flowErrorText(err) });
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirm({ title: t('flows.env.discardTitle'), message: t('flows.env.discardMessage'), confirmLabel: t('flows.env.discard'), danger: true }))) return;
    onClose();
  };

  useShortcut('Mod+S', () => void save(), { enabled: open && dirty && !saving, allowInModal: true, allowInInputs: true });

  const listRef = useRef<HTMLDivElement>(null);
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = draft?.environments ?? [];
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !list.length) return;
    e.preventDefault();
    const i = Math.max(0, list.findIndex((x) => x.id === current));
    const next = list[e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]!;
    setCurrent(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-env-id="${CSS.escape(next.id)}"]`)?.focus());
  };

  const missing = env ? usedKeys.filter((k) => !env.vars.some((v) => v.key.trim() === k)) : [];

  return (
    <Dialog
      open={open}
      onClose={() => void close()}
      title={t('flows.env.title')}
      description={t('flows.env.description', { example: '{{env.baseUrl}}' })}
      icon={Globe}
      size="xl"
      closeOnOverlay={false}
      bodyClassName="fl-env"
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" onClick={() => void close()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={!dirty || keyProblems.size > 0} onClick={() => void save()} kbd="Mod+S">
            {t('flows.env.save')}
          </Button>
        </>
      }
    >
      {!draft ? null : (
        <div className="fl-env__layout">
          <div className="fl-env__list">
            {/* One tab stop; the arrows move between environments. */}
            <div className="fl-env__options" role="listbox" aria-label={t('flows.env.list')} ref={listRef} onKeyDown={onListKey}>
              {draft.environments.map((e) => (
                <div
                  key={e.id}
                  role="option"
                  aria-selected={e.id === current}
                  tabIndex={e.id === (current ?? draft.environments[0]?.id) ? 0 : -1}
                  data-env-id={e.id}
                  className={clsx('fl-env__item', e.id === current && 'is-selected')}
                  onClick={() => setCurrent(e.id)}
                >
                  <span className="fl-env__name">{e.name}</span>
                  {draft.activeId === e.id ? <span className="fl-chip is-passed">{t('flows.env.active')}</span> : null}
                  <span className="fl-env__count tnum">{e.vars.length}</span>
                </div>
              ))}
            </div>
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => addEnv()}>
              {t('flows.env.add')}
            </Button>
          </div>
          <div className="fl-env__body">
            {!env ? (
              <div className="fl-env__empty">
                <p>{t('flows.env.empty')}</p>
                <Button variant="primary" icon={Plus} onClick={() => addEnv()}>
                  {t('flows.env.add')}
                </Button>
              </div>
            ) : (
              <>
                <div className="fl-env__top">
                  <input className="fl-input fl-env__title" value={env.name} aria-label={t('flows.env.name')} onChange={(e) => updateEnv(env.id, (x) => ({ ...x, name: e.target.value }))} />
                  <Button size="sm" variant={draft.activeId === env.id ? 'subtle' : 'secondary'} disabled={draft.activeId === env.id} onClick={() => setDraft({ ...draft, activeId: env.id })}>
                    {draft.activeId === env.id ? t('flows.env.isActive') : t('flows.env.makeActive')}
                  </Button>
                  <IconButton icon={CopyPlus} label={t('flows.env.duplicate')} onClick={() => addEnv(env)} />
                  <IconButton icon={Trash} tone="danger" label={t('flows.env.delete')} onClick={() => void removeEnv(env)} />
                </div>
                {missing.length ? (
                  <Callout tone="warn" compact>
                    {t('flows.env.missing', { keys: missing.join(', ') })}
                    <Button size="sm" variant="ghost" onClick={() => updateEnv(env.id, (x) => ({ ...x, vars: [...x.vars, ...missing.map((key) => ({ key, value: '' }))] }))}>
                      {t('flows.env.addMissing')}
                    </Button>
                  </Callout>
                ) : null}
                <div className="fl-env__table" role="table" aria-label={t('flows.env.vars')}>
                  <div className="fl-env__row fl-env__row--head" role="row">
                    <span role="columnheader">{t('flows.env.key')}</span>
                    <span role="columnheader">{t('flows.env.value')}</span>
                    <span role="columnheader">{t('flows.env.secret')}</span>
                    <span />
                  </div>
                  {env.vars.map((v, i) => {
                    const k = `${env.id}:${i}`;
                    const problem = keyProblems.get(k);
                    const shown = !v.secret || reveal.has(k);
                    return (
                      <div key={i} className="fl-env__row" role="row">
                        <span role="cell">
                          <input
                            className={clsx('fl-input mono', problem && 'is-invalid')}
                            value={v.key}
                            aria-label={t('flows.env.key')}
                            aria-invalid={!!problem}
                            title={problem}
                            spellCheck={false}
                            onChange={(e) => updateEnv(env.id, (x) => ({ ...x, vars: x.vars.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)) }))}
                          />
                          {problem ? <span className="fl-field-error">{problem}</span> : null}
                        </span>
                        <span role="cell" className="fl-env__value">
                          <input
                            className="fl-input mono"
                            type={shown ? 'text' : 'password'}
                            value={v.value}
                            aria-label={t('flows.env.value')}
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(e) => updateEnv(env.id, (x) => ({ ...x, vars: x.vars.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) }))}
                          />
                          {v.secret ? (
                            <IconButton
                              icon={shown ? EyeOff : Eye}
                              size="xs"
                              label={shown ? t('flows.env.hide') : t('flows.env.show')}
                              onClick={() =>
                                setReveal((r) => {
                                  const n = new Set(r);
                                  if (n.has(k)) n.delete(k);
                                  else n.add(k);
                                  return n;
                                })
                              }
                            />
                          ) : null}
                        </span>
                        <span role="cell">
                          <Checkbox checked={!!v.secret} onChange={(c) => updateEnv(env.id, (x) => ({ ...x, vars: x.vars.map((y, j) => (j === i ? { ...y, secret: c || undefined } : y)) }))} label={<Lock size={12} aria-label={t('flows.env.secret')} />} />
                        </span>
                        <span role="cell">
                          <IconButton icon={X} size="xs" label={t('flows.field.removeRow')} onClick={() => updateEnv(env.id, (x) => ({ ...x, vars: x.vars.filter((_, j) => j !== i) }))} />
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="fl-env__actions">
                  <Button size="sm" variant="ghost" icon={Plus} onClick={() => updateEnv(env.id, (x) => ({ ...x, vars: [...x.vars, { key: '', value: '' }] }))}>
                    {t('flows.env.addVar')}
                  </Button>
                  <Tooltip content={t('flows.env.pasteHint')}>
                    <Button size="sm" variant="ghost" icon={ClipboardPaste} onClick={() => setPasting(pasting === null ? '' : null)}>
                      {t('flows.env.paste')}
                    </Button>
                  </Tooltip>
                </div>
                {pasting !== null ? (
                  <div className="fl-env__paste">
                    <textarea className="fl-input mono" rows={5} value={pasting} placeholder={'BASE_URL=https://test.api.example.com\nAPI_KEY=…'} aria-label={t('flows.env.paste')} onChange={(e) => setPasting(e.target.value)} />
                    <div className="fl-env__paste-actions">
                      <Button size="sm" variant="ghost" onClick={() => setPasting(null)}>
                        {t('common.cancel')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!parseEnvText(pasting).length}
                        onClick={() => {
                          const parsed = parseEnvText(pasting);
                          updateEnv(env.id, (x) => {
                            const vars = x.vars.slice();
                            for (const p of parsed) {
                              const at = vars.findIndex((v) => v.key === p.key);
                              const row = { key: p.key, value: p.value, ...(p.secret ? { secret: true } : {}) };
                              if (at >= 0) vars[at] = row;
                              else vars.push(row);
                            }
                            return { ...x, vars };
                          });
                          setPasting(null);
                          toast.success(t('flows.env.pasted', { count: parsed.length }));
                        }}
                      >
                        {t('flows.env.pasteApply', { count: parseEnvText(pasting).length })}
                      </Button>
                    </div>
                  </div>
                ) : null}
                <p className="fl-insp__hint">{t('flows.env.secretNote')}</p>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
