import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ListPlus, RefreshCw, SearchX } from 'lucide-react';
import type { NetworkEntry } from '@durbun/protocol';
import { Button, Checkbox, Dialog, EmptyState, Input, MethodBadge, SearchInput, StatusBadge, Toggle, formatClock, toast } from '../../../components';
import { api, networkStore, useCompiledScope, useNetworkVersion } from '../../../data';
import { errorText, useT } from '../../../i18n';

export interface FromRequestsDialogProps {
  open: boolean;
  /** Requests to start with (the Network tab's "Create a flow"). */
  initialIds?: readonly string[];
  onClose(): void;
  onCreated(id: string): void;
}

const MAX_ROWS = 400;
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|otf|mp4|mp3|webm)(\?|$)/i;

function isAsset(e: NetworkEntry): boolean {
  return ASSET_RE.test(e.path) || /^(image|font|video|audio)\//.test(e.responseContentType ?? '');
}

/** Pick captured requests (Network tab) → a flow that repeats them in order, linking values between steps. */
export function FromRequestsDialog({ open, initialIds, onClose, onCreated }: FromRequestsDialogProps) {
  const t = useT();
  const scope = useCompiledScope();
  const version = useNetworkVersion({ enabled: open, throttleMs: 500 });
  const [query, setQuery] = useState('');
  const [hideAssets, setHideAssets] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [saveEnv, setSaveEnv] = useState(true);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<string | null>(null);
  // The list is what was captured when the dialog opened: rows that keep arriving would move under the pointer.
  const [snapshot, setSnapshot] = useState<ReadonlySet<string>>(() => new Set());
  const takeSnapshot = () => setSnapshot(new Set(networkStore.list().map((e) => e.id)));

  useEffect(() => {
    if (!open) return;
    setPicked(new Set(initialIds ?? []));
    setQuery('');
    setName('');
    takeSnapshot();
    anchor.current = null;
  }, [open, initialIds]);

  const rows = useMemo(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const out: NetworkEntry[] = [];
    const list = networkStore.list();
    for (let i = list.length - 1; i >= 0 && out.length < MAX_ROWS; i--) {
      const e = list[i]!;
      if (!snapshot.has(e.id) || e.method === '?' || e.source === 'flow' || !scope.network(e)) continue;
      if (hideAssets && isAsset(e) && !picked.has(e.id)) continue;
      if (q && !`${e.method} ${e.url} ${e.status ?? ''}`.toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version, scope, query, hideAssets, snapshot]);

  /** Something was captured at all (in scope): an empty list then comes from the search or the asset filter. */
  const hasAny = useMemo(() => {
    if (!open) return false;
    for (const e of networkStore.list()) if (snapshot.has(e.id) && e.method !== '?' && e.source !== 'flow' && scope.network(e)) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version, scope, snapshot]);

  /** Requests captured since the list was taken (they come in at the end of the store). */
  const newer = useMemo(() => {
    if (!open || snapshot.size === 0) return 0;
    const list = networkStore.list();
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (snapshot.has(e.id)) break;
      if (e.method !== '?' && e.source !== 'flow' && scope.network(e)) n++;
    }
    return n;
  }, [open, version, scope, snapshot]);

  const chosen = useMemo(() => {
    const all = networkStore.list().filter((e) => picked.has(e.id));
    return all.sort((a, b) => a.startTs - b.startTs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, version]);
  const defaultName = useMemo(() => {
    const first = chosen[0];
    if (!first) return t('flows.fromRequests.defaultName');
    const hosts = new Set(chosen.map((e) => e.host));
    return hosts.size === 1 ? t('flows.fromRequests.nameHost', { host: first.host }) : t('flows.fromRequests.defaultName');
  }, [chosen, t]);

  const toggle = (id: string, shift: boolean) => {
    const next = new Set(picked);
    if (shift && anchor.current) {
      const a = rows.findIndex((r) => r.id === anchor.current);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        const on = !picked.has(id);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          if (on) next.add(rows[i]!.id);
          else next.delete(rows[i]!.id);
        }
        setPicked(next);
        anchor.current = id;
        return;
      }
    }
    if (next.has(id)) next.delete(id);
    else next.add(id);
    anchor.current = id;
    setPicked(next);
  };
  const allVisible = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const someVisible = rows.some((r) => picked.has(r.id));

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.flowFromRequests(
        chosen.map((e) => e.id),
        name.trim() || defaultName,
        { saveEnv },
      );
      const parts = [
        r.envVars.length && saveEnv ? t('flows.fromRequests.envSaved', { count: r.envVars.length }) : '',
        r.links ? t('flows.fromRequests.linked', { count: r.links }) : '',
      ].filter(Boolean);
      toast.success(t('flows.fromRequests.created', { name: r.flow.name }), parts.length ? { description: parts.join(' · ') } : undefined);
      onCreated(r.flow.id);
    } catch (err) {
      toast.error(t('flows.fromRequests.failed'), { description: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('flows.fromRequests.title')}
      description={t('flows.fromRequests.description')}
      icon={ListPlus}
      size="xl"
      footer={
        <>
          <Toggle size="sm" checked={saveEnv} onChange={setSaveEnv} label={t('flows.fromRequests.saveEnv')} description={t('flows.fromRequests.saveEnvHint')} />
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={ListPlus} loading={busy} disabled={!chosen.length} onClick={() => void create()}>
            {chosen.length ? t('flows.fromRequests.create', { count: chosen.length }) : t('flows.fromRequests.createNone')}
          </Button>
        </>
      }
    >
      <div className="fl-fromreq">
        <label className="fl-fromreq__namerow">
          <span>{t('flows.fromRequests.name')}</span>
          <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} wrapperClassName="fl-fromreq__name" />
        </label>
        <div className="fl-fromreq__bar">
          <Checkbox
            checked={allVisible}
            indeterminate={!allVisible && someVisible}
            onChange={(c) => {
              const next = new Set(picked);
              for (const r of rows) {
                if (c) next.add(r.id);
                else next.delete(r.id);
              }
              setPicked(next);
            }}
            aria-label={t('flows.fromRequests.selectAll')}
          />
          <SearchInput value={query} onChange={setQuery} placeholder={t('flows.fromRequests.search')} size="sm" className="fl-fromreq__search" />
          <Toggle size="sm" checked={hideAssets} onChange={setHideAssets} label={t('flows.fromRequests.hideAssets')} />
          <span className="grow" />
          {newer > 0 ? (
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={takeSnapshot}>
              {t('flows.fromRequests.newer', { count: newer })}
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          // Requests were captured but the search (or the asset filter) hides them all: say so, and undo it.
          (query.trim() || hideAssets) && hasAny ? (
            <EmptyState
              size="sm"
              icon={SearchX}
              title={t('flows.fromRequests.noMatchTitle')}
              description={t('flows.fromRequests.noMatchHint')}
              actions={
                <>
                  {query.trim() ? (
                    <Button size="sm" variant="secondary" onClick={() => setQuery('')}>
                      {t('flows.fromRequests.clearSearch')}
                    </Button>
                  ) : null}
                  {hideAssets ? (
                    <Button size="sm" variant="ghost" onClick={() => setHideAssets(false)}>
                      {t('flows.fromRequests.showAssets')}
                    </Button>
                  ) : null}
                </>
              }
            />
          ) : (
            <EmptyState size="sm" icon={ListPlus} title={t('flows.fromRequests.emptyTitle')} description={t('flows.fromRequests.emptyHint')} />
          )
        ) : (
          <div className="fl-fromreq__rows" role="listbox" aria-multiselectable aria-label={t('flows.fromRequests.list')}>
            {rows.map((e) => {
              const on = picked.has(e.id);
              const order = on ? chosen.findIndex((c) => c.id === e.id) + 1 : 0;
              return (
                <div
                  key={e.id}
                  role="option"
                  aria-selected={on}
                  tabIndex={0}
                  className={clsx('fl-fromreq__row', on && 'is-on')}
                  onClick={(ev) => toggle(e.id, ev.shiftKey)}
                  onKeyDown={(ev) => {
                    if (ev.key === ' ' || ev.key === 'Enter') {
                      ev.preventDefault();
                      toggle(e.id, ev.shiftKey);
                    }
                  }}
                >
                  <span className="fl-fromreq__order tnum" aria-hidden>
                    {order || ''}
                  </span>
                  <MethodBadge method={e.method} />
                  <span className="fl-fromreq__path" title={e.url}>
                    <span className="fl-fromreq__host">{e.host}</span>
                    {e.path}
                  </span>
                  <StatusBadge status={e.status} state={e.state} />
                  <span className="fl-fromreq__time tnum">{formatClock(e.startTs, { seconds: true })}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="fl-insp__hint">{t('flows.fromRequests.orderHint')}</p>
      </div>
    </Dialog>
  );
}
