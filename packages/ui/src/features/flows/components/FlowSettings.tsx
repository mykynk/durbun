import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Plus, X, Zap } from 'lucide-react';
import { FLOW_ID_RE, type FlowDoc, type FlowIssue, type FlowOutputDef, type FlowSummary, type FlowVariableDef } from '@durbun/protocol';
import { Button, Callout, Checkbox, IconButton, Select, Toggle, formatDateTime } from '../../../components';
import { useHub } from '../../../data';
import { useT } from '../../../i18n';
import { addNode } from '../model/graph';
import { DurationField, FieldRow, TemplateInput, useRowKeys } from './fields';
import { IssueList } from './NodeInspector';

export interface FlowSettingsProps {
  flow: FlowDoc;
  issues: FlowIssue[];
  flows: FlowSummary[];
  apply(edit: (f: FlowDoc) => FlowDoc, opts?: { coalesce?: string }): void;
  onSelectNode(id: string, path?: string): void;
}

/** The flow itself (shown when no step is selected): name, inputs, outputs, target, run settings, automation. */
export function FlowSettings({ flow, issues, flows, apply, onSelectNode }: FlowSettingsProps) {
  const t = useT();
  const nameId = useId();
  const descId = useId();
  const tagsId = useId();
  const set = (patch: Partial<FlowDoc>, key: string) =>
    apply(
      (f) => {
        const next = { ...f, ...patch } as FlowDoc;
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
        return next;
      },
      { coalesce: `flow.${key}` },
    );
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  return (
    <div className="fl-insp fl-settings">
      <div className="fl-settings__head">
        <h2>{t('flows.settings.title')}</h2>
        <p className="fl-insp__hint">{t('flows.settings.hint')}</p>
      </div>
      {errors.length || warnings.length ? (
        <Section title={t('flows.settings.issues', { count: errors.length + warnings.length })}>
          <IssueList issues={[...errors, ...warnings]} nodes={flow.nodes} onSelectNode={onSelectNode} />
        </Section>
      ) : null}
      <Section title={t('flows.settings.general')}>
        <FieldRow label={t('flows.settings.name')} htmlFor={nameId} required>
          <input id={nameId} className="fl-input" value={flow.name} onChange={(e) => set({ name: e.target.value }, 'name')} />
        </FieldRow>
        <FieldRow label={t('flows.settings.description')} htmlFor={descId} hint={t('flows.settings.descriptionHint')}>
          <textarea id={descId} className="fl-input" rows={3} value={flow.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined }, 'description')} />
        </FieldRow>
        <FieldRow label={t('flows.settings.tags')} htmlFor={tagsId} hint={t('flows.settings.tagsHint')}>
          <TagsInput id={tagsId} tags={flow.tags ?? []} onChange={(tags) => set({ tags: tags.length ? tags : undefined }, 'tags')} />
        </FieldRow>
        <IdRow flow={flow} flows={flows} apply={apply} />
      </Section>

      <Section title={t('flows.settings.target')}>
        <TargetFields flow={flow} set={set} />
      </Section>

      <Section title={t('flows.settings.inputs')} hint={t('flows.settings.inputsHint')}>
        <InputsEditor inputs={flow.inputs ?? []} onChange={(inputs) => set({ inputs: inputs.length ? inputs : undefined }, 'inputs')} />
      </Section>

      <Section title={t('flows.settings.outputs')} hint={t('flows.settings.outputsHint')}>
        <OutputsEditor outputs={flow.outputs ?? []} onChange={(outputs) => set({ outputs: outputs.length ? outputs : undefined }, 'outputs')} />
      </Section>

      <Section title={t('flows.settings.run')}>
        <RunSettings flow={flow} set={set} />
      </Section>

      <Section title={t('flows.settings.automation')}>
        <Automation flow={flow} set={set} apply={apply} onSelectNode={onSelectNode} />
      </Section>

      {flow.createdAt || flow.updatedAt ? (
        <p className="fl-settings__meta">
          {flow.createdAt ? t('flows.settings.created', { at: formatDateTime(flow.createdAt) }) : null}
          {flow.updatedAt ? ` · ${t('flows.settings.updated', { at: formatDateTime(flow.updatedAt) })}` : null}
        </p>
      ) : null}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="fl-insp__section">
      <div className="fl-insp__section-head">
        <h3>{title}</h3>
      </div>
      {hint ? <p className="fl-insp__hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function TagsInput({ id, tags, onChange }: { id: string; tags: string[]; onChange(tags: string[]): void }) {
  const [text, setText] = useState(tags.join(', '));
  useEffect(() => setText((cur) => (splitTags(cur).join(',') === tags.join(',') ? cur : tags.join(', '))), [tags]);
  return (
    <input
      id={id}
      className="fl-input"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitTags(e.target.value));
      }}
    />
  );
}

