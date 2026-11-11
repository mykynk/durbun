import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Copy, CopyPlus, ExternalLink, EyeOff, Eye, Play, Trash, TriangleAlert } from 'lucide-react';
import {
  DEVICE_ACTION_SUPPORT,
  flowNodeSpec,
  type FlowDoc,
  type FlowIssue,
  type FlowNode,
  type FlowParamSpec,
  type FlowRunStep,
  type FlowSummary,
} from '@durbun/protocol';
import { Button, Callout, CopyButton, IconButton, JsonTree, Select, Toggle, Tooltip, copyText, toast, formatDuration } from '../../../components';
import { api, ui, useSlackStatus } from '../../../data';
import { tCode, useLanguage, useT } from '../../../i18n';
import { renameNode, renameProblem, updateNode } from '../model/graph';
import { nodeIcon } from '../model/icons';
import { statusKey, stepError, stepText } from '../model/run';
import { GROUP_COLOR, formatSpan, issueText, nodeDescription, nodeName, nodeTitle, optionLabel, outputText, paramHint, paramLabel, paramPlaceholder } from '../model/text';
import { AssignmentsEditor, DurationField, ExtractsEditor, FieldRow, JsonEditor, KeyValueEditor, MappingEditor, RulesEditor, TemplateInput } from './fields';
import { codeText } from './CodeText';
import { Evidence } from './Evidence';

export interface NodeInspectorProps {
  flow: FlowDoc;
  node: FlowNode;
  issues: FlowIssue[];
  lastStep?: FlowRunStep;
  flows: FlowSummary[];
  apply(edit: (f: FlowDoc) => FlowDoc, opts?: { coalesce?: string }): void;
  onRenamed(from: string, to: string): void;
  onDelete(): void;
  onDuplicate(): void;
  onRunFromHere(): void;
  /** Why "run from here" is off: a run is going, or the step is a trigger. */
  runFromHereBlocked?: 'running' | 'trigger';
  onOpenFlow(id: string): void;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function visible(p: FlowParamSpec, node: FlowNode): boolean {
  if (!p.showIf) return true;
  const spec = flowNodeSpec(node.type);
  const dep = spec?.params.find((x) => x.name === p.showIf!.param);
  const v = node.params?.[p.showIf.param] ?? dep?.default;
  return p.showIf.values.includes(v);
}

export function NodeInspector(props: NodeInspectorProps) {
  const { flow, node, issues, lastStep, flows, apply, onRenamed, onDelete, onDuplicate, onRunFromHere, runFromHereBlocked, onOpenFlow } = props;
  const t = useT();
  const lang = useLanguage();
  const spec = flowNodeSpec(node.type);
  const Icon = nodeIcon(node.type);
  const [advanced, setAdvanced] = useState(false);
  const [showDesc, setShowDesc] = useState(false);

  const setParam = (name: string, value: unknown) =>
    apply(
      (f) =>
        updateNode(f, node.id, (n) => {
          const params = { ...(n.params ?? {}) };
          if (value === undefined) delete params[name];
          else params[name] = value;
          if (Object.keys(params).length > 0) return { ...n, params };
          const { params: _p, ...rest } = n;
          return rest;
        }),
      { coalesce: `${node.id}.param.${name}` },
    );
  const setNode = (patch: Partial<FlowNode>, key: string) =>
    apply(
      (f) =>
        updateNode(f, node.id, (n) => {
          const next = { ...n, ...patch } as FlowNode;
          for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '' || v === false) delete (next as unknown as Record<string, unknown>)[k];
          return next;
        }),
      { coalesce: `${node.id}.${key}` },
    );

  const paramIssues = (name: string) => issues.filter((i) => i.path?.includes(`.params.${name}`) || i.params?.param === name);
  const otherIssues = issues.filter((i) => !(spec?.params ?? []).some((p) => i.path?.includes(`.params.${p.name}`) || i.params?.param === p.name));

