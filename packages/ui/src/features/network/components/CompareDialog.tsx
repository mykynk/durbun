import { useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowLeftRight, Equal } from 'lucide-react';
import type { NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, EmptyState, MethodBadge, Spinner, Tabs, formatBytes, formatClock, formatDuration, usePersistentState } from '../../../components';
import { errorText, useT } from '../../../i18n';
import { useNetworkDetail } from '../detailCache';
import { bodyLines, diffHeaders, type BodyLines, type HeaderDiffRow } from '../model/compare';
import { collapseUnchanged, diffLines, sideBySide, type DisplayRow } from '../model/diff';
import { reasonPhrase } from '../model/http';

type CompareTab = 'general' | 'headers' | 'response' | 'request';

function statusText(e: NetworkEntry, t: (k: string) => string): string {
  if (e.state === 'pending') return t('network.status.pending');
  if (e.status !== undefined) return `${e.status} ${e.statusText || reasonPhrase(e.status) || ''}`.trim() + (e.state === 'failed' ? ` · ${t('network.status.failed')}` : '');
  return e.state === 'cancelled' ? t('network.status.cancelled') : t('network.status.failed');
}

export function CompareDialog({ a: a0, b: b0, onClose }: { a: NetworkEntry; b: NetworkEntry; onClose: () => void }) {
  const t = useT();
  const [swapped, setSwapped] = useState(false);
  const a = swapped ? b0 : a0;
  const b = swapped ? a0 : b0;
  const da = useNetworkDetail(a);
  const db = useNetworkDetail(b);
  const [tab, setTab] = usePersistentState<CompareTab>('network.compareTab', 'response');

  return (
    <Dialog
      open
      onClose={onClose}
      size="full"
      icon={ArrowLeftRight}
      title={t('network.compare.title')}
      footer={
        <>
          <Button variant="ghost" icon={ArrowLeftRight} onClick={() => setSwapped((s) => !s)}>
            {t('network.compare.swap')}
          </Button>
          <span className="grow" />
          <Button variant="primary" onClick={onClose}>
            {t('network.compare.close')}
          </Button>
        </>
      }
      bodyClassName="net-cmp__dialog"
    >
      <div className="net-cmp">
        <div className="net-cmp__sides">
          <SideSummary label="A" e={a} />
          <SideSummary label="B" e={b} />
        </div>
        <Tabs<CompareTab>
          value={tab}
          onChange={setTab}
          idPrefix="net-cmp"
          aria-label={t('network.compare.tabsLabel')}
          items={[
            { value: 'general', label: t('network.compare.tabs.general') },
            { value: 'headers', label: t('network.compare.tabs.headers') },
            { value: 'response', label: t('network.compare.tabs.response') },
            { value: 'request', label: t('network.compare.tabs.request') },
          ]}
        />
        <div className="net-cmp__body" role="tabpanel" id={`net-cmp-panel-${tab}`} aria-labelledby={`net-cmp-tab-${tab}`}>
          {tab === 'general' ? <GeneralDiff a={a} b={b} /> : null}
          {tab === 'headers' ? <HeadersDiff a={a} b={b} /> : null}
          {tab === 'response' || tab === 'request' ? <BodyDiff which={tab} a={a} b={b} da={da} db={db} /> : null}
        </div>
      </div>
    </Dialog>
  );
}

function SideSummary({ label, e }: { label: string; e: NetworkEntry }) {
  const t = useT();
  return (
    <div className="net-cmp__side">
      <span className={clsx('net-cmp__tag', label === 'A' ? 'net-cmp__tag--a' : 'net-cmp__tag--b')}>{label}</span>
      <MethodBadge method={e.method} />
      <span className="net-cmp__status">{statusText(e, t)}</span>
      <span className="mono truncate net-cmp__url" title={e.url}>
        {e.url}
      </span>
      <span className="net-dim tnum">{formatClock(e.startTs)}</span>
    </div>
  );
}

