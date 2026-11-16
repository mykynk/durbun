import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowDownLeft, ArrowUpRight, Archive, ChevronRight, CloudOff, FilterX, Hourglass, Inbox, Info, Radio, RotateCw, Settings2 } from 'lucide-react';
import { STREAM_HEAD_KEPT, type NetworkEntry, type StreamInfo, type StreamMessage } from '@durbun/protocol';
import { streamMessages, ui, useApp, useServerSettings, useStreamMessages } from '../../../data';
import { streamCaptureState, type StreamCaptureState } from '../../../data/explain';
import {
  Button,
  Callout,
  CopyButton,
  EmptyState,
  Highlight,
  JsonTree,
  SearchInput,
  SegmentedControl,
  Spinner,
  Tooltip,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatOffset,
  useFeatureActive,
  usePersistentState,
} from '../../../components';
import { errorText, t, useT } from '../../../i18n';
import {
  DEFAULT_MESSAGE_FILTER,
  STREAM_APP_GONE,
  buildMessageRows,
  closeCodeKey,
  heldBytes,
  isControl,
  isLiveStream,
  jsonOf,
  messageHex,
  messageJson,
  messagePreview,
  messageText,
  messageTypeLabel,
  payloadForCopy,
  streamAge,
  streamOpenTs,
  type DirFilter,
  type MessageFilter,
  type MessageRow,
} from '../model/streams';
import { StreamStateIcon } from './StreamBadge';

const ROW_H = 26;
const GAP_H = 30;
const HEX_LIMIT = 4096;

/**
 * The Messages tab of a stream entry (WebSocket messages, SSE events). `find`: the list's body search text, which
 * starts the message search (the server matched it in a message).
 */
