import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Cpu, Gauge } from 'lucide-react';
import type { AppSession, DeviceInfo, ProcessUpdate } from '@durbun/protocol';
import { Popover, SdkBadge, SearchInput, StatusDot } from '../../components';
import { useT } from '../../i18n';
import { appTargetOf, canPoll, hasMetricsCapability, targetKey, type PerfTarget } from './model';

export interface PickerOption {
  key: string;
  target: PerfTarget;
  kind: 'app' | 'process';
  name: string;
  detail: string;
  deviceName?: string;
  connected?: boolean;
  died?: boolean;
  platform?: AppSession['sdk']['platform'];
  noMetrics?: boolean;
  search: string;
}

const MAX_PROCESSES = 150;

export function buildOptions(input: {
  scopeDeviceIds: readonly string[] | null;
  apps: Record<string, AppSession>;
  devices: Record<string, DeviceInfo>;
  processes: Record<string, Record<number, ProcessUpdate>>;
  labels: { sessions: (n: number) => string; pid: (pid: number) => string; vm: string; sdk: string };
}): { apps: PickerOption[]; processes: PickerOption[] } {
  const inScope = (deviceId: string) => input.scopeDeviceIds === null || input.scopeDeviceIds.includes(deviceId);
  // One option per app group (device + bundle id), represented by its newest session.
  const groups = new Map<string, AppSession[]>();
  for (const a of Object.values(input.apps)) {
    if (!inScope(a.deviceId)) continue;
    const k = `${a.deviceId}|${a.app.id}`;
    const list = groups.get(k);
    if (list) list.push(a);
    else groups.set(k, [a]);
  }
  const apps: PickerOption[] = [];
  for (const sessions of groups.values()) {
    sessions.sort((x, y) => Number(y.connected) - Number(x.connected) || y.connectedAt - x.connectedAt);
    const latest = sessions[0]!;
    const target = appTargetOf(latest);
    const device = input.devices[latest.deviceId];
    const vm = latest.transport === 'vm-service';
    const parts = [latest.app.id];
    if (sessions.length > 1) parts.push(input.labels.sessions(sessions.length));
    apps.push({
      key: targetKey(target),
      target,
      kind: 'app',
      name: latest.app.name || latest.app.id,
      detail: parts.join(' · '),
      deviceName: device?.name,
      connected: sessions.some((s) => s.connected),
      platform: latest.sdk.platform,
      noMetrics: !sessions.some(hasMetricsCapability),
      search: `${latest.app.name} ${latest.app.id} ${device?.name ?? ''} ${vm ? input.labels.vm : input.labels.sdk}`.toLowerCase(),
    });
  }
  apps.sort((a, b) => Number(b.connected) - Number(a.connected) || Number(a.noMetrics) - Number(b.noMetrics) || a.name.localeCompare(b.name));

  const processes: PickerOption[] = [];
  for (const [deviceId, byPid] of Object.entries(input.processes)) {
    if (!inScope(deviceId)) continue;
    const device = input.devices[deviceId];
    if (!canPoll(device)) continue;
    for (const p of Object.values(byPid)) {
      const target: PerfTarget = { kind: 'process', deviceId, pid: p.pid, name: p.name };
      processes.push({
        key: targetKey(target),
        target,
        kind: 'process',
        name: p.name,
        detail: input.labels.pid(p.pid),
        deviceName: device?.name,
        died: p.event === 'died',
        search: `${p.name} ${p.pid} ${device?.name ?? ''}`.toLowerCase(),
      });
    }
  }
  processes.sort((a, b) => Number(a.died) - Number(b.died) || a.name.localeCompare(b.name) || (a.target as { pid: number }).pid - (b.target as { pid: number }).pid);
  return { apps, processes };
}

export function filterOptions(list: readonly PickerOption[], query: string): PickerOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice();
  const terms = q.split(/\s+/);
  return list.filter((o) => terms.every((term) => o.search.includes(term)));
}

interface TargetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  options: { apps: PickerOption[]; processes: PickerOption[] };
  current: PerfTarget | null;
  pollingKeys: ReadonlySet<string>;
  showDeviceNames: boolean;
  onSelect: (target: PerfTarget) => void;
  /** Focus the process section first (from the "poll a process" empty state). */
  focusProcesses?: boolean;
}