  const main = (spec?.params ?? []).filter((p) => !p.advanced && visible(p, node));
  const extra = (spec?.params ?? []).filter((p) => p.advanced && visible(p, node));
  const color = spec ? GROUP_COLOR[spec.group] : 'var(--text-subtle)';

  return (
    <div className="fl-insp" style={{ ['--node-color' as string]: color }}>
      <div className="fl-insp__head">
        <span className="fl-insp__icon" aria-hidden>
          <Icon size={16} />
        </span>
        <div className="fl-insp__titles">
          <input
            className="fl-insp__label"
            value={node.label ?? ''}
            placeholder={nodeTitle(node.type, lang)}
            aria-label={t('flows.inspector.stepName')}
            onChange={(e) => setNode({ label: e.target.value || undefined }, 'label')}
          />
          <button type="button" className="fl-insp__type" onClick={() => setShowDesc((s) => !s)} aria-expanded={showDesc}>
            {nodeTitle(node.type, lang)}
            {showDesc ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          </button>
        </div>
        <div className="fl-insp__actions">
          <Tooltip content={runFromHereBlocked === 'running' ? t('flows.inspector.runFromHereRunning') : runFromHereBlocked === 'trigger' ? t('flows.inspector.runFromHereTrigger') : t('flows.inspector.runFromHere')}>
            <span>
              <IconButton icon={Play} label={t('flows.inspector.runFromHere')} noTooltip disabled={!!runFromHereBlocked} onClick={onRunFromHere} />
            </span>
          </Tooltip>
          <IconButton icon={node.disabled ? Eye : EyeOff} label={node.disabled ? t('flows.inspector.enable') : t('flows.inspector.disable')} onClick={() => setNode({ disabled: !node.disabled }, 'disabled')} />
          <IconButton icon={CopyPlus} label={t('flows.inspector.duplicate')} shortcut="Mod+D" onClick={onDuplicate} />
          <IconButton icon={Trash} tone="danger" label={t('flows.inspector.delete')} shortcut="Backspace" onClick={onDelete} />
        </div>
      </div>
      {showDesc ? <p className="fl-insp__desc">{codeText(nodeDescription(node.type, lang))}</p> : null}
      {node.disabled ? (
        <Callout tone="warn" compact>
          {t('flows.inspector.disabledNote')}
        </Callout>
      ) : null}
      {!spec ? (
        <Callout tone="danger" compact>
          {t('flows.node.unknownType', { type: node.type })}
        </Callout>
      ) : null}

      <IdField flow={flow} node={node} apply={apply} onRenamed={onRenamed} />

      {main.length ? (
        <Section title={t('flows.inspector.params')}>
          {main.map((p) => (
            <ParamField key={p.name} node={node} p={p} set={setParam} issues={paramIssues(p.name)} flows={flows} selfId={flow.id} onOpenFlow={onOpenFlow} />
          ))}
        </Section>
      ) : null}

      {spec?.irreversible ? (
        <Callout tone="warn" compact icon={TriangleAlert}>
          {t('flows.inspector.irreversible')}
        </Callout>
      ) : null}
      <Needs node={node} />

      {otherIssues.length ? (
        <Section title={t('flows.inspector.issues')}>
          <IssueList issues={otherIssues} nodes={[node]} />
        </Section>
      ) : null}

      <Outputs flow={flow} node={node} flows={flows} />

      {lastStep ? <LastStep step={lastStep} /> : null}

      <button type="button" className="fl-insp__more" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
        {advanced ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {t('flows.inspector.more')}
      </button>
      {advanced ? (
        <div className="fl-insp__advanced">
          {extra.map((p) => (
            <ParamField key={p.name} node={node} p={p} set={setParam} issues={paramIssues(p.name)} flows={flows} selfId={flow.id} onOpenFlow={onOpenFlow} />
          ))}
          {spec?.acceptsInput !== false ? <NodeOptions node={node} setNode={setNode} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="fl-insp__section">
      <div className="fl-insp__section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/* ───────────── id ───────────── */

function IdField({ flow, node, apply, onRenamed }: { flow: FlowDoc; node: FlowNode; apply: NodeInspectorProps['apply']; onRenamed(from: string, to: string): void }) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(node.id);
  useEffect(() => setDraft(node.id), [node.id]);
  const problem = renameProblem(flow, node.id, draft.trim());
  const commit = () => {
    const to = draft.trim();
    if (!to || to === node.id) {
      setDraft(node.id);
      return;
    }
    if (problem) return;
    const from = node.id;
    apply((f) => renameNode(f, from, to));
    onRenamed(from, to);
  };
  return (
    <FieldRow
      name="id"
      label={t('flows.inspector.id')}
      htmlFor={id}
      error={problem ? t(`flows.inspector.idProblem.${problem}`) : undefined}
      hint={t('flows.inspector.idHint', { example: `{{${node.id}.…}}` })}
    >
      <input
        id={id}
        className={clsx('fl-input mono', problem && 'is-invalid')}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(node.id);
        }}
      />
    </FieldRow>
  );
}

/* ───────────── params ───────────── */

function ParamField({
  node,
  p,
  set,
  issues,
  flows,
  selfId,
  onOpenFlow,
}: {
  node: FlowNode;
  p: FlowParamSpec;
  set(name: string, v: unknown): void;
  issues: FlowIssue[];
  flows: FlowSummary[];
  selfId: string;
  onOpenFlow(id: string): void;
}) {
  const t = useT();
  const lang = useLanguage();
  const id = useId();
  const raw = node.params?.[p.name];
  const value = raw ?? p.default;
  const label = paramLabel(node.type, p.name, lang);
  const hint = codeText(paramHint(node.type, p.name, lang));
  const err = issues.find((i) => i.level === 'error');
  const warn = issues.find((i) => i.level === 'warning');
  const shown = err ?? warn;
  const issue = shown ? issueText(shown, [node], lang) : undefined;
  const placeholder = paramPlaceholder(node.type, p.name, lang) ?? (typeof p.example === 'string' ? p.example : undefined);

  let control: ReactNode;
  switch (p.kind) {
    case 'boolean':
      return (
        <div className="fl-field fl-field--toggle">
          <Toggle checked={value === true} onChange={(v) => set(p.name, v)} label={label} description={hint} size="sm" />
          {issue ? <div className="fl-field-error">{issue}</div> : null}
        </div>
      );
    case 'select': {
      const opts = (p.options ?? []).map((o) => ({ value: o.value, label: optionLabel(node.type, p.name, o.value, lang) }));
      const v = typeof value === 'string' ? value : String(value ?? '');
      if (v && !opts.some((o) => o.value === v)) opts.push({ value: v, label: v });
      control = <Select id={id} size="sm" value={v} options={opts} onChange={(e) => set(p.name, e.target.value)} />;
      break;
    }
    case 'number': {
      const text = value === undefined || value === null ? '' : String(value);
      control = (
        <TemplateInput
          id={id}
          value={text}
          placeholder={p.default !== undefined ? String(p.default) : undefined}
          invalid={!!err}
          onChange={(v) => {
            const s = v.trim();
            set(p.name, s === '' ? undefined : NUMERIC.test(s) ? Number(s) : v);
          }}
        />
      );
      break;
    }
    case 'longText':
      control = <TemplateInput id={id} multiline value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)} placeholder={placeholder} invalid={!!err} onChange={(v) => set(p.name, v)} />;
      break;
    case 'keyValue':
      control = <KeyValueEditor value={value} label={label} onChange={(rows) => set(p.name, rows)} />;
      break;
    case 'json': {
      const textMode = node.type === 'http.request' && node.params?.bodyType === 'text';
      control = <JsonEditor value={raw ?? (p.required ? p.default : undefined)} textMode={textMode} label={label} placeholder={p.example !== undefined ? JSON.stringify(p.example) : undefined} onChange={(v) => set(p.name, v)} />;
      break;
    }
    case 'conditions':
    case 'assertions':
      control = <RulesEditor value={value} label={label} withMessage={p.kind === 'assertions'} onChange={(rows) => set(p.name, rows)} />;
      break;
    case 'extracts':
      control = <ExtractsEditor value={value} label={label} onChange={(rows) => set(p.name, rows)} />;
      break;
    case 'assignments':
      control = <AssignmentsEditor value={value} label={label} onChange={(rows) => set(p.name, rows)} />;
      break;
    case 'flowRef': {
      const v = typeof value === 'string' ? value : '';
      const opts = [{ value: '', label: t('flows.field.pickFlow') }, ...flows.filter((f) => f.id !== selfId).map((f) => ({ value: f.id, label: f.name }))];
      if (v && !opts.some((o) => o.value === v)) opts.push({ value: v, label: t('flows.field.missingFlow', { id: v }) });
      control = (
        <div className="fl-flowref">
          <Select id={id} size="sm" value={v} options={opts} onChange={(e) => set(p.name, e.target.value || undefined)} />
          {v && flows.some((f) => f.id === v) ? <IconButton icon={ExternalLink} size="sm" label={t('flows.field.openFlow')} onClick={() => onOpenFlow(v)} /> : null}
        </div>
      );
      break;
    }
    case 'mapping':
      control = <SubflowMapping node={node} value={value} label={label} onChange={(m) => set(p.name, m)} />;
      break;
    default:
      control = <TemplateInput id={id} value={typeof value === 'string' ? value : value === undefined ? '' : String(value)} placeholder={placeholder} invalid={!!err} onChange={(v) => set(p.name, v)} />;
  }
  return (
    <FieldRow name={`params.${p.name}`} label={label} htmlFor={id} required={p.required} hint={hint} error={issue}>
      {control}
    </FieldRow>
  );
}

function SubflowMapping({ node, value, label, onChange }: { node: FlowNode; value: unknown; label: string; onChange(v: Record<string, string>): void }) {
  const flowId = typeof node.params?.flowId === 'string' ? node.params.flowId : '';
  const [inputs, setInputs] = useState<FlowDoc['inputs'] | null>(null);
  useEffect(() => {
    if (!flowId) {
      setInputs([]);
      return;
    }
    const ctrl = new AbortController();
    setInputs(null);
    api.getFlow(flowId, ctrl.signal).then(
      (r) => setInputs(r.flow.inputs ?? []),
      () => setInputs([]),
    );
    return () => ctrl.abort();
  }, [flowId]);
  return <MappingEditor value={value} inputs={inputs ?? null} label={label} onChange={onChange} />;
}

/* ───────────── node options ───────────── */

function NodeOptions({ node, setNode }: { node: FlowNode; setNode(patch: Partial<FlowNode>, key: string): void }) {
  const t = useT();
  const lang = useLanguage();
  const spec = flowNodeSpec(node.type);
  const retryId = useId();
  const noteId = useId();
  // A step with its own time limit (a request, a wait) shows that one only; the generic one stays reachable while
  // a flow file still sets it, so it can be cleared.
  const ownTimeout = !!spec?.params.some((p) => p.name === 'timeoutMs');
  const defaultTimeout = spec?.timeoutMs ?? 5 * 60_000;
  return (
    <div className="fl-insp__options">
      <div className="fl-field fl-field--toggle">
        <Toggle checked={!!node.continueOnError} onChange={(v) => setNode({ continueOnError: v || undefined }, 'continueOnError')} label={t('flows.inspector.continueOnError')} description={t('flows.inspector.continueOnErrorHint')} size="sm" />
      </div>
      <FieldRow label={t('flows.inspector.retry')} htmlFor={retryId} hint={t('flows.inspector.retryHint')}>
        <input
          id={retryId}
          className="fl-input"
          type="number"
          min={0}
          max={10}
          value={node.retry?.count ?? 0}
          onChange={(e) => {
            const count = Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0)));
            setNode({ retry: count ? { count, ...(node.retry?.delayMs ? { delayMs: node.retry.delayMs } : {}) } : undefined }, 'retry');
          }}
        />
      </FieldRow>
      {node.retry?.count ? (
        <DurationField
          label={t('flows.inspector.retryDelay')}
          valueMs={node.retry.delayMs}
          placeholderMs={0}
          maxMs={10 * 60_000}
          onChange={(delayMs) => node.retry?.count && setNode({ retry: { count: node.retry.count, ...(delayMs ? { delayMs } : {}) } }, 'retry')}
        />
      ) : null}
      {!ownTimeout || node.timeoutMs !== undefined ? (
        <DurationField
          name="timeoutMs"
          label={t('flows.inspector.timeout')}
          hint={t('flows.inspector.timeoutHint', { value: formatSpan(defaultTimeout, lang) })}
          valueMs={node.timeoutMs}
          placeholderMs={defaultTimeout}
          minMs={100}
          maxMs={60 * 60_000}
          onChange={(timeoutMs) => setNode({ timeoutMs }, 'timeout')}
        />
      ) : null}
      <FieldRow label={t('flows.inspector.note')} htmlFor={noteId}>
        <textarea id={noteId} className="fl-input" rows={2} value={node.note ?? ''} placeholder={t('flows.inspector.notePlaceholder')} onChange={(e) => setNode({ note: e.target.value || undefined }, 'note')} />
      </FieldRow>
    </div>
  );
}

