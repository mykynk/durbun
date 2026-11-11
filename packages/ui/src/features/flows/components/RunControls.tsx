import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Ban, Check, ChevronDown, CircleAlert, CircleCheck, Globe, Play, Smartphone, Square, TriangleAlert, Wand } from 'lucide-react';
import type { FlowDoc, FlowPreflight, FlowPreflightIssue, FlowRunRequest } from '@durbun/protocol';
import { Button, Dialog, DropdownMenu, Popover, Spinner, Tooltip, toast, type MenuItem } from '../../../components';
import { api, isDeviceUsable, isReadOnlyDevice, sortDevices, useHub, useScope } from '../../../data';
import { deviceDisplayName, useT } from '../../../i18n';
import { activeEnvironment, saveEnvironments, useEnvironments } from '../model/envStore';
import { flowErrorText } from '../model/errors';
import { issueText, nodeName } from '../model/text';

export interface RunTarget {
  deviceId?: string;
  appId?: string;
}

/** Device + app a run targets; null = let Dürbün choose. Follows the scope until the user picks one. */
export function useRunTarget(flow: FlowDoc | null): [RunTarget | null, (t: RunTarget | null) => void] {
  const scope = useScope();
  const apps = useHub((s) => s.apps);
  const devices = useHub((s) => s.devices);
  const [picked, setPicked] = useState<{ flowId: string; target: RunTarget | null } | null>(null);
  const fromScope = useMemo((): RunTarget | null => {
    if (scope.kind === 'device') return devices[scope.deviceId] && isDeviceUsable(devices[scope.deviceId]!) && !isReadOnlyDevice(scope.deviceId) ? { deviceId: scope.deviceId } : null;
    if (scope.kind === 'deviceApp') return devices[scope.deviceId] && !isReadOnlyDevice(scope.deviceId) ? { deviceId: scope.deviceId, appId: scope.bundleId } : null;
    if (scope.kind === 'app') {
      const a = apps[scope.appId];
      return a && !isReadOnlyDevice(a.deviceId) ? { deviceId: a.deviceId, appId: a.app.id } : null;
    }
    return null;
  }, [scope, apps, devices]);
  const current = picked && picked.flowId === flow?.id ? picked.target : fromScope;
  return [current, (target) => flow && setPicked({ flowId: flow.id, target })];
}

export function runRequest(target: RunTarget | null, environmentId: string | null | undefined, extra: Partial<FlowRunRequest> = {}): FlowRunRequest {
  return {
    ...(target ? { target } : {}),
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...extra,
  };
}

/** Preflight of the saved flow for the chosen target/environment, refreshed when any of them changes. */
export function usePreflight(flowId: string | null, req: FlowRunRequest, revision: string, enabled: boolean): { preflight: FlowPreflight | null; loading: boolean; refresh(): Promise<FlowPreflight | null> } {
  const [preflight, setPreflight] = useState<FlowPreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const key = `${flowId}|${JSON.stringify(req)}|${revision}`;
  const reqRef = useRef(req);
  reqRef.current = req;
  const devicesSig = useHub((s) =>
    Object.values(s.devices)
      .map((d) => `${d.id}:${d.state}`)
      .join(','),
  );
  const appsSig = useHub((s) =>
    Object.values(s.apps)
      .map((a) => `${a.id}:${a.connected ? 1 : 0}`)
      .join(','),
  );
  const run = async (signal?: AbortSignal): Promise<FlowPreflight | null> => {
    if (!flowId) return null;
    setLoading(true);
    try {
      const p = await api.preflightFlow(flowId, reqRef.current, signal);
      setPreflight(p);
      return p;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return null;
      setPreflight(null);
      return null;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!enabled || !flowId) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => void run(ctrl.signal), 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, devicesSig, appsSig]);
  return { preflight, loading, refresh: () => run() };
}

/* ───────────── target menu ───────────── */