function GeneralDiff({ a, b }: { a: NetworkEntry; b: NetworkEntry }) {
  const t = useT();
  const fields: [string, string, string][] = [
    [t('network.general.method'), a.method, b.method],
    [t('network.general.url'), a.url, b.url],
    [t('network.general.status'), statusText(a, t), statusText(b, t)],
    [t('network.general.duration'), formatDuration(a.duration), formatDuration(b.duration)],
    [t('network.general.responseSize'), formatBytes(a.responseBodySize), formatBytes(b.responseBodySize)],
    [t('network.general.requestSize'), formatBytes(a.requestBodySize), formatBytes(b.requestBodySize)],
    [t('network.general.responseType'), a.responseContentType ?? '—', b.responseContentType ?? '—'],
    [t('network.general.protocol'), a.protocol ?? '—', b.protocol ?? '—'],
    [t('network.general.source'), a.source, b.source],
    [t('network.general.start'), formatClock(a.startTs), formatClock(b.startTs)],
    [t('network.general.mockRule'), a.mocked ? t('network.general.yes') : '—', b.mocked ? t('network.general.yes') : '—'],
    [t('network.general.errorMessage'), a.error ?? '—', b.error ?? '—'],
  ];
  return (
    <div className="net-scroll net-cmp__pad">
      <div className="net-cmp__table" role="table" aria-label={t('network.compare.tabs.general')}>
        <div className="net-cmp__tr net-cmp__tr--head" role="row">
          <span role="columnheader">{t('network.compare.field')}</span>
          <span role="columnheader">A</span>
          <span role="columnheader">B</span>
        </div>
        {fields.map(([k, va, vb]) => (
          <div key={k} className={clsx('net-cmp__tr', va !== vb && 'is-changed')} role="row">
            <span className="net-cmp__key" role="rowheader">
              {k}
            </span>
            <span className="mono selectable" role="cell">
              {va}
            </span>
            <span className="mono selectable" role="cell">
              {vb}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeaderTable({ title, rows, onlyChanges }: { title: string; rows: HeaderDiffRow[]; onlyChanges: boolean }) {
  const t = useT();
  const shown = onlyChanges ? rows.filter((r) => r.state !== 'same') : rows;
  return (
    <section className="net-cmp__section">
      <h4 className="net-section-title">
        {title} <span className="net-dim tnum">{t('network.compare.headerStats', { changed: rows.filter((r) => r.state !== 'same').length, total: rows.length })}</span>
      </h4>
      {shown.length === 0 ? (
        <p className="net-dim net-small">{t('network.compare.headersSame')}</p>
      ) : (
        <div className="net-cmp__table" role="table" aria-label={title}>
          {shown.map((r) => (
            <div key={r.name.toLowerCase()} className={clsx('net-cmp__tr', r.state !== 'same' && 'is-changed', `is-${r.state}`)} role="row">
              <span className="net-cmp__key mono" role="rowheader">
                {r.name}
              </span>
              <span className="mono selectable" role="cell">
                {r.a.length ? r.a.join('\n') : <span className="net-dim">{t('network.compare.missing')}</span>}
              </span>
              <span className="mono selectable" role="cell">
                {r.b.length ? r.b.join('\n') : <span className="net-dim">{t('network.compare.missing')}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HeadersDiff({ a, b }: { a: NetworkEntry; b: NetworkEntry }) {
  const t = useT();
  const [onlyChanges, setOnlyChanges] = usePersistentState('network.compare.onlyChanges', true);
  const req = useMemo(() => diffHeaders(a.requestHeaders, b.requestHeaders), [a.requestHeaders, b.requestHeaders]);
  const res = useMemo(() => diffHeaders(a.responseHeaders, b.responseHeaders), [a.responseHeaders, b.responseHeaders]);
  return (
    <div className="net-scroll net-cmp__pad">
      <div className="net-cmp__opts">
        <Checkbox checked={onlyChanges} onChange={setOnlyChanges} label={t('network.compare.onlyChanges')} />
      </div>
      <HeaderTable title={t('network.compare.requestHeaders')} rows={req} onlyChanges={onlyChanges} />
      <HeaderTable title={t('network.compare.responseHeaders')} rows={res} onlyChanges={onlyChanges} />
    </div>
  );
}

type DetailHook = { detail: NetworkDetail | null; loading: boolean; error: unknown };

function BodyDiff({ which, a, b, da, db }: { which: 'request' | 'response'; a: NetworkEntry; b: NetworkEntry; da: DetailHook; db: DetailHook }) {
  const t = useT();
  const [sortKeys, setSortKeys] = usePersistentState('network.compare.sortKeys', true);
  const [onlyChanges, setOnlyChanges] = usePersistentState('network.compare.onlyChanges', true);
  const wa = which === 'request' ? da.detail?.requestBody : da.detail?.responseBody;
  const wb = which === 'request' ? db.detail?.requestBody : db.detail?.responseBody;
  const cta = which === 'request' ? a.requestContentType : a.responseContentType;
  const ctb = which === 'request' ? b.requestContentType : b.responseContentType;
  const la = useMemo(() => bodyLines(wa, cta, { sortKeys }), [wa, cta, sortKeys]);
  const lb = useMemo(() => bodyLines(wb, ctb, { sortKeys }), [wb, ctb, sortKeys]);

  if ((da.loading && !da.detail) || (db.loading && !db.detail)) {
    return (
      <div className="net-loading">
        <Spinner size={16} /> {t('network.body.loading')}
      </div>
    );
  }
  const err = (!da.detail && da.error) || (!db.detail && db.error);
  if (err) {
    return (
      <div className="net-cmp__pad">
        <Callout tone="danger" title={t('network.body.loadFailed')}>
          {errorText(err)}
        </Callout>
      </div>
    );
  }
  let notice: ReactNode = null;
  if (la.kind === 'binary' || lb.kind === 'binary') {
    const same = la.raw === lb.raw && la.kind === lb.kind;
    return (
      <EmptyState
        size="sm"
        icon={Equal}
        title={same ? t('network.compare.binarySame') : t('network.compare.binaryDifferent')}
        description={t('network.compare.binarySizes', { a: formatBytes(la.size), b: formatBytes(lb.size) })}
      />
    );
  }
  if (la.kind === 'notCaptured' || lb.kind === 'notCaptured') notice = t('network.compare.notCaptured');
  else if (la.truncated || lb.truncated) notice = t('network.compare.truncated');
  return (
    <div className="net-col net-cmp__diffwrap">
      <div className="net-cmp__opts">
        <Checkbox checked={onlyChanges} onChange={setOnlyChanges} label={t('network.compare.onlyChanges')} />
        <Checkbox checked={sortKeys} onChange={setSortKeys} label={t('network.compare.sortKeys')} />
        {notice ? <span className="net-cmp__notice">{notice}</span> : null}
      </div>
      {la.kind === 'none' && lb.kind === 'none' ? (
        <EmptyState size="sm" title={which === 'request' ? t('network.compare.noRequestBodies') : t('network.compare.noResponseBodies')} />
      ) : (
        <DiffView a={la.lines} b={lb.lines} onlyChanges={onlyChanges} />
      )}
    </div>
  );
}

const DIFF_ROW_H = 20;

function DiffView({ a, b, onlyChanges }: { a: string[]; b: string[]; onlyChanges: boolean }) {
  const t = useT();
  const result = useMemo(() => diffLines(a, b), [a, b]);
  const rows = useMemo(() => sideBySide(result.ops), [result]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const display: DisplayRow[] = useMemo(() => (onlyChanges ? collapseUnchanged(rows, 3, expanded) : rows.map((row) => ({ kind: 'row' as const, row }))), [rows, onlyChanges, expanded]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: display.length, getScrollElement: () => scrollRef.current, estimateSize: () => DIFF_ROW_H, overscan: 20 });
  const same = result.added === 0 && result.removed === 0;
  return (
    <div className="net-col">
      <div className="net-cmp__stats">
        {same ? (
          <span className="net-cmp__same">{t('network.compare.identical')}</span>
        ) : (
          <>
            <span className="net-cmp__plus tnum">+{result.added}</span>
            <span className="net-cmp__minus tnum">−{result.removed}</span>
            <span className="net-dim">{t('network.compare.linesChanged')}</span>
          </>
        )}
        {result.approximate ? <span className="net-cmp__notice">{t('network.compare.approximate')}</span> : null}
        {result.truncated ? <span className="net-cmp__notice">{t('network.compare.tooLong')}</span> : null}
      </div>
      <div ref={scrollRef} className="net-diff mono" role="table" aria-label={t('network.compare.diffLabel')}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((it) => {
            const d = display[it.index]!;
            const style = { transform: `translateY(${it.start}px)`, height: DIFF_ROW_H };
            if (d.kind === 'skip') {
              return (
                <div key={it.key} className="net-diff__row net-diff__skip" style={style} role="row">
                  <button type="button" className="net-diff__skipbtn" onClick={() => setExpanded((s) => new Set(s).add(d.from))}>
                    {t('network.compare.showHidden', { count: d.count })}
                  </button>
                </div>
              );
            }
            const { left, right } = d.row;
            return (
              <div key={it.key} className="net-diff__row" style={style} role="row">
                <span className="net-diff__ln" role="cell">
                  {left?.n ?? ''}
                </span>
                <span className={clsx('net-diff__text', left && `is-${left.type}`, !left && 'is-blank')} role="cell">
                  {left?.text ?? ''}
                </span>
                <span className="net-diff__ln" role="cell">
                  {right?.n ?? ''}
                </span>
                <span className={clsx('net-diff__text', right && `is-${right.type}`, !right && 'is-blank')} role="cell">
                  {right?.text ?? ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