/** Searchable listbox of app and process targets (↑/↓, Enter, Esc). */
export function TargetPicker({ open, onOpenChange, anchorRef, options, current, pollingKeys, showDeviceNames, onSelect, focusProcesses }: TargetPickerProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The popover becomes visible only after it is positioned: focus the search field on the next frame.
  useEffect(() => {
    if (!open) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open]);

  const apps = useMemo(() => filterOptions(options.apps, query), [options.apps, query]);
  const allProcesses = useMemo(() => filterOptions(options.processes, query), [options.processes, query]);
  const processes = allProcesses.slice(0, MAX_PROCESSES);
  const flat = useMemo(() => [...apps, ...processes], [apps, processes]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const curKey = targetKey(current);
    const all = [...options.apps, ...options.processes.slice(0, MAX_PROCESSES)];
    const idx = focusProcesses ? options.apps.length : Math.max(0, all.findIndex((o) => o.key === curKey));
    setActive(Math.min(idx, Math.max(0, all.length - 1)));
    // only when opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (o: PickerOption | undefined) => {
    if (!o) return;
    onSelect(o.target);
    onOpenChange(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 8));
    }
  };

  const curKey = targetKey(current);
  const renderOption = (o: PickerOption, index: number) => {
    const selected = o.key === curKey;
    return (
      <div
        key={o.key}
        id={`${listId}-${index}`}
        data-index={index}
        role="option"
        aria-selected={selected}
        className={clsx('pf-pick__opt', index === active && 'is-active', selected && 'is-selected', (o.died || (o.kind === 'app' && !o.connected)) && 'is-dim')}
        onPointerMove={() => {
          if (active !== index) setActive(index);
        }}
        onClick={() => choose(o)}
      >
        <span className="pf-pick__icon" aria-hidden>
          {o.kind === 'app' ? <Gauge size={14} /> : <Cpu size={14} />}
        </span>
        <span className="pf-pick__main">
          <span className="pf-pick__name">
            <span className={clsx('truncate', o.kind === 'process' && 'mono')}>{o.name}</span>
            {o.platform ? <SdkBadge platform={o.platform} /> : null}
          </span>
          <span className="pf-pick__detail mono truncate">
            {o.detail}
            {showDeviceNames && o.deviceName ? ` · ${o.deviceName}` : ''}
          </span>
        </span>
        <span className="pf-pick__state">
          {pollingKeys.has(o.key) ? <span className="pf-pick__badge pf-pick__badge--on">{t('perf.picker.polling')}</span> : null}
          {o.kind === 'app' && o.noMetrics ? <span className="pf-pick__badge">{t('perf.picker.noMetrics')}</span> : null}
          {o.kind === 'app' ? (
            <StatusDot tone={o.connected ? 'success' : 'neutral'} size={7} title={o.connected ? t('perf.picker.live') : t('perf.picker.ended')} />
          ) : o.died ? (
            <span className="pf-pick__badge">{t('perf.picker.died')}</span>
          ) : null}
        </span>
      </div>
    );
  };

  return (
    <Popover open={open} onClose={() => onOpenChange(false)} anchor={anchorRef} side="bottom" align="start" width={440} className="pf-pick" aria-label={t('perf.target.choose')}>
      <div className="pf-pick__inner" onKeyDown={onKeyDown}>
        <div className="pf-pick__search">
          <SearchInput
            value={query}
            onChange={(v) => {
              setQuery(v);
              setActive(0);
            }}
            placeholder={t('perf.picker.search')}
            size="sm"
            inputRef={inputRef}
            aria-label={t('perf.picker.search')}
          />
        </div>
        <div
          ref={listRef}
          className="pf-pick__list"
          role="listbox"
          id={listId}
          aria-label={t('perf.target.choose')}
          aria-activedescendant={flat.length > 0 ? `${listId}-${active}` : undefined}
          tabIndex={-1}
        >
          <div className="pf-pick__group" role="presentation">
            <span>{t('perf.picker.apps')}</span>
            <span className="pf-pick__group-hint">{t('perf.picker.appsHint')}</span>
          </div>
          {apps.length === 0 ? <div className="pf-pick__none">{query ? t('perf.picker.empty', { query }) : t('perf.picker.noApps')}</div> : apps.map((o, i) => renderOption(o, i))}
          <div className="pf-pick__group" role="presentation">
            <span>{t('perf.picker.processes')}</span>
            <span className="pf-pick__group-hint">{t('perf.picker.processesHint')}</span>
          </div>
          {processes.length === 0 ? (
            <div className="pf-pick__none">{query ? t('perf.picker.empty', { query }) : t('perf.picker.noProcesses')}</div>
          ) : (
            processes.map((o, i) => renderOption(o, apps.length + i))
          )}
          {allProcesses.length > processes.length ? <div className="pf-pick__none">{t('perf.picker.more', { count: allProcesses.length - processes.length })}</div> : null}
        </div>
      </div>
    </Popover>
  );
}

export function PickerButton({ buttonRef, label, sub, onClick, expanded }: { buttonRef: RefObject<HTMLButtonElement | null>; label: string; sub?: string; onClick: () => void; expanded: boolean }) {
  const t = useT();
  return (
    <button ref={buttonRef} type="button" className="pf-target" aria-haspopup="listbox" aria-expanded={expanded} onClick={onClick} title={t('perf.target.choose')}>
      <Gauge size={15} aria-hidden className="pf-target__icon" />
      <span className="pf-target__text">
        <span className="pf-target__label truncate">{label}</span>
        {sub ? <span className="pf-target__sub truncate">{sub}</span> : null}
      </span>
      <ChevronDown size={14} aria-hidden className="pf-target__chev" />
    </button>
  );
}
