import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { Eraser, LayoutGrid, Play, RefreshCw, RotateCcw, Square, Trash, Upload } from 'lucide-react';
import type { AppSession, DeviceActionId, DeviceInfo } from '@durbun/protocol';
import { api } from '../../data';
import {
  Button,
  Callout,
  Checkbox,
  IconButton,
  SearchInput,
  Spinner,
  StatusDot,
  confirm,
  formatBytes,
  formatPercent,
  pickFiles,
  toast,
  usePersistentState,
} from '../../components';
import { useT } from '../../i18n';
import { describeError } from './codes';
import { checkInstallFile, filterApps, hasAction, installAccept, installTarget, mergeApps, type AppRow } from './model';
import { loadInstalledApps, useInstalledApps } from './stores';
import { ActionErrorCallout, DeviceCard, useDeviceAction, type ActionError } from './useAction';

type AppOp = 'launch' | 'stop' | 'restart' | 'clearData' | 'uninstall';
const OPS: { op: AppOp; action: DeviceActionId; icon: typeof Play; danger?: boolean }[] = [
  { op: 'launch', action: 'app-launch', icon: Play },
  { op: 'stop', action: 'app-stop', icon: Square },
  { op: 'restart', action: 'app-restart', icon: RotateCcw },
  { op: 'clearData', action: 'app-clear-data', icon: Eraser, danger: true },
  { op: 'uninstall', action: 'app-uninstall', icon: Trash, danger: true },
];

export function useAppRows(device: DeviceInfo, sessions: readonly AppSession[]): AppRow[] {
  const entry = useInstalledApps((s) => s.byDevice[device.id]);
  return useMemo(() => mergeApps(entry?.apps, sessions), [entry?.apps, sessions]);
}