function splitTags(s: string): string[] {
  return [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 20);
}

function IdRow({ flow, flows, apply }: { flow: FlowDoc; flows: FlowSummary[]; apply: FlowSettingsProps['apply'] }) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(flow.id);
  useEffect(() => setDraft(flow.id), [flow.id]);
  const v = draft.trim();
  const problem = v === flow.id ? null : !FLOW_ID_RE.test(v) ? 'invalid' : flows.some((f) => f.id === v) ? 'taken' : null;
  const commit = () => {
    if (!v || v === flow.id || problem) {
      if (!v) setDraft(flow.id);
      return;
    }
    apply((f) => ({ ...f, id: v }));
  };
  return (
    <FieldRow label={t('flows.settings.id')} htmlFor={id} hint={t('flows.settings.idHint')} error={problem ? t(`flows.settings.idProblem.${problem}`) : undefined}>
      <input
        id={id}
        className={clsx('fl-input mono', problem && 'is-invalid')}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value.toLowerCase())}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(flow.id);
        }}
      />
    </FieldRow>
  );
}

function TargetFields({ flow, set }: { flow: FlowDoc; set(patch: Partial<FlowDoc>, key: string): void }) {
  const t = useT();
  const platformId = useId();
  const appId = useId();
  const listId = useId();
  const apps = useHub((s) => s.apps);
  const deviceApps = useHub((s) => s.deviceApps);
  const known = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of Object.values(apps)) m.set(a.app.id, a.app.name);
    for (const d of Object.values(deviceApps)) if (!m.has(d.id)) m.set(d.id, d.name ?? d.id);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [apps, deviceApps]);
  const target = flow.target ?? {};
  const update = (patch: Partial<NonNullable<FlowDoc['target']>>) => {
    const next = { ...target, ...patch };
    if (!next.appId) delete next.appId;
    if (!next.platform || next.platform === 'any') delete next.platform;
    set({ target: Object.keys(next).length ? next : undefined }, 'target');
  };
  return (
    <>
      <FieldRow label={t('flows.settings.appId')} htmlFor={appId} hint={t('flows.settings.appIdHint')}>
        <input id={appId} className="fl-input mono" list={listId} value={target.appId ?? ''} placeholder="com.example.app" spellCheck={false} onChange={(e) => update({ appId: e.target.value.trim() || undefined })} />
        <datalist id={listId}>
          {known.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </datalist>
      </FieldRow>
      <FieldRow label={t('flows.settings.platform')} htmlFor={platformId}>
        <Select
          id={platformId}
          size="sm"
          value={target.platform ?? 'any'}
          options={[
            { value: 'any', label: t('flows.settings.platformAny') },
            { value: 'android', label: 'Android' },
            { value: 'ios', label: 'iOS' },
          ]}
          onChange={(e) => update({ platform: e.target.value as 'any' | 'android' | 'ios' })}
        />
      </FieldRow>
    </>
  );
}