/* ───────────── needs ───────────── */

function Needs({ node }: { node: FlowNode }) {
  const t = useT();
  const slack = useSlackStatus();
  const needs = flowNodeSpec(node.type)?.needs;
  if (!needs) return null;
  const rows: ReactNode[] = [];
  if (needs.deviceAction) {
    const s = DEVICE_ACTION_SUPPORT[needs.deviceAction];
    const android = s.android === 'all' ? t('flows.needs.yes') : s.android === 'emulator' ? t('flows.needs.emulatorOnly') : t('flows.needs.no');
    rows.push(
      <li key="device">
        {t('flows.needs.support', {
          android,
          sim: s.iosSimulator ? t('flows.needs.yes') : t('flows.needs.no'),
          iphone: s.iosDevice ? t('flows.needs.yes') : t('flows.needs.no'),
        })}
      </li>,
    );
  } else if (needs.device) rows.push(<li key="device">{t('flows.needs.device')}</li>);
  if (needs.sdk) rows.push(<li key="sdk">{t(`flows.needs.sdk.${needs.sdk}`)}</li>);
  if (needs.slack)
    rows.push(
      <li key="slack">
        {slack?.configured ? t('flows.needs.slackOk') : t('flows.needs.slackMissing')}
        {!slack?.configured ? (
          <Button size="sm" variant="ghost" onClick={() => ui.openSettings('slack')}>
            {t('flows.needs.connectSlack')}
          </Button>
        ) : null}
      </li>,
    );
  return (
    <div className="fl-needs">
      <div className="fl-needs__title">{t('flows.needs.title')}</div>
      <ul>{rows}</ul>
    </div>
  );
}