export function AppsCard({ device, sessions, preferredAppId, active }: { device: DeviceInfo; sessions: readonly AppSession[]; preferredAppId?: string; active: boolean }) {
  const t = useT();
  const entry = useInstalledApps((s) => s.byDevice[device.id]);
  const [storedSystem, setIncludeSystem] = usePersistentState<boolean>('device.apps.system', false);
  const includeSystem = storedSystem === true;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { run, isPending, busy, error, clearError } = useDeviceAction(device.id);
  const canList = hasAction(device, 'list-apps');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !canList) return;
    const cur = useInstalledApps.getState().byDevice[device.id];
    if (cur?.loading) return;
    if (!cur?.apps || cur.includeSystem !== includeSystem) void loadInstalledApps(device.id, includeSystem);
  }, [active, canList, device.id, includeSystem]);

  const rows = useMemo(() => mergeApps(entry?.apps, sessions), [entry?.apps, sessions]);
  const visible = useMemo(() => filterApps(rows, query), [rows, query]);
  const fallbackId = preferredAppId && rows.some((r) => r.id === preferredAppId) ? preferredAppId : rows.find((r) => r.sdk)?.id;
  const selectedId = selected && rows.some((r) => r.id === selected) ? selected : (fallbackId ?? null);
  const sel = rows.find((r) => r.id === selectedId);
  const ops = OPS.filter((o) => hasAction(device, o.action));
  const listError = entry?.error !== undefined ? describeError(entry.error) : null;

  const doOp = async (o: (typeof OPS)[number]) => {
    if (!sel) return;
    const app = sel.name;
    if (o.op === 'clearData' || o.op === 'uninstall') {
      const k = o.op === 'clearData' ? 'confirmClear' : 'confirmUninstall';
      const ok = await confirm({
        title: t(`device.apps.${k}.title`, { app }),
        message: t(`device.apps.${k}.message`),
        confirmLabel: t(`device.apps.${k}.confirm`),
        danger: true,
      });
      if (!ok) return;
    }
    const r = await run({
      key: o.action,
      action: o.action,
      params: { appId: sel.id },
      success: t(`device.apps.done.${o.op}`, { app }),
      failure: t(`device.apps.failed.${o.op}`, { app }),
    });
    if (r.ok && (o.op === 'uninstall' || o.op === 'clearData') && canList) void loadInstalledApps(device.id, includeSystem);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || visible.length === 0) return;
    e.preventDefault();
    const idx = Math.max(0, visible.findIndex((r) => r.id === selectedId));
    const next = e.key === 'ArrowDown' ? Math.min(visible.length - 1, idx + 1) : e.key === 'ArrowUp' ? Math.max(0, idx - 1) : e.key === 'Home' ? 0 : visible.length - 1;
    const row = visible[next]!;
    setSelected(row.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-app="${CSS.escape(row.id)}"]`)?.focus());
  };

  const focusId = visible.some((r) => r.id === selectedId) ? selectedId : visible[0]?.id;

  return (
    <DeviceCard
      section="apps"
      title={t('device.apps.title')}
      icon={LayoutGrid}
      description={rows.length > 0 ? t('device.apps.count', { count: rows.length }) : undefined}
      actions={
        canList ? (
          <>
            <Checkbox checked={includeSystem} onChange={(v) => setIncludeSystem(v)} label={t('device.apps.system')} />
            <IconButton icon={RefreshCw} size="sm" label={t('device.apps.refresh')} disabled={entry?.loading} onClick={() => void loadInstalledApps(device.id, includeSystem)} />
          </>
        ) : undefined
      }
    >
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {listError ? (
        <Callout
          tone="danger"
          compact
          title={t('device.apps.listFailed')}
          className="dv-error"
          actions={
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void loadInstalledApps(device.id, includeSystem)}>
              {t('common.retry')}
            </Button>
          }
        >
          {listError.text}
          {listError.detail ? <span className="dv-error__detail mono">{listError.detail}</span> : null}
          {sessions.length > 0 ? <span className="dv-error__detail">{t('device.apps.listHint')}</span> : null}
        </Callout>
      ) : null}
      {rows.length > 6 || query ? <SearchInput size="sm" value={query} onChange={setQuery} placeholder={t('device.apps.search')} className="dv-apps__search" /> : null}
      {entry?.loading && rows.length === 0 ? (
        <div className="dv-loading">
          <Spinner size={14} /> {t('device.apps.loading')}
        </div>
      ) : visible.length === 0 ? (
        <p className="dv-muted">{t('device.apps.empty')}</p>
      ) : (
        <div ref={listRef} className={clsx('dv-apps', entry?.loading && 'is-loading')} role="listbox" aria-label={t('device.apps.list')} onKeyDown={onListKey}>
          {visible.map((r) => (
            <div
              key={r.id}
              role="option"
              data-app={r.id}
              aria-selected={r.id === selectedId}
              tabIndex={r.id === focusId ? 0 : -1}
              className={clsx('dv-app', r.id === selectedId && 'is-selected', r.system && 'is-system')}
              onClick={() => setSelected(r.id)}
            >
              <span className="dv-app__main">
                <span className="dv-app__name truncate">{r.name}</span>
                <span className="dv-app__id mono truncate">{r.id}</span>
              </span>
              <span className="dv-app__badges">
                {r.sdk ? (
                  <span className={clsx('dv-badge', r.connected && 'dv-badge--live')} title={r.connected ? t('device.apps.sdkLive') : t('device.apps.sdk')}>
                    {r.connected ? <StatusDot tone="success" size={6} /> : null}
                    {t('device.apps.sdk')}
                  </span>
                ) : null}
                {r.debuggable ? <span className="dv-badge">{t('device.apps.debug')}</span> : null}
                {r.system ? <span className="dv-badge">{t('device.apps.systemBadge')}</span> : null}
                {!r.listed && entry?.apps ? <span className="dv-badge dv-badge--muted">{t('device.apps.notListed')}</span> : null}
                {r.version ? <span className="dv-app__version mono">{r.version}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      {ops.length > 0 ? (
        sel ? (
          <div className="dv-app-ops" role="group" aria-label={sel.name}>
            {ops.map((o) => (
              <Button
                key={o.op}
                size="sm"
                variant={o.danger ? 'ghost' : 'secondary'}
                icon={o.icon}
                loading={isPending(o.action)}
                disabled={busy && !isPending(o.action)}
                className={o.danger ? 'dv-danger-text' : undefined}
                onClick={() => void doOp(o)}
              >
                {t(`device.apps.${o.op}`)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="dv-muted">{t('device.apps.choose')}</p>
        )
      ) : null}
      {hasAction(device, 'app-install') ? <InstallDrop device={device} onInstalled={() => canList && void loadInstalledApps(device.id, includeSystem)} /> : null}
    </DeviceCard>
  );
}

type InstallState = { phase: 'idle' } | { phase: 'uploading'; name: string; loaded: number; total: number } | { phase: 'installing'; name: string };

function InstallDrop({ device, onInstalled }: { device: DeviceInfo; onInstalled: () => void }) {
  const t = useT();
  const target = installTarget(device);
  const accept = installAccept(target);
  const types = accept.split(',').join(' / ');
  const [over, setOver] = useState(false);
  const [state, setState] = useState<InstallState>({ phase: 'idle' });
  const [error, setError] = useState<ActionError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { run } = useDeviceAction(device.id);
  const depth = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reject = (text: string) => {
    setError({ title: t('device.apps.install.failed'), text });
    toast.warn(t('device.apps.install.failed'), { description: text });
  };

  const install = async (file: File) => {
    if (state.phase !== 'idle') return;
    setError(null);
    const check = checkInstallFile(file, target);
    if (!check.ok) {
      reject(t(`device.apps.install.${check.reason}`, { types }));
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ phase: 'uploading', name: file.name, loaded: 0, total: file.size });
    let serverPath: string;
    try {
      const res = await api.upload(file, {
        signal: ctrl.signal,
        onProgress: (loaded, total) => setState({ phase: 'uploading', name: file.name, loaded, total }),
      });
      serverPath = res.file;
    } catch (err) {
      abortRef.current = null;
      setState({ phase: 'idle' });
      if ((err as { name?: string })?.name === 'AbortError') {
        toast.info(t('device.apps.install.cancelled'));
        return;
      }
      const d = describeError(err);
      setError({ title: t('device.apps.install.uploadFailed'), text: d.text, detail: d.detail });
      toast.error(t('device.apps.install.uploadFailed'), { description: d.text });
      return;
    }
    abortRef.current = null;
    setState({ phase: 'installing', name: file.name });
    const r = await run({
      action: 'app-install',
      params: { file: serverPath },
      success: t('device.apps.install.done', { file: file.name }),
      failure: t('device.apps.install.failed'),
    });
    setState({ phase: 'idle' });
    if (r.ok) onInstalled();
    else {
      const d = describeError(r.error);
      setError({ title: t('device.apps.install.failed'), text: d.text, detail: d.detail });
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const items = e.dataTransfer.items;
    const entry = items && items.length > 0 ? (items[0] as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }).webkitGetAsEntry?.() : null;
    if (entry?.isDirectory) {
      reject(t('device.apps.install.directory'));
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;
    if (files.length > 1) toast.info(t('device.apps.install.oneFile'));
    void install(files[0]!);
  };

  const busy = state.phase !== 'idle';
  return (
    <div className="dv-install">
      <div className="dv-subhead">
        <span>{t('device.apps.install.title')}</span>
      </div>
      <div
        data-dropzone
        className={clsx('dv-drop', over && 'is-over', busy && 'is-busy')}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={onDrop}
      >
        {state.phase === 'idle' ? (
          <>
            <Upload size={18} aria-hidden className="dv-drop__icon" />
            <span className="dv-drop__text">{t('device.apps.install.drop', { types })}</span>
            <span className="dv-drop__or">{t('device.apps.install.or')}</span>
            <Button
              size="sm"
              onClick={async () => {
                const [file] = await pickFiles({ accept });
                if (file) void install(file);
              }}
            >
              {t('device.apps.install.pick')}
            </Button>
          </>
        ) : state.phase === 'uploading' ? (
          <div className="dv-progress dv-progress--inline" role="status" aria-live="polite">
            <span className="dv-progress__text truncate">
              {state.name} · {t('device.apps.install.uploading', { percent: formatPercent(state.total > 0 ? (state.loaded / state.total) * 100 : 0) })}
              <span className="subtle"> · {formatBytes(state.loaded)} / {formatBytes(state.total)}</span>
            </span>
            <div className="dv-progress__bar" aria-hidden>
              <span className="dv-progress__fill" style={{ width: `${state.total > 0 ? (state.loaded / state.total) * 100 : 0}%` }} />
            </div>
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
              {t('device.apps.install.cancel')}
            </Button>
          </div>
        ) : (
          <div className="dv-loading" role="status" aria-live="polite">
            <Spinner size={14} /> {t('device.apps.install.installing', { file: state.name })}
          </div>
        )}
      </div>
      <ActionErrorCallout error={error} onDismiss={() => setError(null)} />
    </div>
  );
}