export function StreamMessagesTab({ entry, gone, find }: { entry: NetworkEntry; gone: boolean; find?: string }) {
  const t = useT();
  const active = useFeatureActive();
  const state = useStreamMessages(gone ? null : entry.id, { enabled: active });
  const stream: StreamInfo = entry.stream ?? state.stream!;
  const session = useApp(entry.appId);
  const captureStreams = useServerSettings((s) => s.settings.captureStreams);
  const captureBodies = useServerSettings((s) => s.settings.captureBodies);
  const capture = streamCaptureState({ deviceId: entry.deviceId, session, captureStreams });

  const [saved, setSaved] = usePersistentState<Pick<MessageFilter, 'dir' | 'hideControl'>>('network.streamFilter', { dir: 'all', hideControl: true });
  const [text, setText] = useState(find ?? '');
  const filter = useMemo<MessageFilter>(
    () => ({
      dir: stream.kind === 'sse' ? 'all' : saved.dir === 'in' || saved.dir === 'out' ? saved.dir : 'all',
      hideControl: saved.hideControl !== false,
      text,
    }),
    [saved.dir, saved.hideControl, text, stream.kind],
  );
  const built = useMemo(() => buildMessageRows(state.messages, filter), [state.messages, filter]);
  const resetFilter = () => {
    setText('');
    setSaved({ ...DEFAULT_MESSAGE_FILTER, hideControl: filter.hideControl });
  };

  const held = state.messages.length;
  const controlHeld = useMemo(() => state.messages.reduce((n, m) => n + (isControl(m) ? 1 : 0), 0), [state.messages]);

  let body: ReactNode;
  if (held === 0) body = <NoMessages entry={entry} stream={stream} capture={capture} status={state.status} error={state.error} gone={gone} />;
  else if (built.shown === 0) {
    const onlyControl = filter.hideControl && built.hiddenControl > 0 && built.filteredOut === 0;
    body = onlyControl ? (
      <EmptyState
        size="sm"
        icon={Radio}
        title={t('network.streams.empty.onlyControlTitle')}
        description={t('network.streams.control.hidden', { count: built.hiddenControl })}
        actions={
          <Button size="sm" onClick={() => setSaved({ ...saved, hideControl: false })}>
            {t('network.streams.empty.showControl')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        size="sm"
        icon={FilterX}
        title={t('network.streams.empty.noMatchTitle')}
        actions={
          <Button size="sm" onClick={resetFilter}>
            {t('network.streams.empty.resetFilter')}
          </Button>
        }
      />
    );
  } else body = <MessageList key={entry.id} rows={built.rows} entry={entry} stream={stream} search={filter.text} bodiesOff={captureBodies === false} live={stream.state === 'open' && !gone && capture !== 'imported'} />;

  return (
    <div className={clsx('net-col net-msgs', stream.kind === 'sse' && 'net-msgs--sse')}>
      <StreamSummary entry={entry} stream={stream} />
      <StreamNotes stream={stream} capture={capture} held={held} gone={gone} bodiesOff={captureBodies === false} />
      {held > 0 ? (
        <div className="net-msgs__tools" role="toolbar" aria-label={t('network.streams.toolbar')}>
          {stream.kind === 'websocket' ? (
            <SegmentedControl<DirFilter>
              size="sm"
              value={filter.dir}
              onChange={(dir) => setSaved({ ...saved, dir })}
              aria-label={t('network.streams.dir.label')}
              options={(['all', 'in', 'out'] as const).map((d) => ({ value: d, label: t(`network.streams.dir.${d}`) }))}
            />
          ) : null}
          {controlHeld > 0 ? (
            <button
              type="button"
              className={clsx('net-fchip net-msgs__ctl', !filter.hideControl && 'is-on')}
              aria-pressed={!filter.hideControl}
              title={filter.hideControl ? t('network.streams.control.show') : t('network.streams.control.hide')}
              onClick={() => setSaved({ ...saved, hideControl: !filter.hideControl })}
            >
              {filter.hideControl ? t('network.streams.control.hidden', { count: built.hiddenControl }) : t('network.streams.control.label')}
            </button>
          ) : null}
          <SearchInput
            size="sm"
            className="net-msgs__search"
            value={text}
            onChange={setText}
            placeholder={t('network.streams.search.placeholder')}
            aria-label={t('network.streams.search.label')}
            trailing={
              filter.text.trim() ? (
                <span className="net-msgs__matches tnum" role="status">
                  {t('network.streams.search.matches', { count: built.matches })}
                </span>
              ) : null
            }
          />
        </div>
      ) : null}
      <div className="net-col net-msgs__body">{body}</div>
      {state.refreshing && held > 0 ? <span className="sr-only">{t('network.streams.empty.loading')}</span> : null}
    </div>
  );
}

/* ───────────── Summary ───────────── */

/** Ticks once a second while `on`. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export function closedByText(stream: StreamInfo): string {
  if (stream.kind === 'sse') return stream.closedBy === 'out' ? t('network.streams.closedBy.sseCancel') : t('network.streams.closedBy.sseEnd');
  if (stream.closedBy === 'in') return t('network.streams.closedBy.in');
  if (stream.closedBy === 'out') return t('network.streams.closedBy.out');
  return t('network.streams.closedBy.none');
}

/** "1001 · going away (…)" for a close code, or the bare number for an unknown one. */
export function closeCodeText(code: number | undefined): string | null {
  if (code === undefined) return null;
  const key = closeCodeKey(code);
  return key ? t('network.streams.closeCode', { code, name: t(`network.streams.closeNames.${key}`) }) : String(code);
}

/** The failure text: the server's "app went away" in the UI language, anything else as the SDK reported it. */
export function failureText(error: string | undefined): string | null {
  if (!error) return null;
  return error === STREAM_APP_GONE ? t('network.streams.appGone') : error;
}

function StreamSummary({ entry, stream }: { entry: NetworkEntry; stream: StreamInfo }) {
  const t = useT();
  const open = isLiveStream(entry);
  const now = useTick(open);
  const age = streamAge(entry, now) ?? 0;
  const ageKey = open ? 'openSince' : stream.state === 'open' ? 'openWhenSaved' : 'openFor';
  const code = closeCodeText(stream.closeCode);
  const failure = stream.state === 'failed' ? failureText(stream.error) : null;
  return (
    <div className="net-msgs__summary">
      {/* Age and counts share a line (wrapping when narrow): the list below keeps the room. */}
      <div className="net-msgs__top">
        <div className={clsx('net-msgs__line net-msgs__age', `net-msgs__age--${stream.state}`)}>
          <StreamStateIcon state={stream.state} size={13} />
          <span className="tnum" title={formatDateTime(streamOpenTs(entry))}>
            {t(`network.streams.${ageKey}`, { time: formatDuration(age) })}
          </span>
        </div>
        {stream.count === 0 ? null : <div className="net-msgs__counts" aria-label={t('network.streams.counts.label')}>
          {stream.kind === 'sse' ? (
            <span className="net-msgs__count">
              <ArrowDownLeft size={12} aria-hidden className="net-msg__dir--in" />
              {t('network.streams.counts.events', { count: stream.in })}
              <span className="net-dim tnum">· {formatBytes(stream.bytesIn)}</span>
            </span>
          ) : (
            <>
              <span className="net-msgs__count">
                <ArrowDownLeft size={12} aria-hidden className="net-msg__dir--in" />
                {t('network.streams.counts.received', { count: stream.in })}
                <span className="net-dim tnum">· {formatBytes(stream.bytesIn)}</span>
              </span>
              <span className="net-msgs__count">
                <ArrowUpRight size={12} aria-hidden className="net-msg__dir--out" />
                {t('network.streams.counts.sent', { count: stream.out })}
                <span className="net-dim tnum">· {formatBytes(stream.bytesOut)}</span>
              </span>
              {stream.control > 0 ? <span className="net-msgs__count net-dim">{t('network.streams.counts.control', { count: stream.control })}</span> : null}
            </>
          )}
          {stream.dropped > 0 ? <DroppedCount count={stream.dropped} /> : null}
        </div>}
      </div>
      {stream.state === 'closed' ? (
        <div className="net-msgs__line net-msgs__close">
          <span>{closedByText(stream)}</span>
          {code ? <span className="mono net-msgs__code">{code}</span> : null}
          {stream.closeReason ? <span className="mono selectable">“{stream.closeReason}”</span> : null}
        </div>
      ) : null}
      {failure ? (
        <Callout tone="danger" compact title={t('network.streams.failedTitle')}>
          <span className="selectable">{failure}</span>
          {code ? <span className="mono"> · {code}</span> : null}
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * How many messages the limits removed, quiet, with the counts; the sentence and the why in a tooltip (the gap rows
 * say it in place too).
 */
function DroppedCount({ count }: { count: number }) {
  const t = useT();
  const full = `${t('network.streams.dropped', { count })}. ${t('network.streams.droppedHint', { head: STREAM_HEAD_KEPT })}`;
  return (
    <span className="net-msgs__count net-msgs__dropped">
      <Archive size={12} aria-hidden />
      <span aria-hidden>{t('network.streams.droppedShort', { count })}</span>
      <Tooltip content={full}>
        <button type="button" className="net-msgs__info" aria-label={full}>
          <Info size={12} aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}

function StreamNotes({ stream, capture, held, gone, bodiesOff }: { stream: StreamInfo; capture: StreamCaptureState; held: number; gone: boolean; bodiesOff: boolean }) {
  const t = useT();
  const notes: ReactNode[] = [];
  if (held > 0 && capture === 'imported') notes.push(<Note key="imported">{t('network.streams.notes.imported')}</Note>);
  if (held > 0 && gone) notes.push(<Note key="gone">{t('network.streams.notes.gone')}</Note>);
  if (held > 0 && capture === 'captureOff' && stream.state === 'open') notes.push(<Note key="off" settings>{t('network.streams.notes.captureOffNow')}</Note>);
  if (capture === 'ok' && bodiesOff && stream.state === 'open') notes.push(<Note key="bodies" settings>{t('network.streams.notes.bodiesOff')}</Note>);
  if (notes.length === 0) return null;
  return <div className="net-msgs__notes">{notes}</div>;
}

function Note({ children, settings }: { children: string; settings?: boolean }) {
  const t = useT();
  return (
    <div className="net-msgs__note" role="note">
      <span title={children}>{children}</span>
      {settings ? (
        <button type="button" className="net-msgs__link" onClick={() => ui.openSettings('network')}>
          <Settings2 size={12} aria-hidden />
          {t('network.streams.notes.settings')}
        </button>
      ) : null}
    </div>
  );
}

/* ───────────── Empty and edge states ───────────── */

function NoMessages({ entry, stream, capture, status, error, gone }: { entry: NetworkEntry; stream: StreamInfo; capture: StreamCaptureState; status: string; error: unknown; gone: boolean }) {
  const t = useT();
  // An imported recording holds what its file held. (No `noCapability` state here: since SPEC §6.1.1 the server opens
  // a stream only for an app that sends messages; a handshake from any other app is a plain entry, ConnectionNote.)
  if (capture === 'imported') {
    return <EmptyState size="sm" icon={Archive} title={t('network.streams.empty.importedNoneTitle')} description={t('network.streams.empty.importedNoneBody')} />;
  }
  if (gone) return <EmptyState size="sm" icon={Archive} title={t('network.streams.empty.goneTitle')} description={t('network.streams.notes.gone')} />;
  if (status === 'error') {
    return (
      <EmptyState
        size="sm"
        tone="danger"
        icon={CloudOff}
        title={t('network.streams.empty.errorTitle')}
        description={errorText(error)}
        actions={
          <Button size="sm" icon={RotateCw} onClick={() => void streamMessages.sync(entry.id)}>
            {t('network.streams.empty.retry')}
          </Button>
        }
      />
    );
  }
  if (status === 'loading' || (status === 'idle' && stream.count > 0)) {
    return (
      <div className="net-loading" role="status">
        <Spinner size={14} />
        {t('network.streams.empty.loading')}
      </div>
    );
  }
  if (stream.count > 0) {
    return <EmptyState size="sm" icon={Archive} title={t('network.streams.empty.allDroppedTitle')} description={t('network.streams.empty.allDroppedBody', { count: stream.count })} />;
  }
  if (capture === 'captureOff') {
    return (
      <EmptyState
        size="sm"
        icon={CloudOff}
        title={t('network.streams.empty.captureOffTitle')}
        description={t('network.streams.empty.captureOffBody')}
        actions={
          <Button size="sm" icon={Settings2} onClick={() => ui.openSettings('network')}>
            {t('network.streams.empty.openSettings')}
          </Button>
        }
      />
    );
  }
  if (stream.state === 'open') return <EmptyState size="sm" icon={Hourglass} title={t('network.streams.empty.openNoneTitle')} description={t('network.streams.empty.openNoneBody')} />;
  return <EmptyState size="sm" icon={Inbox} title={stream.state === 'failed' ? t('network.streams.empty.failedNoneTitle') : t('network.streams.empty.closedNoneTitle')} />;
}

/* ───────────── List ───────────── */

interface ListProps {
  rows: MessageRow[];
  entry: NetworkEntry;
  stream: StreamInfo;
  search: string;
  bodiesOff: boolean;
  /** The connection is open and live: follow the newest message. */
  live: boolean;
}

function MessageList({ rows, entry, stream, search, bodiesOff, live }: ListProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [follow, setFollow] = useState(true);
  /** Rows when following stopped (the pill counts what came after). */
  const leftAt = useRef(0);
  const messageCount = rows.length;
  const countRef = useRef(messageCount);
  countRef.current = messageCount;
  const openTs = streamOpenTs(entry);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r) return ROW_H;
      if (r.kind === 'gap') return GAP_H;
      return expanded.has(r.message.seq) ? 260 : ROW_H;
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 12,
  });

  const following = live && follow;
  // Follow the tail: after rows change, keep the newest in view.
  useLayoutEffect(() => {
    if (!following || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, following]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !live) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    if (atBottom !== follow) {
      if (!atBottom) leftAt.current = messageCount;
      setFollow(atBottom);
    }
  };

  const toggle = useCallback((seq: number) => {
    // Opening a message stops following, so the newest messages do not scroll it away.
    setFollow((f) => {
      if (f) leftAt.current = countRef.current;
      return false;
    });
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const backToLive = () => {
    setFollow(true);
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  };
  const fresh = Math.max(0, messageCount - leftAt.current);

  return (
    <div className="net-msgs__listwrap">
      <div ref={scrollRef} className="net-msgs__list" onScroll={onScroll} role="list" aria-label={t('network.streams.list')}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((it) => {
            const row = rows[it.index]!;
            return (
              <div key={it.key} data-index={it.index} ref={virtualizer.measureElement} className="net-msgs__item" style={{ transform: `translateY(${it.start}px)` }} role="listitem">
                {row.kind === 'gap' ? (
                  <GapRow count={row.count} head={row.head} />
                ) : (
                  <MessageItem message={row.message} openTs={openTs} search={search} expanded={expanded.has(row.message.seq)} onToggle={toggle} bodiesOff={bodiesOff} kind={stream.kind} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {live && !follow ? (
        <button type="button" className="net-newpill" onClick={backToLive} title={t('network.streams.follow.off')}>
          <ArrowDown size={13} aria-hidden />
          {fresh > 0 ? t('network.streams.follow.newMessages', { count: fresh }) : t('network.streams.follow.backToLive')}
        </button>
      ) : null}
    </div>
  );
}

function GapRow({ count, head }: { count: number; head: boolean }) {
  return (
    <div className="net-msgs__gap" role="note">
      <Archive size={12} aria-hidden />
      <span>{head ? t('network.streams.gapHead', { count, head: STREAM_HEAD_KEPT }) : t('network.streams.gap', { count })}</span>
    </div>
  );
}

interface ItemProps {
  message: StreamMessage;
  openTs: number;
  search: string;
  expanded: boolean;
  onToggle: (seq: number) => void;
  bodiesOff: boolean;
  kind: StreamInfo['kind'];
}

const MessageItem = memo(function MessageItem({ message: m, openTs, search, expanded, onToggle, bodiesOff, kind }: ItemProps) {
  const DirIcon = m.dir === 'out' ? ArrowUpRight : ArrowDownLeft;
  const preview = messagePreview(m);
  const typeLabel = messageTypeLabel(m);
  const dirName = t(`network.streams.dirName.${m.dir}`);
  return (
    <div className={clsx('net-msg', `net-msg--${m.dir}`, isControl(m) && 'net-msg--control', m.type === 'close' && 'net-msg--close', expanded && 'is-open')}>
      <button type="button" className="net-msg__head" aria-expanded={expanded} onClick={() => onToggle(m.seq)} title={expanded ? t('network.streams.collapse') : t('network.streams.expand')}>
        <ChevronRight size={12} aria-hidden className="net-msg__chev" />
        {kind === 'websocket' ? (
          <span className={clsx('net-msg__dir', `net-msg__dir--${m.dir}`)} title={t(`network.streams.dirTitle.${m.dir}`)}>
            <DirIcon size={13} aria-hidden />
            <span className="sr-only">{dirName}</span>
          </span>
        ) : null}
        <span className="net-msg__time tnum mono" title={`${t('network.streams.sinceOpen')} · ${absoluteTime(m.ts)}`}>
          {formatOffset(m.ts - openTs)}
        </span>
        <span className={clsx('net-msg__type mono', `net-msg__type--${m.type}`)} title={t(`network.streams.typeTitle.${m.type}`)}>
          {typeLabel}
        </span>
        <span className="net-msg__preview mono">{search ? <Highlight text={preview} query={search} /> : preview}</span>
        <span className="net-msg__size tnum">{m.size > 0 ? formatBytes(m.size) : ''}</span>
      </button>
      {expanded ? <MessageDetail message={m} openTs={openTs} bodiesOff={bodiesOff} kind={kind} /> : null}
    </div>
  );
});

function absoluteTime(ts: number): string {
  return `${formatDateTime(ts)}.${String(Math.floor(ts) % 1000).padStart(3, '0')}`;
}

function MessageDetail({ message: m, openTs, bodiesOff, kind }: { message: StreamMessage; openTs: number; bodiesOff: boolean; kind: StreamInfo['kind'] }) {
  const t = useT();
  const fields: [string, ReactNode][] = [];
  fields.push([t('network.streams.fields.time'), absoluteTime(m.ts)]);
  fields.push([t('network.streams.fields.sinceOpen'), formatOffset(m.ts - openTs)]);
  if (kind === 'websocket') fields.push([t('network.streams.fields.direction'), t(`network.streams.dirTitle.${m.dir}`)]);
  fields.push([t('network.streams.fields.size'), formatBytes(m.size)]);
  if (m.type === 'event') {
    fields.push([t('network.streams.fields.event'), m.event || 'message']);
    if (m.eventId !== undefined) fields.push([t('network.streams.fields.eventId'), m.eventId]);
    if (m.retry !== undefined) fields.push([t('network.streams.fields.retry'), formatDuration(m.retry)]);
  }
  if (m.type === 'close') {
    if (m.closeCode !== undefined) fields.push([t('network.streams.fields.closeCode'), closeCodeText(m.closeCode)]);
    if (m.closeReason) fields.push([t('network.streams.fields.closeReason'), `“${m.closeReason}”`]);
  }
  fields.push([t('network.streams.fields.seq'), `#${formatNumber(m.seq)}`]);
  const payload = payloadForCopy(m);
  return (
    <div className="net-msg__detail">
      <dl className="net-msg__fields">
        {fields.map(([k, v]) => (
          <div key={k} className="net-msg__field">
            <dt>{k}</dt>
            <dd className="selectable">{v}</dd>
          </div>
        ))}
      </dl>
      <Payload message={m} bodiesOff={bodiesOff} />
      <div className="net-msg__actions">
        {payload !== null ? <CopyButton size="sm" value={payload} text={m.body?.encoding === 'base64' ? t('network.streams.payload.copyBase64') : t('network.streams.payload.copy')} /> : null}
        <CopyButton size="sm" value={() => messageJson(m)} text={t('network.streams.payload.copyJson')} />
      </div>
    </div>
  );
}

function Payload({ message: m, bodiesOff }: { message: StreamMessage; bodiesOff: boolean }) {
  const t = useT();
  const text = messageText(m);
  const json = useMemo(() => (m.body?.truncated ? null : jsonOf(text)), [m, text]);
  if (!m.body) {
    if (m.type === 'close' || m.size === 0) return m.type === 'close' ? null : <p className="net-dim net-small">{t('network.streams.payload.none')}</p>;
    return <p className="net-dim net-small">{bodiesOff ? t('network.streams.payload.bodiesOff') : t('network.streams.payload.notCaptured')}</p>;
  }
  const cut = m.body.truncated ? (
    <Callout tone="warn" compact>
      {t('network.streams.payload.truncated', { held: formatBytes(heldBytes(m)), size: formatBytes(m.size) })}
      {text && /^\s*[[{]/.test(text) ? ` ${t('network.streams.payload.jsonCut')}` : ''}
    </Callout>
  ) : null;
  if (m.body.encoding === 'base64') {
    const hex = messageHex(m, HEX_LIMIT);
    const bytes = heldBytes(m);
    return (
      <div className="net-msg__payload">
        {cut}
        <p className="net-dim net-small">{t('network.streams.payload.binary', { size: formatBytes(m.size) })}</p>
        {hex ? <pre className="net-msg__pre net-msg__pre--hex mono selectable">{hex}</pre> : null}
        {bytes > HEX_LIMIT ? <p className="net-dim net-small">{t('network.streams.payload.hexCut', { shown: formatBytes(HEX_LIMIT) })}</p> : null}
      </div>
    );
  }
  return (
    <div className="net-msg__payload">
      {cut}
      {json ? (
        <div className="net-msg__json">
          <JsonTree data={json.value} defaultExpandDepth={2} rootLabel="message" aria-label={t('network.streams.list')} />
        </div>
      ) : (
        <pre className="net-msg__pre mono selectable">{text}</pre>
      )}
    </div>
  );
}