export function TargetPicker({ flow, target, onChange, preflight }: { flow: FlowDoc; target: RunTarget | null; onChange(t: RunTarget | null): void; preflight: FlowPreflight | null }) {
  const t = useT();
  const devices = useHub((s) => s.devices);
  const apps = useHub((s) => s.apps);
  const label = useMemo(() => {
    if (!target) {
      const auto = preflight?.target;
      return auto?.deviceName ? t('flows.run.autoWith', { device: auto.deviceName }) : t('flows.run.auto');
    }
    const d = target.deviceId ? devices[target.deviceId] : undefined;
    const name = d ? deviceDisplayName(d) : (target.deviceId ?? t('flows.run.auto'));
    const app = target.appId ? Object.values(apps).find((a) => a.app.id === target.appId)?.app.name ?? target.appId : undefined;
    return app ? `${name} · ${app}` : name;
  }, [target, devices, apps, preflight, t]);

  const items = (): MenuItem[] => {
    const list: MenuItem[] = [
      { label: t('flows.run.auto'), icon: Wand, hint: t('flows.run.autoHint'), checked: !target, onSelect: () => onChange(null) },
    ];
    const usable = sortDevices(Object.values(devices)).filter((d) => !isReadOnlyDevice(d.id) && d.state !== 'disconnected');
    if (usable.length) list.push({ type: 'separator' });
    for (const d of usable) {
      const flowApp = flow.target?.appId;
      list.push({
        label: deviceDisplayName(d),
        icon: Smartphone,
        hint: !isDeviceUsable(d) ? t(`code.state.${d.state}`) : flowApp ?? undefined,
        checked: !!target && target.deviceId === d.id && (!target.appId || target.appId === flowApp),
        onSelect: () => onChange({ deviceId: d.id, ...(flowApp ? { appId: flowApp } : {}) }),
      });
      const sessions = Object.values(apps).filter((a) => a.deviceId === d.id && a.connected && a.app.id !== flowApp);
      const seen = new Set<string>();
      for (const a of sessions) {
        if (seen.has(a.app.id)) continue;
        seen.add(a.app.id);
        list.push({
          label: <span className="fl-target__app">{`${deviceDisplayName(d)} · ${a.app.name}`}</span>,
          hint: a.app.id,
          checked: !!target && target.deviceId === d.id && target.appId === a.app.id,
          onSelect: () => onChange({ deviceId: d.id, appId: a.app.id }),
        });
      }
    }
    if (!usable.length) list.push({ type: 'label', label: t('flows.run.noDevices') });
    return list;
  };
  return (
    <DropdownMenu items={items} minWidth={280} aria-label={t('flows.run.target')}>
      {(p) => (
        // The text may be cut short (or hidden on a narrow editor): the name carries the whole value.
        <button type="button" className="fl-runbar__picker" data-picker="target" {...p} title={`${t('flows.run.target')}: ${label}`} aria-label={`${t('flows.run.target')}: ${label}`}>
          <Smartphone size={13} aria-hidden />
          <span className="fl-runbar__picker-text">{label}</span>
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
    </DropdownMenu>
  );
}

export function EnvPicker({ onManage }: { onManage(): void }) {
  const t = useT();
  const envs = useEnvironments();
  const active = activeEnvironment(envs);
  const choose = async (activeId: string | undefined) => {
    if (!envs || envs.activeId === activeId) return;
    const { activeId: _a, ...rest } = envs;
    try {
      await saveEnvironments(activeId ? { ...rest, activeId } : rest);
    } catch (err) {
      toast.error(t('flows.env.pickFailed'), { description: flowErrorText(err) });
    }
  };
  const items = (): MenuItem[] => [
    ...(envs?.environments ?? []).map((e) => ({
      label: e.name,
      checked: e.id === envs?.activeId,
      hint: t('flows.env.varCount', { count: e.vars.length }),
      onSelect: () => void choose(e.id),
    })),
    // Running without an environment: every {{env.…}} stays empty.
    ...(envs?.environments.length
      ? [{ label: t('flows.env.none'), icon: Ban, hint: t('flows.env.noneHint', { example: '{{env.…}}' }), checked: !active, onSelect: () => void choose(undefined) }, { type: 'separator' as const }]
      : []),
    { label: t('flows.env.manage'), icon: Globe, onSelect: onManage },
  ];
  const label = active?.name ?? t('flows.env.none');
  return (
    <DropdownMenu items={items} minWidth={240} aria-label={t('flows.env.pick')}>
      {(p) => (
        <button type="button" className="fl-runbar__picker" {...p} title={`${t('flows.env.pick')}: ${label}`} aria-label={`${t('flows.env.pick')}: ${label}`}>
          <Globe size={13} aria-hidden />
          <span className="fl-runbar__picker-text">{label}</span>
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
    </DropdownMenu>
  );
}

/* ───────────── preflight ───────────── */

export function PreflightChip({ preflight, loading, flow }: { preflight: FlowPreflight | null; loading: boolean; flow: FlowDoc }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!preflight) return loading ? <Spinner size={14} className="fl-runbar__spin" /> : null;
  const errors = preflight.issues.filter((i) => i.level === 'error').length;
  const warns = preflight.issues.filter((i) => i.level === 'warn').length;
  const tone = !preflight.ok || errors ? 'danger' : warns || preflight.skipped.length ? 'warn' : 'ok';
  const Icon = tone === 'danger' ? CircleAlert : tone === 'warn' ? TriangleAlert : CircleCheck;
  const text = tone === 'danger' ? t('flows.preflight.blocked') : preflight.skipped.length ? t('flows.preflight.skips', { count: preflight.skipped.length }) : warns ? t('flows.preflight.warnings', { count: warns }) : t('flows.preflight.ready');
  return (
    <>
      <button ref={ref} type="button" className={clsx('fl-preflight-chip', `is-${tone}`)} onClick={() => setOpen((o) => !o)} aria-expanded={open} title={text}>
        {loading ? <Spinner size={12} /> : <Icon size={13} aria-hidden />}
        <span className="fl-preflight-chip__text">{text}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="bottom" align="start" width={380} className="fl-preflight-pop">
        <PreflightDetails preflight={preflight} flow={flow} />
      </Popover>
    </>
  );
}

export function PreflightDetails({ preflight, flow }: { preflight: FlowPreflight; flow: FlowDoc }) {
  const t = useT();
  const name = (i: { nodeId?: string; flowId?: string }) => {
    if (!i.nodeId) return null;
    const n = flow.nodes.find((x) => x.id === i.nodeId);
    return i.flowId && i.flowId !== flow.id ? `${i.flowId} › ${i.nodeId}` : n ? `${nodeName(n)} (${n.id})` : i.nodeId;
  };
  const tg = preflight.target;
  // The same problem on many steps (25 device steps with no device) reads as one line naming the steps.
  const rows: { level: FlowPreflightIssue['level']; text: string; where: string[] }[] = [];
  for (const i of preflight.issues) {
    const text = issueText(i, i.flowId && i.flowId !== flow.id ? [] : flow.nodes);
    const where = name(i);
    const row = rows.find((r) => r.level === i.level && r.text === text);
    if (!row) rows.push({ level: i.level, text, where: where ? [where] : [] });
    else if (where) row.where.push(where);
  }
  return (
    <div className="fl-preflight">
      {tg?.deviceName || tg?.appId ? (
        <div className="fl-preflight__target">
          <Smartphone size={13} aria-hidden />
          <span>{[tg.deviceName, tg.appName ?? tg.appId].filter(Boolean).join(' · ')}</span>
        </div>
      ) : null}
      {preflight.issues.length === 0 ? (
        <p className="fl-preflight__ok">
          <Check size={13} aria-hidden /> {t('flows.preflight.allGood')}
        </p>
      ) : (
        <ul className="fl-preflight__list">
          {rows.map((r, k) => (
            <PreflightRow key={k} {...r} />
          ))}
        </ul>
      )}
      {preflight.irreversible.length ? (
        <div className="fl-preflight__irreversible">
          <TriangleAlert size={13} aria-hidden />
          <span>{t('flows.preflight.irreversible', { steps: preflight.irreversible.map((id) => name({ nodeId: id }) ?? id).join(', ') })}</span>
        </div>
      ) : null}
    </div>
  );
}

const WHERE_SHOWN = 3;

function PreflightRow({ level, text, where }: { level: FlowPreflightIssue['level']; text: string; where: string[] }) {
  const t = useT();
  const Icon = level === 'error' ? CircleAlert : level === 'warn' ? TriangleAlert : CircleCheck;
  const more = where.length - WHERE_SHOWN;
  return (
    <li className={clsx('fl-preflight__item', `is-${level}`)}>
      <Icon size={13} aria-hidden />
      <span>
        {text}
        {where.length ? (
          <span className="fl-preflight__where" title={more > 0 ? where.join('\n') : undefined}>
            {where.slice(0, WHERE_SHOWN).join(', ')}
            {more > 0 ? ` ${t('flows.preflight.moreSteps', { count: more })}` : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/* ───────────── run dialog ───────────── */

export interface RunDialogState {
  preflight: FlowPreflight;
  startNodeId?: string;
}

export function RunDialog({
  open,
  flow,
  state,
  initialInputs,
  onClose,
  onRun,
}: {
  open: boolean;
  flow: FlowDoc;
  state: RunDialogState | null;
  initialInputs: Record<string, string>;
  onClose(): void;
  onRun(inputs: Record<string, unknown>): void;
}) {
  const t = useT();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (!open) return;
    const v: Record<string, string> = {};
    for (const d of flow.inputs ?? []) v[d.name] = initialInputs[d.name] ?? (d.default === undefined ? '' : String(d.default));
    setInputs(v);
    setAck(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!state) return null;
  const pf = state.preflight;
  const missing = (flow.inputs ?? []).filter((d) => d.required && !String(inputs[d.name] ?? '').trim());
  const needsAck = pf.irreversible.length > 0;
  const blocked = !pf.ok;
  const start = state.startNodeId ? flow.nodes.find((n) => n.id === state.startNodeId) : undefined;
  const canRun = !blocked && missing.length === 0 && (!needsAck || ack);
  const submit = () => {
    if (!canRun) return;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inputs)) if (v !== '') out[k] = v;
    onRun(out);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={start ? t('flows.run.dialogFromHere', { step: nodeName(start) }) : t('flows.run.dialogTitle', { name: flow.name })}
      icon={Play}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={Play} disabled={!canRun} onClick={submit}>
            {t('flows.run.start')}
          </Button>
        </>
      }
    >
      <div
        className="fl-rundialog"
        onKeyDown={(e) => {
          // Enter in an input field (or Cmd/Ctrl+Enter anywhere) runs, like submitting a form.
          const field = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox';
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (field || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <PreflightDetails preflight={pf} flow={flow} />
        {flow.inputs?.length ? (
          <div className="fl-rundialog__inputs">
            <h3>{t('flows.run.inputs')}</h3>
            {flow.inputs.map((d) => (
              <label key={d.name} className="fl-field">
                <span className="fl-field__label">
                  <code>{d.name}</code>
                  {d.required ? <span className="fl-field__req">*</span> : null}
                </span>
                <input
                  className="fl-input"
                  type={d.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={inputs[d.name] ?? ''}
                  placeholder={d.description}
                  onChange={(e) => setInputs((s) => ({ ...s, [d.name]: e.target.value }))}
                />
                {d.description ? <span className="fl-field__hint">{d.description}</span> : null}
              </label>
            ))}
          </div>
        ) : null}
        {needsAck && !blocked ? (
          <label className="fl-rundialog__ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{t('flows.run.ackIrreversible')}</span>
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}

export function RunButton({ running, busy, onRun, onStop }: { running: boolean; busy: boolean; onRun(): void; onStop(): void }) {
  const t = useT();
  return running ? (
    <Tooltip content={t('flows.run.stop')}>
      <Button size="sm" variant="danger" icon={Square} onClick={onStop} className="fl-runbtn">
        {t('flows.run.stop')}
      </Button>
    </Tooltip>
  ) : (
    <Tooltip content={t('flows.run.start')} shortcut="Mod+Enter">
      <Button size="sm" variant="primary" icon={Play} loading={busy} onClick={onRun} className="fl-runbtn">
        {t('flows.run.start')}
      </Button>
    </Tooltip>
  );
}