/* ───────────── outputs ───────────── */

function Outputs({ flow, node, flows }: { flow: FlowDoc; node: FlowNode; flows: FlowSummary[] }) {
  const t = useT();
  const lang = useLanguage();
  const spec = flowNodeSpec(node.type);
  const [subOutputs, setSubOutputs] = useState<{ name: string; description?: string }[] | null>(null);
  const calls = node.type === 'flow.call' && typeof node.params?.flowId === 'string' ? node.params.flowId : '';
  useEffect(() => {
    if (!calls || !flows.some((f) => f.id === calls)) {
      setSubOutputs(null);
      return;
    }
    const ctrl = new AbortController();
    api.getFlow(calls, ctrl.signal).then(
      (r) => setSubOutputs(r.flow.outputs ?? []),
      () => setSubOutputs(null),
    );
    return () => ctrl.abort();
  }, [calls, flows]);
  const rows = useMemo(() => {
    if (!spec) return [];
    if (node.type === 'logic.setVariables') {
      const list = Array.isArray(node.params?.assignments) ? (node.params!.assignments as { name?: string }[]) : [];
      return list.filter((a) => a.name).map((a) => ({ expr: `vars.${a.name}`, text: t('flows.outputs.var') }));
    }
    const base = spec.outputs.filter((o) => !o.name.startsWith('<')).map((o) => ({ expr: `${node.id}.${o.name}`, text: outputText(node.type, o.name, lang) }));
    const vars = (Array.isArray(node.params?.extract) ? (node.params!.extract as { name?: string }[]) : []).filter((x) => x.name).map((x) => ({ expr: `vars.${x.name}`, text: t('flows.outputs.extracted') }));
    const sub = (subOutputs ?? []).map((o) => ({ expr: `${node.id}.outputs.${o.name}`, text: o.description ?? t('flows.outputs.subflow') }));
    return [...vars, ...sub, ...base];
  }, [spec, node, subOutputs, lang, t]);
  void flow;
  if (!rows.length) return null;
  return (
    <Section title={t('flows.inspector.outputs')}>
      <p className="fl-insp__hint">{t('flows.inspector.outputsHint')}</p>
      <ul className="fl-outputs">
        {rows.map((r) => (
          <li key={r.expr}>
            <button
              type="button"
              className="fl-outputs__expr"
              title={t('flows.outputs.copy')}
              onClick={async () => {
                if (await copyText(`{{${r.expr}}}`)) toast.success(t('flows.outputs.copied', { expr: `{{${r.expr}}}` }), { id: 'flow-copy', duration: 1500 });
              }}
            >
              <Copy size={11} aria-hidden />
              {`{{${r.expr}}}`}
            </button>
            <span className="fl-outputs__text">{r.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ───────────── last run ───────────── */

function LastStep({ step }: { step: FlowRunStep }) {
  const t = useT();
  const err = stepError(step);
  const text = stepText(step);
  return (
    <Section
      title={t('flows.inspector.lastRun')}
      aside={
        <span className={clsx('fl-chip', `is-${step.status === 'failed' && step.handled ? 'handled' : step.status}`)}>
          {t(statusKey(step.status, step.handled))}
          {step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)}` : ''}
        </span>
      }
    >
      {text ? <p className="fl-insp__result">{text}</p> : null}
      {err && err !== text ? <p className="fl-insp__error">{err}</p> : null}
      {step.unsupported ? <p className="fl-insp__hint">{tCode(step.unsupported, step.params, step.unsupported)}</p> : null}
      {step.netId ? (
        <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => ui.focusNetwork(step.netId!)}>
          {t('flows.inspector.openRequest')}
        </Button>
      ) : null}
      {step.evidence?.length ? <Evidence items={step.evidence} /> : null}
      {step.output !== undefined ? (
        <div className="fl-insp__output">
          <JsonTree data={step.output} rootLabel={step.nodeId} defaultExpandDepth={1} toolbar={false} />
          <CopyButton value={() => JSON.stringify(step.output, null, 2)} label={t('flows.inspector.copyOutput')} size="xs" />
        </div>
      ) : null}
    </Section>
  );
}

export function IssueList({ issues, nodes = [], onSelectNode }: { issues: FlowIssue[]; nodes?: readonly FlowNode[]; onSelectNode?(id: string, path?: string): void }) {
  const lang = useLanguage();
  return (
    <ul className="fl-issues">
      {issues.map((i, k) => (
        <li key={k} className={clsx('fl-issues__item', i.level === 'error' ? 'is-error' : 'is-warn')}>
          <TriangleAlert size={12} aria-hidden />
          <span>
            {issueText(i, nodes, lang)}
            {i.nodeId && onSelectNode ? (
              <button type="button" className="fl-issues__node" onClick={() => onSelectNode(i.nodeId!, i.path)}>
                {stepLabel(nodes, i.nodeId)}
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Log in (request1)": a step's name with its id, or the bare id when the step is gone. */
function stepLabel(nodes: readonly FlowNode[], id: string): string {
  const n = nodes.find((x) => x.id === id);
  return n ? `${nodeName(n)} (${n.id})` : id;
}
