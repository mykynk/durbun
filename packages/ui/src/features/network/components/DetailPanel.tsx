import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  ArrowLeftRight,
  Bug,
  ChevronDown,
  Copy,
  Drama,
  Ellipsis,
  FileDown,
  Link2,
  PencilLine,
  RotateCw,
  ScrollText,
  Search,
  Share2,
  X,
  Workflow,
} from 'lucide-react';
import type { NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { ui, useApp, useDevice, useMocks } from '../../../data';
import {
  Button,
  Callout,
  CopyButton,
  DropdownMenu,
  IconButton,
  KeyValueTable,
  MethodBadge,
  SegmentedControl,
  Tabs,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  usePersistentState,
  type KeyValueRow,
  type MenuItem,
} from '../../../components';
import { useT } from '../../../i18n';
import { queryParams, reasonPhrase, requestCookies, responseCookies, type SetCookie } from '../model/http';
import { COPY_FORMATS, type CopyFormat } from '../model/copyAs';
import { shortErrorKey, splitError, tooLargeMessage } from '../model/errors';
import { timingBreakdown, type Phase } from '../model/waterfall';
import { FORMAT_LABEL, actionBlockHint, canRun, copyEntryAs, copyUrl, createMockFrom, downloadBody, exportHarFor, harFileName, harLabel, showInLogs } from '../actions';
import { StreamMessagesTab } from './StreamMessages';
import { ConnectionNote } from './ConnectionNote';
import { connectionKind } from '../../../data/explain';
import { StreamStateLabel } from './StreamBadge';
import { useNetworkDetail } from '../detailCache';
import { BodyViewer } from './BodyViewer';
import { ruleLabel } from '../../mocks/model/rules';
import { findMatchPlace, type MatchPlace } from '../model/findMatch';
import { useFindHighlight } from '../useFindHighlight';
import { JwtNotes } from './JwtView';

export type DetailTab = 'messages' | 'general' | 'request' | 'response' | 'timing';
const DETAIL_TABS: readonly DetailTab[] = ['general', 'request', 'response', 'timing'];
/** A stream entry (WebSocket, SSE) opens on its messages; the user's choice for stream entries is kept apart. */
const STREAM_TABS: readonly DetailTab[] = ['messages', 'general', 'request', 'response', 'timing'];

export interface DetailPanelProps {
  entry: NetworkEntry;
  /** The request was removed from the store (cleared / trimmed): read-only last known state. */
  gone: boolean;
  onClose: () => void;
  onReplay: () => void;
  onEditReplay: () => void;
  onCompare: () => void;
  onShare: () => void;
  /** "Report a bug" anchored to this request. */
  onReport?: () => void;
  /** "New flow" from this request (the view passes the list it shows). */
  onCreateFlow?: () => void;
  /** The body search's text: the panel opens where it occurs and marks it. */
  find?: string;
}

export function DetailPanel({ entry, gone, onClose, onReplay, onEditReplay, onCompare, onShare, onReport, onCreateFlow, find }: DetailPanelProps) {
  const t = useT();
  const isStream = !!entry.stream;
  const [savedHttpTab, setSavedHttpTab] = usePersistentState<DetailTab>('network.detailTab', 'response');
  const [savedStreamTab, setSavedStreamTab] = usePersistentState<DetailTab>('network.detailTab.stream', 'messages');
  const savedTab = isStream ? savedStreamTab : savedHttpTab;
  const setSavedTab = isStream ? setSavedStreamTab : setSavedHttpTab;
  const tabs = isStream ? STREAM_TABS : DETAIL_TABS;
  const { detail, loading, error, reload } = useNetworkDetail(gone ? null : entry);
  // Body search: open the tab / section holding the match once (the saved tab stays the user's choice), mark it.
  const [findOn, setFindOn] = useState(true);
  const needle = find?.trim() && findOn ? find.trim() : '';
  const place = useMemo<MatchPlace | null>(() => (needle ? findMatchPlace(entry, detail, needle) : null), [needle, entry, detail]);
  const [jump, setJump] = useState<MatchPlace | null>(null);
  const jumped = useRef(false);
  useEffect(() => {
    if (!place || jumped.current) return;
    // Wait for the bodies: a header match must not win over the body match the search was about.
    if (!detail && (entry.hasRequestBody || entry.hasResponseBody) && loading) return;
    jumped.current = true;
    setJump(place);
  }, [place, detail, loading, entry.hasRequestBody, entry.hasResponseBody]);
  // A stream's match of the body search is mostly in its messages: those open with the search (not a header).
  const tab: DetailTab = jump && !isStream ? jump.tab : tabs.includes(savedTab) ? savedTab : isStream ? 'messages' : 'response';
  const setTab = (next: DetailTab) => {
    setJump(null);
    setSavedTab(next);
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  useFindHighlight(bodyRef, needle || undefined, [tab, detail, jump]);

  const copyItems: MenuItem[] = [
    { label: t('network.menu.copyUrl'), icon: Link2, onSelect: () => void copyUrl(entry) },
    { type: 'separator' },
    ...COPY_FORMATS.map((f): MenuItem => ({ label: t(`network.menu.copyAs.${f}`), onSelect: () => void copyEntryAs(entry, f) })),
  ];
  const moreItems: MenuItem[] = [
    { label: t('network.menu.showInLogs'), icon: ScrollText, onSelect: () => showInLogs(entry) },
    { label: t('network.menu.compare'), icon: ArrowLeftRight, disabled: !canRun(entry, 'compare'), hint: actionBlockHint(entry, 'compare'), onSelect: onCompare },
    { label: t('network.menu.createFlow'), icon: Workflow, disabled: gone || !canRun(entry, 'flow'), hint: actionBlockHint(entry, 'flow'), onSelect: () => (onCreateFlow ? onCreateFlow() : ui.newFlowFromRequests([entry.id], { from: 'network' })) },
    { type: 'separator' },
    { label: t('network.menu.har'), icon: FileDown, disabled: gone, onSelect: () => exportHarFor([entry.id], harLabel(entry), harFileName(entry)) },
    { label: t('network.menu.downloadResponse'), icon: FileDown, disabled: gone || !entry.hasResponseBody, onSelect: () => downloadBody(entry, 'response') },
    { label: t('network.menu.downloadRequest'), icon: FileDown, disabled: gone || !entry.hasRequestBody, onSelect: () => downloadBody(entry, 'request') },
  ];

  const reqHeaders = entry.requestHeaders.length;
  const resHeaders = entry.responseHeaders?.length ?? 0;

  return (
    <section className="net-detail" aria-label={t('network.detail.label')}>
      <DetailHeader
        entry={entry}
        onClose={onClose}
        tools={
          <>
            {onReport && !gone ? <IconButton icon={Bug} size="sm" label={t('report.open')} onClick={onReport} /> : null}
            <Button size="sm" variant="ghost" icon={Share2} onClick={onShare} title={t('network.share.title')} aria-label={t('network.share.button')} className="net-detail__tool">
              {t('network.share.button')}
            </Button>
            <DropdownMenu items={copyItems} aria-label={t('network.menu.copyMenu')}>
              {(p) => (
                <Button size="sm" variant="ghost" icon={Copy} iconRight={ChevronDown} aria-label={t('network.menu.copy')} title={t('network.menu.copy')} className="net-detail__tool" {...p}>
                  {t('network.menu.copy')}
                </Button>
              )}
            </DropdownMenu>
            <DropdownMenu items={moreItems} aria-label={t('network.menu.more')}>
              {(p) => <IconButton icon={Ellipsis} size="sm" label={t('network.menu.more')} {...p} />}
            </DropdownMenu>
          </>
        }
      />
      {connectionKind(entry) ? (
        // A long-lived connection: the request actions do not apply, said once instead of three dead buttons.
        <ConnectionNote entry={entry} />
      ) : (
        <div className="net-detail__actions">
          <Button size="sm" icon={RotateCw} onClick={onReplay} disabled={gone || !canRun(entry, 'replay')} title={t('network.detail.replayHint')}>
            {t('network.menu.replay')}
          </Button>
          <Button size="sm" variant="ghost" icon={PencilLine} onClick={onEditReplay} disabled={gone || !canRun(entry, 'editReplay')} aria-label={t('network.menu.editReplay')} title={t('network.menu.editReplay')} className="net-detail__collapsible">
            {t('network.menu.editReplay')}
          </Button>
          <Button size="sm" variant="ghost" icon={Drama} onClick={() => void createMockFrom(entry)} disabled={gone} aria-label={t('network.menu.createMock')} title={t('network.menu.createMock')} className="net-detail__collapsible">
            {t('network.menu.createMock')}
          </Button>
        </div>
      )}
      {gone ? (
        <div className="net-pad net-pad--b0">
          <Callout tone="warn" compact>
            {t('network.detail.gone')}
          </Callout>
        </div>
      ) : null}
      {needle && !isStream ? (
        <div className="net-findnote" role="status">
          <Search size={13} aria-hidden />
          <span className="truncate">
            <span className="mono net-findnote__q">«{needle}»</span> {place ? t(`network.find.in.${place.tab}.${place.section}`) : t('network.find.notShown')}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setFindOn(false)}>
            {t('network.find.off')}
          </Button>
        </div>
      ) : null}
      <Tabs<DetailTab>
        value={tab}
        onChange={setTab}
        idPrefix="net-detail"
        className="net-detail__tabs"
        aria-label={t('network.detail.tabsLabel')}
        items={[
          ...(isStream ? [{ value: 'messages' as const, label: t('network.detail.tabs.messages'), badge: <span className="tab__count tnum">{formatNumber(entry.stream!.count)}</span> }] : []),
          { value: 'general', label: t('network.detail.tabs.general') },
          { value: 'request', label: t('network.detail.tabs.request'), badge: reqHeaders ? <span className="tab__count tnum">{reqHeaders}</span> : null },
          { value: 'response', label: t('network.detail.tabs.response'), badge: resHeaders ? <span className="tab__count tnum">{resHeaders}</span> : null },
          { value: 'timing', label: t('network.detail.tabs.timing') },
        ]}
      />
      <div ref={bodyRef} className="net-detail__body" role="tabpanel" id={`net-detail-panel-${tab}`} aria-labelledby={`net-detail-tab-${tab}`}>
        {tab === 'messages' && entry.stream ? <StreamMessagesTab entry={entry} gone={gone} find={find?.trim() || undefined} /> : null}
        {tab === 'general' ? <GeneralTab entry={entry} /> : null}
        {tab === 'request' ? (
          <MessageTab entry={entry} which="request" detail={detail} loading={loading} error={error} onRetry={reload} find={needle} forced={jump?.tab === 'request' ? jump.section : undefined} onPicked={() => setJump(null)} />
        ) : null}
        {tab === 'response' ? (
          <MessageTab entry={entry} which="response" detail={detail} loading={loading} error={error} onRetry={reload} find={needle} forced={jump?.tab === 'response' ? jump.section : undefined} onPicked={() => setJump(null)} />
        ) : null}
        {tab === 'timing' ? <TimingTab entry={entry} /> : null}
      </div>
    </section>
  );
}

/* ───────────── Header ───────────── */

function StatusLine({ entry }: { entry: NetworkEntry }) {
  const t = useT();
  if (entry.state === 'pending') return <span className="net-hstatus net-hstatus--pending">{t('network.status.pending')}</span>;
  if (entry.state === 'cancelled') return <span className="net-hstatus net-hstatus--cancel">{t('network.status.cancelled')}</span>;
  const code = entry.status;
  const cls = code === undefined ? 'fail' : code >= 500 ? '5xx' : code >= 400 ? '4xx' : code >= 300 ? '3xx' : '2xx';
  // One line, cut with "…" in a narrow panel; the full text on hover.
  const failText = entry.tooLarge ? t('network.tooLarge.short') : t(`network.errors.${shortErrorKey(entry.error)}`);
  const full = [code !== undefined ? `${code} ${entry.statusText || reasonPhrase(code) || ''}`.trim() : '', entry.state === 'failed' ? failText : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={clsx('net-hstatus', `net-hstatus--${cls}`)} title={full}>
      {code !== undefined ? (
        <>
          <span className="tnum">{code}</span> {entry.statusText || reasonPhrase(code) || ''}
        </>
      ) : null}
      {entry.state === 'failed' ? (
        <span className={clsx('net-hstatus__fail', entry.tooLarge && 'net-hstatus__fail--big')}>
          {code !== undefined ? ' · ' : ''}
          {failText}
        </span>
      ) : null}
    </span>
  );
}

function DetailHeader({ entry, onClose, tools }: { entry: NetworkEntry; onClose: () => void; tools: ReactNode }) {
  const t = useT();
  const app = useApp(entry.appId);
  const device = useDevice(entry.deviceId);
  const rule = useMocks((s) => (entry.mockRuleId ? s.rules.find((r) => r.id === entry.mockRuleId) : undefined));
  const deviceName = entry.deviceId === 'desktop' ? t('network.detail.desktop') : device?.name;
  const meta: ReactNode[] = [];
  // A stream's own time is its open time (Messages tab); the handshake's duration is in Timing.
  if (entry.duration !== undefined && !entry.stream) meta.push(<span key="d" className="tnum">{formatDuration(entry.duration)}</span>);
  if (entry.responseBodySize !== undefined) meta.push(<span key="s" className="tnum">{formatBytes(entry.responseBodySize)}</span>);
  if (app) meta.push(<span key="a">{[app.app.name, app.app.version].filter(Boolean).join(' ')}</span>);
  if (deviceName) meta.push(<span key="v">{deviceName}</span>);
  meta.push(
    <span key="src" className="mono">
      {entry.source}
    </span>,
  );
  return (
    <header className="net-detail__head">
      <div className="net-detail__title">
        <MethodBadge method={entry.method} className="net-detail__method" />
        <StatusLine entry={entry} />
        {entry.stream ? <StreamStateLabel stream={entry.stream} /> : null}
        <span className="grow" />
        {tools}
        <IconButton icon={X} size="sm" label={t('network.detail.close')} shortcut="Escape" onClick={onClose} />
      </div>
      <div className="net-detail__url">
        <span className="mono selectable net-detail__urltext" title={entry.url}>
          {entry.url || t('network.detail.noUrl')}
        </span>
        {entry.url ? <CopyButton size="xs" value={entry.url} label={t('network.menu.copyUrl')} /> : null}
      </div>
      <div className="net-detail__meta">
        {meta.map((m, i) => (
          <span key={i} className="net-detail__metaitem">
            {i > 0 ? <span className="net-dot">·</span> : null}
            {m}
          </span>
        ))}
        {entry.mocked ? (
          <button
            type="button"
            className="net-mocklink"
            onClick={() => (entry.mockRuleId ? ui.focusMock(entry.mockRuleId) : ui.setTab('mocks'))}
            title={t('network.detail.openRule')}
          >
            <Drama size={12} aria-hidden />
            {rule ? t('network.detail.mockedBy', { rule: ruleLabel(rule) }) : t('network.detail.mocked')}
          </button>
        ) : null}
      </div>
    </header>
  );
}

/* ───────────── Genel ───────────── */

function GeneralTab({ entry }: { entry: NetworkEntry }) {
  const t = useT();
  const app = useApp(entry.appId);
  const device = useDevice(entry.deviceId);
  const rule = useMocks((s) => (entry.mockRuleId ? s.rules.find((r) => r.id === entry.mockRuleId) : undefined));
  // A part too large for Dürbün is said in the UI language instead of the server's English error.
  const big = tooLargeMessage(entry, (n) => formatBytes(n));
  const err = useMemo(() => (entry.error && !entry.tooLarge ? splitError(entry.error) : null), [entry.error, entry.tooLarge]);
  const rows = useMemo(() => {
    const out: KeyValueRow[] = [];
    const push = (key: string, value: ReactNode, copyValue?: string) => out.push({ key, value, copyValue: copyValue ?? (typeof value === 'string' ? value : undefined) });
    push(t('network.general.url'), entry.url);
    push(t('network.general.method'), entry.method);
    const statusText =
      entry.state === 'pending'
        ? t('network.status.pending')
        : entry.status !== undefined
          ? `${entry.status} ${entry.statusText || reasonPhrase(entry.status) || ''}`.trim()
          : entry.state === 'cancelled'
            ? t('network.status.cancelled')
            : t('network.status.failed');
    push(t('network.general.status'), statusText);
    if (entry.protocol) push(t('network.general.protocol'), entry.protocol);
    if (entry.remoteAddress) push(t('network.general.remote'), entry.remoteAddress);
    push(t('network.general.source'), entry.source);
    if (entry.graphql) push(t('network.general.graphql'), `${entry.graphql.operationType ?? 'query'} ${entry.graphql.operationName ?? t('network.general.anonymous')}`);
    if (app) push(t('network.general.app'), `${app.app.name}${app.app.version ? ` ${app.app.version}` : ''} (${app.app.id})`, app.app.id);
    else if (entry.appId) push(t('network.general.app'), entry.appId);
    push(t('network.general.device'), entry.deviceId === 'desktop' ? t('network.detail.desktop') : (device?.name ?? entry.deviceId));
    const ms = String(Math.floor(entry.startTs) % 1000).padStart(3, '0');
    push(t('network.general.start'), `${formatDateTime(entry.startTs)}.${ms}`, new Date(entry.startTs).toISOString());
    if (entry.duration !== undefined) push(t('network.general.duration'), formatDuration(entry.duration));
    if (entry.requestBodySize !== undefined) push(t('network.general.requestSize'), formatBytes(entry.requestBodySize));
    if (entry.responseBodySize !== undefined) push(t('network.general.responseSize'), formatBytes(entry.responseBodySize));
    if (entry.requestContentType) push(t('network.general.requestType'), entry.requestContentType);
    if (entry.responseContentType) push(t('network.general.responseType'), entry.responseContentType);
    if (err) {
      if (err.type) push(t('network.general.errorType'), err.type);
      push(t('network.general.errorMessage'), err.message, entry.error);
    }
    if (entry.state === 'cancelled') push(t('network.general.cancelled'), t('network.general.yes'));
    if (entry.mocked) push(t('network.general.mockRule'), rule ? ruleLabel(rule) : (entry.mockRuleId ?? t('network.general.yes')));
    if (entry.bodyEvicted) push(t('network.general.bodies'), t('network.general.evicted'));
    push(t('network.general.id'), entry.id);
    return out;
  }, [entry, app, device, rule, err, t]);

  return (
    <div className="net-col net-scroll net-pad">
      {big ? (
        <Callout tone="warn" title={t('network.tooLarge.title')} className="net-mb">
          {t(`network.tooLarge.${big.key}`, big.params)}
        </Callout>
      ) : entry.state === 'failed' ? (
        <Callout tone="danger" title={t(`network.errors.${shortErrorKey(entry.error)}`)} className="net-mb">
          {entry.status !== undefined ? t('network.general.failedAfterHeaders') : null} {entry.error}
        </Callout>
      ) : null}
      {entry.bodyEvicted ? (
        <Callout tone="info" compact className="net-mb">
          {t('network.general.evictedHint')}
        </Callout>
      ) : null}
      <KeyValueTable rows={rows} filterable={false} copyAll keyWidth="minmax(120px, 30%)" aria-label={t('network.detail.tabs.general')} />
    </div>
  );
}

/* ───────────── İstek / Yanıt ───────────── */

type Section = 'body' | 'headers' | 'query' | 'cookies';

function MessageTab({
  entry,
  which,
  detail,
  loading,
  error,
  onRetry,
  find,
  forced,
  onPicked,
}: {
  entry: NetworkEntry;
  which: 'request' | 'response';
  detail: NetworkDetail | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Body search text to mark in the body. */
  find?: string;
  /** Section the body search's match is in (until the user picks one). */
  forced?: Section;
  onPicked?: () => void;
}) {
  const t = useT();
  const headers = which === 'request' ? entry.requestHeaders : (entry.responseHeaders ?? []);
  const params = useMemo(() => (which === 'request' ? queryParams(entry.url) : []), [which, entry.url]);
  const reqCookies = useMemo(() => (which === 'request' ? requestCookies(entry.requestHeaders) : []), [which, entry.requestHeaders]);
  const resCookies = useMemo(() => (which === 'response' ? responseCookies(entry.responseHeaders) : []), [which, entry.responseHeaders]);
  const cookieCount = which === 'request' ? reqCookies.length : resCookies.length;
  const hasBody = which === 'request' ? entry.hasRequestBody || (entry.requestBodySize ?? 0) > 0 : entry.state !== 'complete' || entry.hasResponseBody || (entry.responseBodySize ?? 0) > 0;
  const sections: Section[] = which === 'request' ? ['body', 'headers', 'query', 'cookies'] : ['body', 'headers', 'cookies'];
  const counts: Record<Section, number> = { body: hasBody ? 1 : 0, headers: headers.length, query: params.length, cookies: cookieCount };
  const [pref, setPref] = usePersistentState<Section>(`network.section.${which}`, 'body');
  // Prefer the user's last section, unless it is empty for this request (GET without body → headers).
  const section: Section =
    forced && sections.includes(forced) && (forced === 'body' || counts[forced] > 0)
      ? forced
      : sections.includes(pref) && counts[pref] > 0
        ? pref
        : (sections.find((s) => counts[s] > 0) ?? 'headers');
  const pickSection = (s: Section) => {
    onPicked?.();
    setPref(s);
  };

  const label = (s: Section) => {
    const base = t(`network.sections.${s}`);
    return s === 'body' ? base : (
      <>
        {base}
        <span className="net-seg-count tnum">{counts[s]}</span>
      </>
    );
  };

  return (
    <div className="net-col">
      <div className="net-subnav">
        <SegmentedControl<Section> size="sm" value={section} onChange={pickSection} options={sections.map((s) => ({ value: s, label: label(s), disabled: s !== 'body' && counts[s] === 0 }))} aria-label={t('network.sections.label')} />
      </div>
      {entry.tooLarge?.part === which ? (
        <div className="net-pad net-pad--b0">
          <Callout tone="warn" compact>
            {(() => {
              const m = tooLargeMessage(entry, (n) => formatBytes(n))!;
              return t(`network.tooLarge.${m.key}`, m.params);
            })()}
          </Callout>
        </div>
      ) : null}
      <div className="net-col net-subbody">
        {/* The body of a part too large for Dürbün never arrived: the note above says so, no "no body" state. */}
        {section === 'body' && entry.tooLarge?.part !== which ? <BodyViewer entry={entry} which={which} detail={detail} loading={loading} error={error} onRetry={onRetry} find={find} /> : null}
        {section === 'headers' ? (
          <div className="net-col net-scroll net-pad">
            <JwtNotes at={entry.startTs} values={headers.map(([k, v]) => ({ name: k, value: v }))} />
            <KeyValueTable
              rows={headers}
              filterable
              copyAll
              emptyText={which === 'response' && entry.state === 'pending' ? t('network.body.waiting') : t('network.sections.noHeaders')}
              aria-label={t('network.sections.headers')}
            />
          </div>
        ) : null}
        {section === 'query' ? (
          <div className="net-col net-scroll net-pad">
            <JwtNotes at={entry.startTs} values={params.map((p) => ({ name: p.name, value: p.value }))} />
            <KeyValueTable rows={params.map((p) => ({ key: p.name, value: p.value, copyValue: p.value }))} filterable={params.length > 8} copyAll emptyText={t('network.sections.noQuery')} aria-label={t('network.sections.query')} />
          </div>
        ) : null}
        {section === 'cookies' ? (
          <div className="net-col net-scroll net-pad">
            <JwtNotes at={entry.startTs} values={which === 'request' ? reqCookies.map((c) => ({ name: c.name, value: c.value })) : resCookies.map((c) => ({ name: c.name, value: c.value }))} />
            {which === 'request' ? (
              <KeyValueTable rows={reqCookies.map((c) => ({ key: c.name, value: c.value, copyValue: c.value }))} copyAll emptyText={t('network.sections.noCookies')} aria-label={t('network.sections.cookies')} />
            ) : (
              <SetCookieList cookies={resCookies} />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SetCookieList({ cookies }: { cookies: SetCookie[] }) {
  const t = useT();
  if (cookies.length === 0) return <div className="kv__empty">{t('network.sections.noCookies')}</div>;
  return (
    <ul className="net-cookies" aria-label={t('network.sections.cookies')}>
      {cookies.map((c, i) => {
        const attrs: [string, string | null][] = [];
        if (c.domain) attrs.push(['Domain', c.domain]);
        if (c.path) attrs.push(['Path', c.path]);
        if (c.expires) attrs.push(['Expires', c.expires]);
        if (c.maxAge) attrs.push(['Max-Age', c.maxAge]);
        if (c.sameSite) attrs.push(['SameSite', c.sameSite]);
        if (c.secure) attrs.push(['Secure', null]);
        if (c.httpOnly) attrs.push(['HttpOnly', null]);
        if (c.partitioned) attrs.push(['Partitioned', null]);
        for (const o of c.other) attrs.push([o.name, o.value || null]);
        return (
          <li key={i} className="net-cookie">
            <div className="net-cookie__main">
              <span className="mono net-cookie__name">{c.name}</span>
              <span className="mono net-cookie__value selectable">{c.value || '""'}</span>
              <CopyButton size="xs" value={c.value} label={t('network.sections.copyCookie')} />
            </div>
            {attrs.length > 0 ? (
              <div className="net-cookie__attrs">
                {attrs.map(([k, v]) => (
                  <span key={k} className="net-attr mono">
                    {k}
                    {v !== null ? <span className="net-attr__v">={v}</span> : null}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────── Zamanlama ───────────── */

const PHASE_ORDER: readonly Phase[] = ['queue', 'dns', 'connect', 'tls', 'send', 'wait', 'receive'];

function TimingTab({ entry }: { entry: NetworkEntry }) {
  const t = useT();
  const b = timingBreakdown(entry);
  const total = b.total;
  const androidCoarse = entry.source === 'okhttp' && b.spans.some((s) => s.phase === 'connect');
  return (
    <div className="net-col net-scroll net-pad">
      <div className="net-timing__total">
        <span className="net-dim">{t('network.timing.total')}</span>
        <span className="tnum net-timing__totalv">{total !== undefined ? formatDuration(total) : t('network.status.pending')}</span>
        {entry.endTs !== undefined ? (
          <span className="net-dim tnum">
            {formatDateTime(entry.startTs)} → +{formatDuration(entry.endTs - entry.startTs)}
          </span>
        ) : null}
      </div>
      {b.known && total !== undefined && total > 0 ? (
        <div className="net-timing" role="table" aria-label={t('network.detail.tabs.timing')}>
          {PHASE_ORDER.map((p) => {
            const span = b.spans.find((s) => s.phase === p);
            if (!span) return null;
            return (
              <div key={p} className="net-timing__row" role="row">
                <span className="net-timing__label" role="rowheader" title={t(`network.timing.hint.${p}`)}>
                  <span className={clsx('net-timing__swatch', `net-phase--${p}`)} aria-hidden />
                  {t(`network.timing.phase.${p}`)}
                </span>
                <span className="net-timing__track" role="cell">
                  <span className={clsx('net-timing__bar', `net-phase--${p}`)} style={{ left: `${(span.start / total) * 100}%`, width: `${Math.max(0.6, (span.ms / total) * 100)}%` }} />
                </span>
                <span className="net-timing__ms tnum" role="cell">
                  {formatDuration(span.ms)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {!b.known ? (
        <Callout tone="info" className="net-mt" title={t('network.timing.noPhases')}>
          {entry.state === 'pending' ? t('network.timing.pendingHint') : t('network.timing.noPhasesHint', { source: entry.source })}
        </Callout>
      ) : null}
      {b.known && androidCoarse ? (
        <Callout tone="info" compact className="net-mt">
          {t('network.timing.androidCoarse')}
        </Callout>
      ) : null}
      {b.known && b.spans.some((s) => s.phase === 'queue') ? <p className="net-dim net-mt net-small">{t('network.timing.queueHint')}</p> : null}
      {entry.source === 'replay' ? <p className="net-dim net-mt net-small">{t('network.timing.replayHint')}</p> : null}
    </div>
  );
}
