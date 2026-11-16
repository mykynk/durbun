import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, CircleAlert, CircleCheck, CircleSlash, ListChecks, Smartphone, Tags, TriangleAlert, Wand } from 'lucide-react';
import type { FlowBatch, FlowBatchRequest, FlowPreflight, FlowSummary } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, DropdownMenu, SearchInput, SegmentedControl, Spinner, toast, type MenuItem } from '../../../components';
import { ApiError, api, isDeviceUsable, isReadOnlyDevice, sortDevices, useHub } from '../../../data';
import { deviceDisplayName, useT } from '../../../i18n';
import { MAX_SET_FLOWS, flowsWithTag, tagCounts } from '../model/batch';
import { flowErrorText } from '../model/errors';
import { rememberSet } from '../model/sets';
import { startBatch } from '../model/setsApi';
import { issueText } from '../model/text';
import { EnvPicker, runRequest, type RunTarget } from './RunControls';

/** What the dialog opens with ("Run again", a tag from the list, the palette). */
export interface BatchPreset {
  tag?: string;
  flowIds?: string[];
  target?: RunTarget | null;
  onFailure?: 'continue' | 'stop';
}

export interface BatchDialogProps {
  open: boolean;
  preset: BatchPreset | null;
  summaries: FlowSummary[];
  onClose(): void;
  /** Saves the flow open in the editor first (the set runs what the server has). */
  beforeStart(): Promise<void>;
  onStarted(batch: FlowBatch): void;
  /** Another set is running: show it. */
  onShowSet(id: string): void;
  onManageEnvironments(): void;
}

type Check = { state: 'loading' } | { state: 'ready'; irreversible: number } | { state: 'blocked'; text: string } | { state: 'unknown' };

/** Preflights are asked for at most this many flows (a bigger set is checked as it runs). */
const CHECK_LIMIT = 40;
const CHECK_PARALLEL = 4;

