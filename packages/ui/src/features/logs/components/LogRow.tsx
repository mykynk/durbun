import { Fragment, memo, type CSSProperties, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Binoculars,
  Bookmark,
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  Flame,
  Globe,
  History,
  Hourglass,
  Layers,
  OctagonX,
  Play,
  Plug,
  PlugZap,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Smartphone,
  Sparkles,
  Square,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import type { LogEntry, LogLevel, NetworkEntry } from '@durbun/protocol';
import { JsonTree, Spinner, formatBytes, formatClock, formatDuration, hashHue, methodClass, statusClass } from '../../../components';
import { t, type Lang } from '../../../i18n';
import { analyzeEntry, jsonPreview, type EntryAnalysis } from '../model/analyze';
import { frameDisplayText, parseStack, type AppIdentity, type StackLine } from '../model/frames';
import { highlightSegments, type Highlighter } from '../model/highlight';
import { flapSummary, flapTimeRange, systemText } from '../model/systemText';
import { isPreviousLaunch, type LogRow } from '../model/types';
import { crashWhen, crashedBuildOf, recordUnsymbolicated } from '../model/records';
import { entrySourceText, isDeviceCrashRecord } from '../../../sources/text';
import type { TimeFormat } from '../../../data';

/** Expansion bits per row. */
export const EXPAND_LINES = 1;
export const EXPAND_JSON = 2;
export const EXPAND_STACK = 4;

/** Row-independent rendering options (one object per settings change → rows re-render together). */
export interface RowDisplay {
  timeFormat: TimeFormat;
  wrap: boolean;
  lang: Lang;
  hl: Highlighter;
  /** Process names implied by the scope (app scope): no process chip for those. */
  impliedProcesses: ReadonlySet<string>;
  identity(e: LogEntry): AppIdentity;
  appName(e: LogEntry): string | undefined;
  /** Device marker per row — only while lines of several devices share the list ('all' scope). */
  device?: (e: LogEntry) => DeviceMark | undefined;
  /** The hub's display name of a device, in every scope (texts that name the device, e.g. a merged connection row). */
  deviceName?: (deviceId: string) => string | undefined;
}

/** Which device a row came from: its name (full in tooltips, short on the chip) and a stable hue (`--dev-h`). */
export interface DeviceMark {
  name: string;
  short?: string;
  hue: number;
}

export interface LogRowProps {
  row: LogRow;
  time: string;
  /** Live network entry for kind 'network' rows. */
  net?: NetworkEntry;
  selected: boolean;
  expanded: number;
  flash: boolean;
  d: RowDisplay;
}

const LETTER: Record<LogLevel, string> = { verbose: 'V', debug: 'D', info: 'I', warn: 'W', error: 'E', fatal: 'F' };
/** Characters of a single line rendered in a row (the detail panel shows everything). */
const MAX_LINE = 1500;
/** Lines rendered inside an expanded row. */
const MAX_EXPANDED_LINES = 400;

export function HlText({ text, hl, max = MAX_LINE }: { text: string; hl: Highlighter; max?: number }) {
  const s = text.length > max ? `${text.slice(0, max)}…` : text;
  if (hl.rules.length === 0) return <>{s}</>;
  const segs = highlightSegments(s, hl);
  if (segs.length === 1 && !segs[0]!.search && !segs[0]!.color) return <>{s}</>;
  return (
    <>
      {segs.map((g, i) =>
        g.search ? (
          <mark key={i} className="hl">
            {g.text}
          </mark>
        ) : g.color ? (
          <mark key={i} className={`lg-hl lg-hl--${g.color}`}>
            {g.text}
          </mark>
        ) : (
          <Fragment key={i}>{g.text}</Fragment>
        ),
      )}
    </>
  );
}

function SourceIcon({ e, d }: { e: LogEntry; d: RowDisplay }) {
  const Icon = e.source === 'device' ? Smartphone : e.source === 'app' ? Box : Binoculars;
  const dev = d.device?.(e);
  return (
    <span className="lg-src" title={dev ? `${dev.name} · ${entrySourceText(e)}` : entrySourceText(e)}>
      <Icon size={12} aria-hidden />
    </span>
  );
}

/** Compact device chip (several devices in one list): the name, tinted with the device's hue. */
function DeviceChip({ e, d, className }: { e: LogEntry; d: RowDisplay; className?: string }) {
  const dev = d.device?.(e);
  if (!dev) return null;
  return (
    <span className={clsx('lg-dev', className)} style={{ '--dev-h': dev.hue } as CSSProperties} title={dev.name}>
      <span className="lg-dev__name">{dev.short ?? dev.name}</span>
    </span>
  );
}

/** "EXC_BAD_ACCESS (SIGSEGV) · …" instead of "EXC_BAD_ACCESS: EXC_BAD_ACCESS (SIGSEGV) · …" (.ips summaries start with the type). */
export function errorHeadParts(err: Pick<NonNullable<LogEntry['error']>, 'type' | 'message'>): { type?: string; rest?: string } {
  const type = err.type?.trim() || undefined;
  const message = err.message?.trim() || undefined;
  if (type && message && message.startsWith(type)) return { type, rest: message.slice(type.length) };
  return { type, rest: message ? (type ? `: ${message}` : message) : undefined };
}

function LevelLetter({ level }: { level: LogLevel }) {
  return (
    <span className={`lg-lvl lg-lvl--${level}`} title={t(`common.levelHint.${level}`)}>
      {LETTER[level]}
    </span>
  );
}

/** "com.google.android.apps.nexuslauncher" → "nexuslauncher", "com.app:remote" → "app:remote", "/system/bin/vold" → "vold". */
export function shortProcess(name: string): string {
  const colon = name.indexOf(':');
  const base = colon >= 0 ? name.slice(0, colon) : name;
  const sub = colon >= 0 ? name.slice(colon) : '';
  const slash = base.lastIndexOf('/');
  const tail = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = tail.lastIndexOf('.');
  const short = dot >= 0 && dot < tail.length - 1 ? tail.slice(dot + 1) : tail;
  return `${short}${sub}`;
}

function Who({ e, d }: { e: LogEntry; d: RowDisplay }) {
  const tag = e.tag || '—';
  const showProc = e.source === 'device' && !!e.process && e.process !== e.tag && !d.impliedProcesses.has(e.process);
  return (
    <span className="lg-who">
      <button
        type="button"
        tabIndex={-1}
        className="tag-chip tag-chip--clickable lg-tag"
        style={{ '--h': hashHue(tag) } as CSSProperties}
        data-act="tag"
        data-v={e.tag}
        title={`${tag} · ${t('logs.row.filterTag')}`}
      >
        {tag}
      </button>
      {showProc ? (
        <button
          type="button"
          tabIndex={-1}
          className="lg-proc"
          style={{ '--h': hashHue(e.process!) } as CSSProperties}
          data-act="proc"
          data-v={e.process}
          title={`${e.process} · ${e.pid !== undefined ? t('logs.row.filterProcess', { pid: e.pid }) : t('logs.row.filterProcessNoPid')}`}
        >
          {shortProcess(e.process!)}
        </button>
      ) : null}
    </span>
  );
}

function Badges({ row, a, expanded }: { row: LogRow; a: EntryAnalysis; expanded: number }) {
  const parts: ReactNode[] = [];
  if (a.stack && a.frames > 0 && !a.crash) {
    const open = (expanded & EXPAND_STACK) !== 0;
    parts.push(
      <button key="st" type="button" tabIndex={-1} className={clsx('lg-badge lg-badge--stack', open && 'is-open')} data-act="stack" title={t('logs.row.expandStack')}>
        {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
        {t('logs.row.frames', { count: a.frames })}
      </button>,
    );
  } else if (a.extra > 0) {
    const open = (expanded & EXPAND_LINES) !== 0;
    parts.push(
      <button key="ln" type="button" tabIndex={-1} className={clsx('lg-badge', open && 'is-open')} data-act="lines" title={open ? t('logs.row.collapse') : t('logs.row.expandLines')}>
        {open ? t('logs.row.collapse') : t('logs.row.moreLines', { count: a.extra })}
      </button>,
    );
  }
  if (row.twin) {
    parts.push(
      <span key="tw" className="lg-twin" title={t('logs.row.twinTip')}>
        <Smartphone size={10} aria-hidden />
        <span className="lg-twin__text">{t('logs.row.twin')}</span>
      </span>,
    );
  }
  if (row.n > 1) {
    parts.push(
      <span key="rep" className="lg-repeat tnum" title={t('logs.row.repeatTip', { count: row.n, time: row.last ? formatClock(row.last.ts) : '' })}>
        ×{row.n}
      </span>,
    );
  }
  return parts.length ? <span className="lg-badges">{parts}</span> : null;
}

function JsonChip({ a, expanded }: { a: EntryAnalysis; expanded: number }) {
  if (!a.json) return null;
  const open = (expanded & EXPAND_JSON) !== 0;
  return (
    <button type="button" tabIndex={-1} className={clsx('lg-json-chip', open && 'is-open')} data-act="json" title={t('logs.row.expandJson')}>
      {jsonPreview(a.json.value, 80)}
    </button>
  );
}

/** Stack / multi-line block with the app's frames highlighted and framework frames dimmed. */
export function StackLines({ lines, hl, limit = MAX_EXPANDED_LINES }: { lines: readonly StackLine[]; hl: Highlighter; limit?: number }) {
  const shown = lines.length > limit ? lines.slice(0, limit) : lines;
  return (
    <div className="lg-lines">
      {shown.map((l, i) => (
        <div key={i} className={clsx('lg-line', l.type === 'frame' && `lg-frame lg-frame--${l.cls}`, l.type === 'cause' && 'lg-cause', l.type === 'meta' && 'lg-meta')}>
          <HlText text={l.type === 'frame' || l.type === 'meta' ? frameDisplayText(l.text) : l.text} hl={hl} max={4000} />
        </div>
      ))}
      {lines.length > limit ? <div className="lg-line lg-meta">… +{lines.length - limit}</div> : null}
    </div>
  );
}

function afterFirstLine(text: string): string {
  const i = text.indexOf('\n');
  return i < 0 ? '' : text.slice(i + 1);
}

function ExpandedBody({ e, a, expanded, d }: { e: LogEntry; a: EntryAnalysis; expanded: number; d: RowDisplay }) {
  const blocks: ReactNode[] = [];
  if (expanded & (EXPAND_LINES | EXPAND_STACK)) {
    const id = d.identity(e);
    let text: string;
    if (a.crash) text = a.lines > 1 ? e.message : '';
    else if (a.json && !a.json.fromData && !a.json.before.includes('\n')) text = a.json.after.replace(/^[ \t]*\r?\n/, '');
    else text = afterFirstLine(e.message);
    if (text.trim()) blocks.push(<StackLines key="msg" lines={parseStack(text, id).lines} hl={d.hl} />);
    const stack = e.error?.stack;
    if (stack && !e.message.includes(stack.split('\n', 1)[0]!)) {
      if (e.error?.message && !e.message.includes(e.error.message)) {
        blocks.push(
          <div key="eh" className="lg-line lg-cause">
            {(() => {
              const h = errorHeadParts(e.error);
              return `${h.type ?? ''}${h.rest ?? ''}`;
            })()}
          </div>,
        );
      }
      blocks.push(<StackLines key="st" lines={parseStack(stack, id).lines} hl={d.hl} />);
    }
  }
  if (expanded & EXPAND_JSON && a.json) {
    blocks.push(
      <div key="json" className="lg-json">
        <JsonTree data={a.json.value} rootLabel="data" defaultExpandDepth={2} />
      </div>,
    );
  }
  if (blocks.length === 0) return null;
  return <div className="lg-expand">{blocks}</div>;
}

/* ───────────── ordinary rows ───────────── */

function TextRow({ row, time, selected, expanded, flash, d }: LogRowProps) {
  const e = row.e;
  const a = analyzeEntry(e);
  return (
    <div
      className={clsx('lg-row', `lg-row--${e.level}`, selected && 'is-selected', flash && 'is-flash', d.wrap && 'is-wrap', expanded && 'is-expanded')}
      data-row={row.id}
    >
      <div className="lg-line1">
        <span className="lg-time tnum">{time}</span>
        <LevelLetter level={e.level} />
        <SourceIcon e={e} d={d} />
        <DeviceChip e={e} d={d} />
        <Who e={e} d={d} />
        <span className="lg-msg">
          {a.headline ? (
            <span className="lg-text">
              <HlText text={a.headline} hl={d.hl} />
            </span>
          ) : null}
          <JsonChip a={a} expanded={expanded} />
          <Badges row={row} a={a} expanded={expanded} />
        </span>
      </div>
      {expanded ? <ExpandedBody e={e} a={a} expanded={expanded} d={d} /> : null}
    </div>
  );
}

function EventRow({ row, time, selected, expanded, flash, d }: LogRowProps) {
  const e = row.e;
  const props = e.data;
  const hasProps = props !== null && typeof props === 'object' && Object.keys(props as object).length > 0;
  return (
    <div className={clsx('lg-row lg-row--event', selected && 'is-selected', flash && 'is-flash')} data-row={row.id}>
      <div className="lg-line1">
        <span className="lg-time tnum">{time}</span>
        <LevelLetter level={e.level} />
        <SourceIcon e={e} d={d} />
        <DeviceChip e={e} d={d} />
        <span className="lg-who">
          <span className="lg-event-tag">
            <Sparkles size={11} aria-hidden />
            {t('logs.kind.event')}
          </span>
        </span>
        <span className="lg-msg">
          <span className="lg-text lg-event-name">
            <HlText text={e.message} hl={d.hl} />
          </span>
          {hasProps ? (
            <button type="button" tabIndex={-1} className={clsx('lg-json-chip', expanded & EXPAND_JSON && 'is-open')} data-act="json" title={t('logs.row.expandJson')}>
              {jsonPreview(props, 90)}
            </button>
          ) : null}
          {row.n > 1 ? <span className="lg-repeat tnum">×{row.n}</span> : null}
        </span>
      </div>
      {expanded & EXPAND_JSON && hasProps ? (
        <div className="lg-expand">
          <div className="lg-json">
            <JsonTree data={props} rootLabel="props" defaultExpandDepth={2} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ───────────── network rows ───────────── */

function NetworkRow({ row, time, net, selected, flash, d }: LogRowProps) {
  const e = row.e;
  let method: ReactNode = null;
  let body: ReactNode;
  if (net) {
    const cls = statusClass(net.status, net.state);
    const failed = net.state === 'failed' || net.state === 'cancelled';
    method = <span className={`method method--${methodClass(net.method)} lg-net-method`}>{net.method === '?' ? '???' : net.method.toUpperCase()}</span>;
    body = (
      <>
        <span className="lg-text lg-net-url" title={net.url}>
          <span className="lg-net-host">{net.host}</span>
          <HlText text={net.path || '/'} hl={d.hl} max={600} />
          {net.graphql?.operationName ? <span className="lg-net-gql"> · {net.graphql.operationType ?? 'query'} {net.graphql.operationName}</span> : null}
        </span>
        <span className="lg-net-meta tnum">
          {net.state === 'pending' ? (
            <span className="lg-net-pending">
              <Spinner size={10} />
              {t('logs.net.pending')}
            </span>
          ) : null}
          {typeof net.status === 'number' ? <span className={`status status--${cls}`}>{net.status}</span> : null}
          {failed ? (
            <span className="lg-net-error" title={net.error}>
              {net.state === 'cancelled' ? t('logs.net.cancelled') : t('logs.net.failed')}
              {net.error ? ` · ${net.error}` : ''}
            </span>
          ) : null}
          {typeof net.duration === 'number' ? <span className="lg-net-dim">{formatDuration(net.duration, { lang: d.lang })}</span> : null}
          {typeof net.responseBodySize === 'number' && net.state !== 'pending' ? <span className="lg-net-dim">{formatBytes(net.responseBodySize, { lang: d.lang })}</span> : null}
          {net.mocked ? (
            <span className="lg-net-mock" title={t('logs.net.mockedTip')}>
              {t('logs.net.mocked')}
            </span>
          ) : null}
        </span>
      </>
    );
  } else {
    const sp = e.message.indexOf(' ');
    method = sp > 0 ? <span className="method method--other lg-net-method">{e.message.slice(0, sp)}</span> : null;
    body = (
      <span className="lg-text lg-net-gone" title={t('logs.net.gone')}>
        <HlText text={sp > 0 ? e.message.slice(sp + 1) : e.message} hl={d.hl} />
      </span>
    );
  }
  const failed = net && (net.state === 'failed' || (typeof net.status === 'number' && net.status >= 500));
  // Who: the app that made the request (the tag is always "network" — the globe icon already says that).
  const app = d.appName(e);
  return (
    <div
      className={clsx('lg-row lg-row--net', failed && 'lg-row--net-failed', selected && 'is-selected', flash && 'is-flash')}
      data-row={row.id}
      data-act={e.netId ? 'net' : undefined}
      title={net ? t('logs.net.open') : undefined}
    >
      <div className="lg-line1">
        <span className="lg-time tnum">{time}</span>
        <span className="lg-lvl lg-lvl--net" aria-hidden>
          <ArrowRight size={11} />
        </span>
        <span className="lg-src" title={d.device?.(e) ? `${d.device(e)!.name} · ${t('logs.kind.network')}` : t('logs.kind.network')}>
          <Globe size={12} aria-hidden />
        </span>
        <DeviceChip e={e} d={d} />
        <span className="lg-who">
          {app ? (
            <button
              type="button"
              tabIndex={-1}
              className="tag-chip tag-chip--clickable lg-tag"
              style={{ '--h': hashHue(app) } as CSSProperties}
              data-act="app"
              data-v={app}
              title={`${app} · ${t('logs.row.filterApp')}`}
            >
              {app}
            </button>
          ) : null}
        </span>
        <span className="lg-msg lg-msg--net">
          {method}
          {body}
        </span>
      </div>
    </div>
  );
}

/* ───────────── crash rows ───────────── */

const CRASH_ICON = { crash: OctagonX, anr: Hourglass, 'flutter-error': TriangleAlert } as const;

function CrashRow({ row, time, selected, expanded, flash, d }: LogRowProps) {
  const e = row.e;
  const a = analyzeEntry(e);
  const c = a.crash!;
  const Icon = CRASH_ICON[c.kind];
  const open = (expanded & EXPAND_STACK) !== 0;
  const frames = a.frames;
  const kindLabel = c.kind === 'crash' ? t('logs.kind.crash') : c.kind === 'anr' ? t('logs.kind.anr') : t('logs.kind.flutterError');
  const who = d.appName(e) ?? e.process ?? e.tag;
  // Android dropbox / iOS .ips: a record the device kept itself (any build, no SDK needed).
  const record = isDeviceCrashRecord(e);
  // The build that crashed: from this record, or from the device's own record of this live crash.
  const built = crashedBuildOf(e) ?? (row.rec ? crashedBuildOf(row.rec) : undefined);
  const builtTip = built ? t(c.kind === 'anr' ? 'logs.row.anrInBuild' : 'logs.row.crashedInBuild', { build: built }) : undefined;
  return (
    <div
      className={clsx('lg-row lg-crash', `lg-crash--${c.kind}`, selected && 'is-selected', flash && 'is-flash', open && 'is-expanded')}
      data-row={row.id}
    >
      <div className="lg-crash__head">
        <span className="lg-time tnum">{time}</span>
        <span className="lg-crash__icon">
          <Icon size={15} aria-hidden />
        </span>
        <span className="lg-crash__main">
          <span className="lg-crash__title">
            <HlText text={c.title} hl={d.hl} max={600} />
          </span>
          <span className="lg-crash__meta">
            <span className="lg-crash__kind">{kindLabel}</span>
            {who ? <span>{who}</span> : null}
            {built ? (
              <span className="lg-crash__build tnum" title={`${builtTip} · ${t('sources.crash.fromDevice')}`}>
                {built}
              </span>
            ) : null}
            <DeviceChip e={e} d={d} className="lg-dev--inline" />
            <SourceLabel e={e} record={record} />
            {c.previousLaunch ? (
              <span className="lg-prev" title={record ? t('sources.crash.previousLaunchTip') : t('logs.row.previousLaunchTip')}>
                <History size={11} aria-hidden />
                {record ? t('logs.row.beforeWatching') : t('logs.row.previousLaunch')} · {crashWhen(e)}
              </span>
            ) : null}
            {record && recordUnsymbolicated(e) ? (
              <span className="lg-unsym" title={t('sources.crash.unsymbolicatedTip')}>
                {t('sources.crash.unsymbolicated')}
              </span>
            ) : null}
            {row.twin ? (
              <span className="lg-twin" title={t('logs.row.twinTip')}>
                <Smartphone size={10} aria-hidden />
                {t('logs.row.twin')}
              </span>
            ) : null}
            {c.detail ? (
              <span className="lg-crash__detail" title={c.detail}>
                {c.detail}
              </span>
            ) : null}
          </span>
        </span>
        {frames > 0 || a.extra > 0 ? (
          <button type="button" tabIndex={-1} className={clsx('lg-badge lg-badge--crash', open && 'is-open')} data-act="stack" title={t('logs.row.expandStack')}>
            {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
            {frames > 0 ? t('logs.row.frames', { count: frames }) : t('logs.row.moreLines', { count: a.extra })}
          </button>
        ) : null}
      </div>
      {open ? <ExpandedBody e={e} a={a} expanded={expanded} d={d} /> : null}
    </div>
  );
}

function SourceLabel({ e, record }: { e: LogEntry; record: boolean }) {
  if (record)
    return (
      <span className="lg-crash__src lg-crash__src--record" title={`${entrySourceText(e)} · ${t('sources.crash.fromDeviceTip')}`}>
        {t('sources.crash.fromDevice')}
      </span>
    );
  return (
    <span className="lg-crash__src" title={entrySourceText(e)}>
      {t(`logs.source.row.${e.source}`)}
    </span>
  );
}

/* ───────────── separators ───────────── */

function lifecycleIcon(code: string | undefined) {
  switch (code) {
    case 'device.connected':
      return Plug;
    case 'device.disconnected':
      return Unplug;
    case 'app.connected':
      return PlugZap;
    case 'app.reconnected':
      return RefreshCw;
    case 'app.disconnected':
      return Square;
    case 'process.started':
      return Play;
    case 'process.died':
      return Square;
    case 'vm.hotRestart':
      return RotateCcw;
    case 'vm.hotReload':
      return Flame;
    default:
      if (code?.startsWith('vm.')) return Cpu;
      if (code?.startsWith('logs.')) return ScrollText;
      return Layers;
  }
}

function SeparatorRow(props: LogRowProps) {
  const { row, selected, flash, d } = props;
  if (row.flap) return <FlapRow {...props} />;
  const e = row.e;
  const Icon = lifecycleIcon(e.code);
  const tone = e.level === 'warn' || e.level === 'error' || e.code === 'process.died' || e.code === 'app.disconnected' ? 'warn' : e.code?.endsWith('connected') || e.code === 'process.started' ? 'ok' : 'neutral';
  return (
    <div className={clsx('lg-sep', `lg-sep--${tone}`, selected && 'is-selected', flash && 'is-flash')} data-row={row.id}>
      <span className="lg-sep__rule" />
      <span className="lg-sep__label">
        <Icon size={12} aria-hidden />
        {/* Device separators name their device already; app / process ones do not. */}
        {e.code?.startsWith('device.') ? null : <DeviceChip e={e} d={d} />}
        <span className="lg-sep__text">{systemText(e)}</span>
        <span className="lg-sep__time tnum">{formatClock(e.ts, { ms: false })}</span>
        {row.n > 1 ? <span className="lg-repeat tnum">×{row.n}</span> : null}
      </span>
      <span className="lg-sep__rule" />
    </div>
  );
}

/** A flapping connection: one line («Bağlantı 6 kez koptu ve geri geldi · 40 sn içinde»), the events when expanded. */
function FlapRow({ row, selected, expanded, flash, d }: LogRowProps) {
  const events = row.flap!.events;
  const first = events[0]!;
  const sum = flapSummary(events, d.deviceName?.(row.e.deviceId) ?? d.device?.(row.e)?.name, d.lang);
  const open = (expanded & EXPAND_LINES) !== 0;
  const tip = sum.hint ? `${sum.text} — ${sum.hint}` : sum.text;
  return (
    <div className={clsx('lg-flaprow', selected && 'is-selected', flash && 'is-flash')} data-row={row.id}>
      <div className="lg-sep lg-sep--warn">
        <span className="lg-sep__rule" />
        <button type="button" tabIndex={-1} className="lg-sep__label lg-sep__toggle" data-act="lines" aria-expanded={open} title={`${tip} · ${open ? t('logs.row.collapse') : t('logs.flap.expand')}`}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <Unplug size={12} aria-hidden />
          <span className="lg-sep__text">{sum.text}</span>
          <span className="lg-sep__time tnum">{flapTimeRange(first.ts, row.e.ts, (ts) => formatClock(ts, { ms: false }))}</span>
        </button>
        <span className="lg-sep__rule" />
      </div>
      {open ? (
        <div className="lg-flap">
          {events.map((ev) => (
            <div key={ev.id} className="lg-flap__ev">
              <span className="lg-flap__time tnum">{formatClock(ev.ts, { ms: false })}</span>
              <span>{systemText(ev)}</span>
            </div>
          ))}
          {sum.hint ? <p className="lg-flap__hint">{sum.hint}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function MarkerRow({ row, selected, flash }: LogRowProps) {
  const e = row.e;
  return (
    <div className={clsx('lg-marker', selected && 'is-selected', flash && 'is-flash')} data-row={row.id}>
      <span className="lg-marker__rule" />
      <span className="lg-marker__label">
        <Bookmark size={12} aria-hidden />
        <span className="lg-marker__text">{systemText(e)}</span>
        <span className="lg-marker__time tnum">{formatClock(e.ts)}</span>
      </span>
      <span className="lg-marker__rule" />
    </div>
  );
}

/** One log row (memoized: re-renders only when its own row object, time text, network entry or state changes). */
export const LogRowView = memo(function LogRowView(props: LogRowProps) {
  const e = props.row.e;
  if (e.kind === 'marker') return <MarkerRow {...props} />;
  if (e.source === 'system' && e.kind === 'lifecycle') return <SeparatorRow {...props} />;
  if (e.kind === 'crash' || e.kind === 'anr' || e.kind === 'flutter-error') return <CrashRow {...props} />;
  if (e.kind === 'network') return <NetworkRow {...props} />;
  if (e.kind === 'event') return <EventRow {...props} />;
  return <TextRow {...props} />;
});

/** Whether a crash row reports a previous launch (used by the banner and the list). */
export { isPreviousLaunch };