function InputsEditor({ inputs, onChange }: { inputs: FlowVariableDef[]; onChange(v: FlowVariableDef[]): void }) {
  const t = useT();
  const { keys, removed } = useRowKeys(inputs.length);
  const setRow = (i: number, patch: Partial<FlowVariableDef>) => onChange(inputs.map((x, j) => (j === i ? clean({ ...x, ...patch }) : x)));
  return (
    <div className="fl-defs">
      {inputs.length === 0 ? <div className="fl-rows__empty">{t('flows.settings.noInputs')}</div> : null}
      {inputs.map((d, i) => (
        <div key={keys[i]} className="fl-defs__row">
          <div className="fl-defs__line">
            <input className="fl-input mono" value={d.name} placeholder={t('flows.field.name')} aria-label={t('flows.field.name')} spellCheck={false} onChange={(e) => setRow(i, { name: e.target.value })} />
            <input
              className="fl-input"
              type={d.secret ? 'password' : 'text'}
              value={d.default === undefined ? '' : String(d.default)}
              placeholder={t('flows.settings.default')}
              aria-label={t('flows.settings.default')}
              onChange={(e) => setRow(i, { default: e.target.value === '' ? undefined : e.target.value })}
            />
            <IconButton
              icon={X}
              size="xs"
              label={t('flows.field.removeRow')}
              onClick={() => {
                removed(i);
                onChange(inputs.filter((_, j) => j !== i));
              }}
            />
          </div>
          <input className="fl-input" value={d.description ?? ''} placeholder={t('flows.settings.inputDescription')} aria-label={t('flows.settings.inputDescription')} onChange={(e) => setRow(i, { description: e.target.value || undefined })} />
          <div className="fl-defs__flags">
            <Checkbox checked={!!d.required} onChange={(v) => setRow(i, { required: v || undefined })} label={t('flows.settings.required')} />
            <Checkbox checked={!!d.secret} onChange={(v) => setRow(i, { secret: v || undefined })} label={t('flows.settings.secret')} />
            <code className="fl-defs__ref">{`{{input.${d.name || '…'}}}`}</code>
          </div>
          {d.secret ? <p className="fl-field__hint">{t('flows.settings.secretDefaultHint')}</p> : null}
        </div>
      ))}
      <button type="button" className="fl-rows__add" onClick={() => onChange([...inputs, { name: `input${inputs.length + 1}` }])}>
        <Plus size={12} aria-hidden />
        {t('flows.settings.addInput')}
      </button>
    </div>
  );
}

function clean<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out as T;
}

function OutputsEditor({ outputs, onChange }: { outputs: FlowOutputDef[]; onChange(v: FlowOutputDef[]): void }) {
  const t = useT();
  const { keys, removed } = useRowKeys(outputs.length);
  const setRow = (i: number, patch: Partial<FlowOutputDef>) => onChange(outputs.map((x, j) => (j === i ? clean({ ...x, ...patch }) : x)));
  return (
    <div className="fl-defs">
      {outputs.length === 0 ? <div className="fl-rows__empty">{t('flows.settings.noOutputs')}</div> : null}
      {outputs.map((d, i) => (
        <div key={keys[i]} className="fl-defs__row">
          <div className="fl-defs__line">
            <input className="fl-input mono" value={d.name} placeholder={t('flows.field.name')} aria-label={t('flows.field.name')} spellCheck={false} onChange={(e) => setRow(i, { name: e.target.value })} />
            <IconButton
              icon={X}
              size="xs"
              label={t('flows.field.removeRow')}
              onClick={() => {
                removed(i);
                onChange(outputs.filter((_, j) => j !== i));
              }}
            />
          </div>
          <TemplateInput value={d.value} placeholder="{{login.body.token}}" aria-label={t('flows.settings.outputValue')} onChange={(v) => setRow(i, { value: v })} />
          <input className="fl-input" value={d.description ?? ''} placeholder={t('flows.settings.outputDescription')} aria-label={t('flows.settings.outputDescription')} onChange={(e) => setRow(i, { description: e.target.value || undefined })} />
        </div>
      ))}
      <button type="button" className="fl-rows__add" onClick={() => onChange([...outputs, { name: `output${outputs.length + 1}`, value: '' }])}>
        <Plus size={12} aria-hidden />
        {t('flows.settings.addOutput')}
      </button>
    </div>
  );
}