/** "Run several flows": pick by tag or by hand, choose device and environment, see what will run, start the set. */
export function BatchDialog({ open, preset, summaries, onClose, beforeStart, onStarted, onShowSet, onManageEnvironments }: BatchDialogProps) {
  const t = useT();
  const tags = useMemo(() => tagCounts(summaries), [summaries]);
  const [mode, setMode] = useState<'tag' | 'pick'>('tag');
  const [tag, setTag] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<RunTarget | null>(null);
  const [onFailure, setOnFailure] = useState<'continue' | 'stop'>('continue');
  const [ack, setAck] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const p = preset ?? {};
    const startTag = p.tag ?? (p.flowIds?.length ? null : (tags[0]?.tag ?? null));
    setMode(p.flowIds?.length || (!startTag && !p.tag) ? 'pick' : 'tag');
    setTag(startTag);
    setPicked(new Set(p.flowIds ?? []));
    setQuery('');
    setTarget(p.target ?? null);
    setOnFailure(p.onFailure ?? 'continue');
    setAck(false);
    setChecks({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sorted = useMemo(() => [...summaries].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [summaries]);
  const chosen = useMemo(() => (mode === 'tag' ? (tag ? flowsWithTag(summaries, tag) : []) : sorted.filter((f) => picked.has(f.id))), [mode, tag, summaries, sorted, picked]);
  const chosenKey = chosen.map((f) => `${f.id}@${f.updatedAt ?? 0}`).join(',');
  const targetKey = JSON.stringify(target);

  // What each flow would do on this device: blocked (skipped), hard-to-undo steps, ready.
  useEffect(() => {
    if (!open || !chosen.length) return;
    const ctrl = new AbortController();
    const ids = chosen.map((f) => f.id);
    setChecks(Object.fromEntries(ids.map((id, i) => [id, i < CHECK_LIMIT ? { state: 'loading' } : { state: 'unknown' }])));
    const queue = ids.slice(0, CHECK_LIMIT);
    const req = runRequest(target, undefined);
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        let check: Check;
        try {
          const pf: FlowPreflight = await api.preflightFlow(id, req, ctrl.signal);
          const blocking = pf.issues.find((i) => i.level === 'error');
          check = !pf.ok || blocking ? { state: 'blocked', text: blocking ? issueText(blocking) : t('flows.batch.dialog.cannotStart') } : { state: 'ready', irreversible: pf.irreversible.length };
        } catch (err) {
          if (ctrl.signal.aborted) return;
          check = { state: 'blocked', text: flowErrorText(err) };
        }
        if (ctrl.signal.aborted) return;
        const done = check;
        setChecks((c) => ({ ...c, [id]: done }));
      }
    };
    const timer = setTimeout(() => void Promise.all(Array.from({ length: CHECK_PARALLEL }, worker)), 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chosenKey, targetKey]);

  const blocked = chosen.filter((f) => checks[f.id]?.state === 'blocked').length;
  const irreversible = chosen.filter((f) => {
    const c = checks[f.id];
    return c?.state === 'ready' && c.irreversible > 0;
  });
  const skippedForUndo = ack ? 0 : irreversible.length;
  const willRun = Math.max(0, chosen.length - blocked - skippedForUndo);
  const tooMany = chosen.length > MAX_SET_FLOWS;
  const checking = chosen.some((f) => checks[f.id]?.state === 'loading');

  const start = async () => {
    if (!chosen.length || tooMany || starting) return;
    setStarting(true);
    try {
      await beforeStart();
      const req: FlowBatchRequest = {
        ...(mode === 'tag' && tag ? { tag } : { flowIds: chosen.map((f) => f.id) }),
        ...(target ? { target } : {}),
        onFailure,
        ...(ack && irreversible.length ? { allowIrreversible: true } : {}),
      };
      const b = await startBatch(req);
      rememberSet(b);
      onStarted(b);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'flow.batch.busy') {
        const id = typeof err.body?.params === 'object' && err.body.params ? (err.body.params as { id?: unknown }).id : undefined;
        toast.warn(t('flows.batch.busyTitle'), {
          description: flowErrorText(err),
          ...(typeof id === 'string' ? { action: { label: t('flows.batch.showRunning'), onClick: () => onShowSet(id) } } : {}),
        });
      } else toast.error(t('flows.batch.startFailed'), { description: flowErrorText(err) });
    } finally {
      setStarting(false);
    }
  };

  const q = query.trim().toLowerCase();
  const pickList = q ? sorted.filter((f) => f.name.toLowerCase().includes(q) || f.id.includes(q) || (f.tags ?? []).some((x) => x.toLowerCase().includes(q))) : sorted;
  const allShownPicked = pickList.length > 0 && pickList.every((f) => picked.has(f.id));
  const togglePick = (id: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      icon={ListChecks}
      title={t('flows.batch.dialog.title')}
      description={t('flows.batch.dialog.description')}
      bodyClassName="fl-batchdlg"
      autoFocusField={false}
      footer={
        <>
          <span className="fl-batchdlg__summary" aria-live="polite">
            {!chosen.length
              ? t('flows.batch.dialog.noneChosen')
              : tooMany
                ? t('flows.batch.dialog.tooMany', { max: MAX_SET_FLOWS })
                : checking
                  ? t('flows.batch.dialog.checking')
                  : willRun === chosen.length
                    ? t('flows.batch.dialog.allWillRun', { count: chosen.length })
                    : willRun === 0
                      ? t('flows.batch.dialog.noneWillRun')
                      : t('flows.batch.dialog.someSkipped', { run: willRun, skip: chosen.length - willRun })}
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {/* The count is what will really run once the checks are in (the skipped ones are still in the report). */}
          <Button variant="primary" loading={starting} disabled={!chosen.length || tooMany || (!checking && willRun === 0)} onClick={() => void start()}>
            {t('flows.batch.dialog.start', { count: checking ? chosen.length : Math.max(willRun, 1) })}
          </Button>
        </>
      }
    >
      <div className="fl-batchdlg__section">
        <div className="fl-batchdlg__row">
          <span className="fl-batchdlg__label">{t('flows.batch.dialog.which')}</span>
          <SegmentedControl
            size="sm"
            value={mode}
            onChange={setMode}
            aria-label={t('flows.batch.dialog.which')}
            options={[
              { value: 'tag', label: t('flows.batch.dialog.byTag'), icon: Tags },
              { value: 'pick', label: t('flows.batch.dialog.byHand'), icon: ListChecks },
            ]}
          />
        </div>
        {mode === 'tag' ? (
          tags.length ? (
            <div className="fl-batchdlg__tags" role="radiogroup" aria-label={t('flows.batch.dialog.byTag')}>
              {tags.map((x) => (
                <button key={x.tag} type="button" role="radio" aria-checked={tag?.toLowerCase() === x.tag.toLowerCase()} className={clsx('fl-batchdlg__tag', tag?.toLowerCase() === x.tag.toLowerCase() && 'is-on')} onClick={() => setTag(x.tag)}>
                  <span className="fl-batchdlg__tag-name">{x.tag}</span>
                  <span className="fl-batchdlg__tag-count tnum">{x.count}</span>
                </button>
              ))}
            </div>
          ) : (
            <Callout compact tone="info" icon={Tags}>
              {t('flows.batch.dialog.noTags')}
            </Callout>
          )
        ) : (
          <div className="fl-batchdlg__pick">
            <div className="fl-batchdlg__pickhead">
              <SearchInput value={query} onChange={setQuery} size="sm" placeholder={t('flows.list.search')} className="grow" />
              <Checkbox
                checked={allShownPicked}
                indeterminate={!allShownPicked && pickList.some((f) => picked.has(f.id))}
                onChange={(on) => setPicked((s) => {
                  const next = new Set(s);
                  for (const f of pickList) if (on) next.add(f.id);
                  else next.delete(f.id);
                  return next;
                })}
                label={t('flows.batch.dialog.all')}
              />
            </div>
            <ul className="fl-batchdlg__picklist" aria-label={t('flows.batch.dialog.byHand')}>
              {pickList.map((f) => (
                <li key={f.id}>
                  <Checkbox
                    checked={picked.has(f.id)}
                    onChange={(on) => togglePick(f.id, on)}
                    label={
                      <span className="fl-batchdlg__pickname">
                        <span className="truncate">{f.name}</span>
                        {f.tags?.length ? <span className="fl-batchdlg__picktags">{f.tags.slice(0, 3).join(', ')}</span> : null}
                      </span>
                    }
                  />
                </li>
              ))}
              {!pickList.length ? <li className="fl-batchdlg__empty">{t('flows.list.noResults')}</li> : null}
            </ul>
          </div>
        )}
      </div>

      <div className="fl-batchdlg__section">
        <div className="fl-batchdlg__row">
          <span className="fl-batchdlg__label">{t('flows.batch.dialog.where')}</span>
          <div className="fl-batchdlg__pickers">
            <SetTargetPicker target={target} onChange={setTarget} />
            <EnvPicker onManage={onManageEnvironments} />
          </div>
        </div>
        <div className="fl-batchdlg__row">
          <span className="fl-batchdlg__label">{t('flows.batch.dialog.onFailure')}</span>
          <SegmentedControl
            size="sm"
            value={onFailure}
            onChange={setOnFailure}
            aria-label={t('flows.batch.dialog.onFailure')}
            options={[
              { value: 'continue', label: t('flows.batch.dialog.continue') },
              { value: 'stop', label: t('flows.batch.dialog.stop') },
            ]}
          />
        </div>
      </div>

      {chosen.length ? (
        <div className="fl-batchdlg__section">
          <span className="fl-batchdlg__label">{t('flows.batch.dialog.order', { count: chosen.length })}</span>
          <ol className="fl-batchdlg__checks">
            {chosen.slice(0, MAX_SET_FLOWS).map((f) => (
              <CheckRow key={f.id} flow={f} check={checks[f.id]} ack={ack} />
            ))}
          </ol>
          {irreversible.length ? (
            <div className="fl-batchdlg__ack">
              <Checkbox checked={ack} onChange={setAck} label={t('flows.batch.dialog.ack', { count: irreversible.length })} />
              <span className="fl-batchdlg__hint">{t('flows.batch.dialog.ackHint')}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function CheckRow({ flow, check, ack }: { flow: FlowSummary; check: Check | undefined; ack: boolean }) {
  const t = useT();
  let icon = <Spinner size={12} />;
  let text = t('flows.batch.dialog.checkingOne');
  let tone = 'is-loading';
  if (check?.state === 'blocked') {
    icon = <CircleSlash size={13} aria-hidden />;
    text = t('flows.batch.dialog.willSkip', { why: check.text });
    tone = 'is-blocked';
  } else if (check?.state === 'ready' && check.irreversible) {
    icon = ack ? <TriangleAlert size={13} aria-hidden /> : <CircleSlash size={13} aria-hidden />;
    text = ack ? t('flows.batch.dialog.undoAllowed', { count: check.irreversible }) : t('flows.batch.dialog.undoSkipped', { count: check.irreversible });
    tone = ack ? 'is-warn' : 'is-blocked';
  } else if (check?.state === 'ready') {
    icon = <CircleCheck size={13} aria-hidden />;
    text = t('flows.batch.dialog.ready');
    tone = 'is-ready';
  } else if (check?.state === 'unknown') {
    icon = <CircleAlert size={13} aria-hidden />;
    text = t('flows.batch.dialog.checkedLater');
    tone = 'is-unknown';
  }
  return (
    <li className={clsx('fl-batchdlg__check', tone)}>
      <span className="fl-batchdlg__check-icon">{icon}</span>
      <span className="fl-batchdlg__check-name truncate">{flow.name}</span>
      <span className="fl-batchdlg__check-meta tnum">{t('flows.list.steps', { count: flow.nodeCount })}</span>
      <span className="fl-batchdlg__check-text">{text}</span>
    </li>
  );
}

/** Device (and app) for every flow of the set; "Let Dürbün choose" lets each flow find its own. */
function SetTargetPicker({ target, onChange }: { target: RunTarget | null; onChange(t: RunTarget | null): void }) {
  const t = useT();
  const devices = useHub((s) => s.devices);
  const apps = useHub((s) => s.apps);
  const d = target?.deviceId ? devices[target.deviceId] : undefined;
  const appName = target?.appId ? (Object.values(apps).find((a) => a.app.id === target.appId)?.app.name ?? target.appId) : undefined;
  const label = !target ? t('flows.batch.dialog.autoTarget') : [d ? deviceDisplayName(d) : target.deviceId, appName].filter(Boolean).join(' · ');
  const items = (): MenuItem[] => {
    const list: MenuItem[] = [{ label: t('flows.batch.dialog.autoTarget'), icon: Wand, description: t('flows.batch.dialog.autoTargetHint'), checked: !target, onSelect: () => onChange(null) }];
    const usable = sortDevices(Object.values(devices)).filter((x) => !isReadOnlyDevice(x.id) && x.state !== 'disconnected');
    if (usable.length) list.push({ type: 'separator' });
    for (const dev of usable) {
      list.push({
        label: deviceDisplayName(dev),
        icon: Smartphone,
        hint: !isDeviceUsable(dev) ? t(`code.state.${dev.state}`) : t('flows.batch.dialog.eachApp'),
        checked: !!target && target.deviceId === dev.id && !target.appId,
        onSelect: () => onChange({ deviceId: dev.id }),
      });
      const seen = new Set<string>();
      for (const a of Object.values(apps)) {
        if (a.deviceId !== dev.id || !a.connected || seen.has(a.app.id)) continue;
        seen.add(a.app.id);
        list.push({
          label: <span className="fl-target__app">{`${deviceDisplayName(dev)} · ${a.app.name}`}</span>,
          hint: a.app.id,
          checked: !!target && target.deviceId === dev.id && target.appId === a.app.id,
          onSelect: () => onChange({ deviceId: dev.id, appId: a.app.id }),
        });
      }
    }
    if (!usable.length) list.push({ type: 'label', label: t('flows.run.noDevices') });
    return list;
  };
  return (
    <DropdownMenu items={items} minWidth={300} align="start" aria-label={t('flows.run.target')}>
      {(p) => (
        <button type="button" className="fl-runbar__picker" {...p} title={`${t('flows.run.target')}: ${label}`} aria-label={`${t('flows.run.target')}: ${label}`}>
          <Smartphone size={13} aria-hidden />
          <span className="fl-runbar__picker-text">{label}</span>
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
    </DropdownMenu>
  );
}