function RunSettings({ flow, set }: { flow: FlowDoc; set(patch: Partial<FlowDoc>, key: string): void }) {
  const t = useT();
  const unsupportedId = useId();
  const s = flow.settings ?? {};
  const update = (patch: Partial<NonNullable<FlowDoc['settings']>>) => {
    const next = clean({ ...s, ...patch });
    set({ settings: Object.keys(next).length ? next : undefined }, 'settings');
  };
  return (
    <>
      <FieldRow label={t('flows.settings.onUnsupported')} htmlFor={unsupportedId} hint={t('flows.settings.onUnsupportedHint')}>
        <Select
          id={unsupportedId}
          size="sm"
          value={s.onUnsupported ?? 'skip'}
          options={[
            { value: 'skip', label: t('flows.settings.unsupportedSkip') },
            { value: 'fail', label: t('flows.settings.unsupportedFail') },
          ]}
          onChange={(e) => update({ onUnsupported: e.target.value === 'fail' ? 'fail' : undefined })}
        />
      </FieldRow>
      <DurationField
        label={t('flows.settings.timeout')}
        hint={t('flows.settings.timeoutHint')}
        unit="min"
        valueMs={s.timeoutMs}
        placeholderMs={30 * 60_000}
        minMs={60_000}
        maxMs={240 * 60_000}
        onChange={(timeoutMs) => update({ timeoutMs })}
      />
      <div className="fl-field fl-field--toggle">
        <Toggle checked={s.recordRequests !== false} onChange={(v) => update({ recordRequests: v ? undefined : false })} label={t('flows.settings.recordRequests')} description={t('flows.settings.recordRequestsHint')} size="sm" />
      </div>
    </>
  );
}

function Automation({ flow, set, apply, onSelectNode }: { flow: FlowDoc; set(patch: Partial<FlowDoc>, key: string): void; apply: FlowSettingsProps['apply']; onSelectNode(id: string): void }) {
  const t = useT();
  const a = flow.automation ?? { enabled: false };
  const events = flow.nodes.filter((n) => n.type === 'trigger.event');
  const update = (patch: Partial<NonNullable<FlowDoc['automation']>>) => {
    const next = clean({ ...a, ...patch });
    set({ automation: next.enabled || next.throttleMs ? next : undefined }, 'automation');
  };
  return (
    <>
      <p className="fl-insp__hint">{t('flows.settings.automationHint')}</p>
      <div className="fl-field fl-field--toggle">
        <Toggle checked={a.enabled} onChange={(v) => update({ enabled: v })} label={t('flows.settings.automationOn')} size="sm" disabled={events.length === 0 && !a.enabled} />
      </div>
      {events.length === 0 ? (
        <Callout tone="info" compact>
          {t('flows.settings.noEventTrigger')}
          <Button
            size="sm"
            variant="ghost"
            icon={Zap}
            onClick={() => {
              let id = '';
              apply((f) => {
                const xs = f.nodes.map((n) => n.position?.x ?? 0);
                const r = addNode(f, 'trigger.event', { at: { x: xs.length ? Math.min(...xs) : 0, y: Math.max(0, ...f.nodes.map((n) => n.position?.y ?? 0)) + 120 } });
                id = r.id;
                return r.flow;
              });
              requestAnimationFrame(() => id && onSelectNode(id));
            }}
          >
            {t('flows.settings.addEventTrigger')}
          </Button>
        </Callout>
      ) : null}
      <DurationField
        label={t('flows.settings.throttle')}
        hint={t('flows.settings.throttleHint')}
        valueMs={a.throttleMs}
        placeholderMs={30_000}
        maxMs={86_400_000}
        onChange={(throttleMs) => update({ throttleMs })}
      />
    </>
  );
}
