import type { NetworkEntry } from '@durbun/protocol';

/**
 * Network filters: toolbar chips/toggles plus a small token query language for the search field:
 *   status:4xx  status:404  status:>=500  status:fail  method:post,put  host:api  path:/v1/pets
 *   type:json|graphql|image|…  is:failed|error|pending|mocked|slow|graphql|replay|cancelled
 *   op:GetUser  source:dio  dur:>1s  size:>100kb  app:pati   "quoted phrase"   -negated
 * Free words match URL, method, status, GraphQL operation and error text (case-insensitive, plain
 * toLowerCase — SPEC §7.1). With "body search" the free words go to the server instead.
 */

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'fail';
export const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'fail'];

export type TypeCategory = 'json' | 'graphql' | 'html' | 'image' | 'media' | 'font' | 'script' | 'other';
export const TYPE_CATEGORIES: readonly TypeCategory[] = ['json', 'graphql', 'html', 'image', 'media', 'font', 'script', 'other'];

export const METHOD_CHIPS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'] as const;
export type MethodChip = (typeof METHOD_CHIPS)[number];

export interface NetFilters {
  methods: MethodChip[];
  statuses: StatusClass[];
  types: TypeCategory[];
  /** Exact host, null = all hosts. */
  host: string | null;
  errorsOnly: boolean;
  slowOnly: boolean;
  /** "Slow" threshold in ms (default 1 s). */
  slowMs: number;
  mockedOnly: boolean;
}

export const DEFAULT_SLOW_MS = 1000;

export const DEFAULT_FILTERS: NetFilters = {
  methods: [],
  statuses: [],
  types: [],
  host: null,
  errorsOnly: false,
  slowOnly: false,
  slowMs: DEFAULT_SLOW_MS,
  mockedOnly: false,
};

function pickList<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is T => typeof x === 'string' && (allowed as readonly string[]).includes(x)))];
}

/** Validate persisted filters (localStorage may hold anything). */
export function sanitizeFilters(raw: unknown): NetFilters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const slow = Number(r.slowMs);
  return {
    methods: pickList(r.methods, METHOD_CHIPS),
    statuses: pickList(r.statuses, STATUS_CLASSES),
    types: pickList(r.types, TYPE_CATEGORIES),
    host: typeof r.host === 'string' && r.host ? r.host : null,
    errorsOnly: r.errorsOnly === true,
    slowOnly: r.slowOnly === true,
    slowMs: Number.isFinite(slow) && slow >= 50 && slow <= 600_000 ? Math.round(slow) : DEFAULT_SLOW_MS,
    mockedOnly: r.mockedOnly === true,
  };
}

/** Number of active chip/toggle filters (the slow threshold alone does not count). */
export function activeFilterCount(f: NetFilters): number {
  return f.methods.length + f.statuses.length + f.types.length + (f.host ? 1 : 0) + (f.errorsOnly ? 1 : 0) + (f.slowOnly ? 1 : 0) + (f.mockedOnly ? 1 : 0);
}

export function toggleIn<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/* ───────────── Entry classification ───────────── */

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function methodChipOf(method: string): MethodChip {
  const m = method.toUpperCase();
  return KNOWN_METHODS.has(m) ? (m as MethodChip) : 'OTHER';
}

export function isFailed(e: Pick<NetworkEntry, 'state'>): boolean {
  return e.state === 'failed' || e.state === 'cancelled';
}

/** HTTP class of the status and/or 'fail' (an entry can be failed AND have a status, SPEC §9.4). */
export function statusClassesOf(e: Pick<NetworkEntry, 'state' | 'status'>): StatusClass[] {
  const out: StatusClass[] = [];
  const s = e.status;
  if (typeof s === 'number' && e.state !== 'pending') {
    if (s >= 500) out.push('5xx');
    else if (s >= 400) out.push('4xx');
    else if (s >= 300) out.push('3xx');
    else if (s >= 200) out.push('2xx');
  }
  if (isFailed(e)) out.push('fail');
  return out;
}

/** Failed transport or HTTP ≥ 400 (same rule as `isNetworkError` in the data layer). */
export function isErrorEntry(e: Pick<NetworkEntry, 'state' | 'status'>): boolean {
  return e.state === 'failed' || (typeof e.status === 'number' && e.status >= 400);
}

export function extensionOf(path: string): string {
  const q = path.search(/[?#]/);
  const p = q >= 0 ? path.slice(0, q) : path;
  const last = p.slice(p.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

const EXT_CATEGORY: Record<string, TypeCategory> = {
  json: 'json',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  avif: 'image',
  heic: 'image',
  bmp: 'image',
  mp4: 'media',
  m4a: 'media',
  mp3: 'media',
  m3u8: 'media',
  mpd: 'media',
  webm: 'media',
  mov: 'media',
  aac: 'media',
  wav: 'media',
  ogg: 'media',
  ts: 'media',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  js: 'script',
  mjs: 'script',
  css: 'script',
  map: 'script',
  wasm: 'script',
};

function categoryOfContentType(ct: string): TypeCategory | null {
  const c = ct.toLowerCase();
  if (c.includes('graphql')) return 'graphql';
  if (c.includes('json')) return 'json';
  if (c.includes('html')) return 'html';
  if (c.startsWith('image/')) return 'image';
  if (c.startsWith('audio/') || c.startsWith('video/') || c.includes('mpegurl') || c.includes('dash+xml')) return 'media';
  if (c.startsWith('font/') || c.includes('woff') || c.includes('opentype') || c.includes('truetype') || c.includes('font-')) return 'font';
  if (c.includes('javascript') || c.includes('ecmascript') || c.includes('text/css') || c.includes('wasm')) return 'script';
  return null;
}

/** Content-type category of an entry (GraphQL wins; falls back to the URL extension). */
export function typeCategoryOf(e: Pick<NetworkEntry, 'graphql' | 'responseContentType' | 'requestContentType' | 'path'>): TypeCategory {
  if (e.graphql) return 'graphql';
  if (e.responseContentType) {
    const c = categoryOfContentType(e.responseContentType);
    if (c) return c;
    return EXT_CATEGORY[extensionOf(e.path)] ?? 'other';
  }
  return EXT_CATEGORY[extensionOf(e.path)] ?? 'other';
}

/** Short type label for the "Tür" column: json, graphql, png, html, form, multipart, text, binary… */
export function shortTypeLabel(e: Pick<NetworkEntry, 'graphql' | 'responseContentType' | 'path' | 'state'>): string {
  if (e.graphql) return 'graphql';
  const ct = (e.responseContentType ?? '').toLowerCase().split(';')[0]!.trim();
  if (!ct) {
    const ext = extensionOf(e.path);
    return ext && ext.length <= 6 ? ext : '';
  }
  if (ct.includes('json')) return ct.includes('problem+json') ? 'problem' : 'json';
  if (ct === 'application/x-www-form-urlencoded') return 'form';
  if (ct.startsWith('multipart/')) return 'multipart';
  if (ct === 'application/octet-stream') return 'binary';
  if (ct === 'text/plain') return 'text';
  if (ct.includes('javascript')) return 'js';
  const slash = ct.indexOf('/');
  let sub = slash >= 0 ? ct.slice(slash + 1) : ct;
  sub = sub.replace(/^x-/, '').replace(/\+xml$/, '');
  if (sub === 'svg') return 'svg';
  if (sub === 'jpeg') return 'jpeg';
  return sub.length > 10 ? sub.slice(0, 10) : sub;
}

/* ───────────── Query language ───────────── */

export type QueryKey = 'status' | 'method' | 'host' | 'path' | 'url' | 'type' | 'source' | 'is' | 'op' | 'dur' | 'size' | 'app';

const KEY_ALIASES: Record<string, QueryKey> = {
  status: 'status',
  durum: 'status',
  code: 'status',
  method: 'method',
  metot: 'method',
  host: 'host',
  domain: 'host',
  path: 'path',
  yol: 'path',
  url: 'url',
  type: 'type',
  tür: 'type',
  tur: 'type',
  mime: 'type',
  source: 'source',
  kaynak: 'source',
  is: 'is',
  op: 'op',
  operation: 'op',
  gql: 'op',
  dur: 'dur',
  duration: 'dur',
  time: 'dur',
  süre: 'dur',
  sure: 'dur',
  size: 'size',
  boyut: 'size',
  app: 'app',
};

export type Comparator = '>' | '>=' | '<' | '<=' | '=';

export interface QueryClause {
  key: QueryKey | null;
  /** Lower-cased value (free text or the part after `key:`). */
  value: string;
  negate: boolean;
  /** Comparison for status/dur/size. */
  cmp?: { op: Comparator; n: number; n2?: number };
}

export interface ParsedQuery {
  clauses: QueryClause[];
  /** Positive free-text words joined (sent to the server for body search). */
  freeText: string;
  /** Tokens that could not be understood (shown as an invalid field). */
  invalid: string[];
  empty: boolean;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /(-?)(?:([A-Za-zçğıöşüÇĞİÖŞÜ]+):)?(?:"([^"]*)"?|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].trim() === '') continue;
    out.push(m[0]);
  }
  return out;
}

const UNIT_MS: Record<string, number> = { '': 1, ms: 1, s: 1000, sn: 1000, sec: 1000, m: 60_000, min: 60_000, dk: 60_000 };
const UNIT_B: Record<string, number> = { '': 1, b: 1, k: 1024, kb: 1024, m: 1_048_576, mb: 1_048_576, g: 1_073_741_824, gb: 1_073_741_824 };

function parseCmp(value: string, units: Record<string, number> | null): QueryClause['cmp'] | null {
  const range = /^(\d+(?:[.,]\d+)?)([a-z]*)-(\d+(?:[.,]\d+)?)([a-z]*)$/.exec(value);
  const num = (s: string) => Number(s.replace(',', '.'));
  if (range) {
    const u1 = units ? units[range[2]! || range[4]!] : range[2] ? undefined : 1;
    const u2 = units ? units[range[4]! || range[2]!] : range[4] ? undefined : 1;
    if (u1 === undefined || u2 === undefined) return null;
    return { op: '=', n: num(range[1]!) * u1, n2: num(range[3]!) * u2 };
  }
  const m = /^(>=|<=|>|<|=)?(\d+(?:[.,]\d+)?)([a-z]*)$/.exec(value);
  if (!m) return null;
  const unit = units ? units[m[3]!] : m[3] ? undefined : 1;
  if (unit === undefined) return null;
  return { op: (m[1] as Comparator) || '=', n: num(m[2]!) * unit };
}

function compare(v: number, cmp: NonNullable<QueryClause['cmp']>): boolean {
  if (cmp.n2 !== undefined) return v >= cmp.n && v <= cmp.n2;
  switch (cmp.op) {
    case '>':
      return v > cmp.n;
    case '>=':
      return v >= cmp.n;
    case '<':
      return v < cmp.n;
    case '<=':
      return v <= cmp.n;
    default:
      return v === cmp.n;
  }
}

const IS_VALUES = new Set(['failed', 'fail', 'error', 'errors', 'hata', 'pending', 'mocked', 'mock', 'slow', 'yavaş', 'yavas', 'graphql', 'gql', 'replay', 'cancelled', 'canceled', 'iptal', 'complete', 'ok']);
const TYPE_VALUES: Record<string, TypeCategory> = {
  json: 'json',
  graphql: 'graphql',
  gql: 'graphql',
  html: 'html',
  image: 'image',
  img: 'image',
  görsel: 'image',
  gorsel: 'image',
  media: 'media',
  medya: 'media',
  video: 'media',
  audio: 'media',
  font: 'font',
  script: 'script',
  js: 'script',
  css: 'script',
  other: 'other',
  diğer: 'other',
  diger: 'other',
};

export function parseQuery(text: string): ParsedQuery {
  const clauses: QueryClause[] = [];
  const invalid: string[] = [];
  const free: string[] = [];
  for (const token of tokenize(text)) {
    let t = token;
    let negate = false;
    if (t === '-') continue;
    if (t.startsWith('-')) {
      negate = true;
      t = t.slice(1);
    }
    const colon = t.indexOf(':');
    const rawKey = colon > 0 ? t.slice(0, colon).toLowerCase() : '';
    const key = rawKey ? KEY_ALIASES[rawKey] : undefined;
    if (!key) {
      const value = t.replace(/^"|"$/g, '').toLowerCase();
      if (!value) continue;
      clauses.push({ key: null, value, negate });
      if (!negate) free.push(value);
      continue;
    }
    const value = t
      .slice(colon + 1)
      .replace(/^"|"$/g, '')
      .toLowerCase();
    if (!value) continue; // still typing ("status:")
    const clause: QueryClause = { key, value, negate };
    if (key === 'status') {
      if (!/^[1-5]xx$/.test(value) && !['fail', 'failed', 'hata', 'error', 'pending', 'bekliyor', 'cancelled', 'iptal'].includes(value) && !/^\d{1,3}$/.test(value)) {
        const cmp = parseCmp(value, null);
        if (!cmp) {
          invalid.push(token);
          continue;
        }
        clause.cmp = cmp;
      }
    } else if (key === 'dur' || key === 'size') {
      const cmp = parseCmp(value, key === 'dur' ? UNIT_MS : UNIT_B);
      if (!cmp) {
        invalid.push(token);
        continue;
      }
      if (cmp.op === '=' && cmp.n2 === undefined) cmp.op = '>=';
      clause.cmp = cmp;
    } else if (key === 'is' && !IS_VALUES.has(value)) {
      invalid.push(token);
      continue;
    }
    clauses.push(clause);
  }
  return { clauses, freeText: free.join(' '), invalid, empty: clauses.length === 0 };
}

export interface FilterContext {
  slowMs: number;
  /** Server-side body search result: free words are satisfied by membership (null = not active). */
  bodyMatches?: ReadonlySet<string> | null;
  /** App display name + bundle id for `app:` clauses. */
  appLabel?: (appId: string | undefined) => string;
}

function freeTextMatches(e: NetworkEntry, word: string): boolean {
  if (e.url.toLowerCase().includes(word)) return true;
  if (e.method.toLowerCase() === word) return true;
  if (e.status !== undefined && String(e.status).startsWith(word)) return true;
  if (e.graphql) {
    const op = `${e.graphql.operationType ?? ''} ${e.graphql.operationName ?? ''}`.toLowerCase();
    if (op.includes(word)) return true;
  }
  if (e.error && e.error.toLowerCase().includes(word)) return true;
  return false;
}

function clauseMatches(e: NetworkEntry, c: QueryClause, ctx: FilterContext): boolean {
  const v = c.value;
  switch (c.key) {
    case null:
      return freeTextMatches(e, v);
    case 'status': {
      if (c.cmp) return typeof e.status === 'number' && compare(e.status, c.cmp);
      if (/^[1-5]xx$/.test(v)) return typeof e.status === 'number' && e.state !== 'pending' && Math.floor(e.status / 100) === Number(v[0]);
      if (v === 'pending' || v === 'bekliyor') return e.state === 'pending';
      if (v === 'cancelled' || v === 'iptal') return e.state === 'cancelled';
      if (v === 'fail' || v === 'failed' || v === 'hata') return isFailed(e);
      if (v === 'error') return isErrorEntry(e);
      return e.status !== undefined && String(e.status).startsWith(v);
    }
    case 'method':
      return v.split(',').some((m) => m && e.method.toLowerCase() === m);
    case 'host':
      return v.split(',').some((h) => h && e.host.toLowerCase().includes(h));
    case 'path':
      return e.path.toLowerCase().includes(v);
    case 'url':
      return e.url.toLowerCase().includes(v);
    case 'type': {
      return v.split(',').some((x) => {
        if (!x) return false;
        const cat = TYPE_VALUES[x];
        if (cat) return typeCategoryOf(e) === cat;
        return (e.responseContentType ?? '').toLowerCase().includes(x) || shortTypeLabel(e) === x;
      });
    }
    case 'source':
      return e.source.toLowerCase().includes(v);
    case 'op': {
      if (!e.graphql) return false;
      const op = `${e.graphql.operationType ?? ''} ${e.graphql.operationName ?? ''}`.toLowerCase();
      return op.includes(v);
    }
    case 'is':
      switch (v) {
        case 'failed':
        case 'fail':
        case 'hata':
          return e.state === 'failed';
        case 'error':
        case 'errors':
          return isErrorEntry(e);
        case 'pending':
          return e.state === 'pending';
        case 'mocked':
        case 'mock':
          return e.mocked === true;
        case 'slow':
        case 'yavaş':
        case 'yavas':
          return (e.duration ?? 0) >= ctx.slowMs;
        case 'graphql':
        case 'gql':
          return !!e.graphql;
        case 'replay':
          return e.source === 'replay' || e.deviceId === 'desktop';
        case 'cancelled':
        case 'canceled':
        case 'iptal':
          return e.state === 'cancelled';
        case 'complete':
        case 'ok':
          return e.state === 'complete';
        default:
          return false;
      }
    case 'dur':
      return e.duration !== undefined && compare(e.duration, c.cmp!);
    case 'size':
      return compare(e.responseBodySize ?? 0, c.cmp!);
    case 'app': {
      const label = (ctx.appLabel?.(e.appId) ?? e.appId ?? '').toLowerCase();
      return label.includes(v);
    }
    default:
      return true;
  }
}

/** Build the row predicate from chips/toggles and the parsed query. */
export function compileFilter(filters: NetFilters, query: ParsedQuery, ctx: FilterContext): (e: NetworkEntry) => boolean {
  const methods = filters.methods.length ? new Set<string>(filters.methods) : null;
  const statuses = filters.statuses.length ? new Set<StatusClass>(filters.statuses) : null;
  const types = filters.types.length ? new Set<TypeCategory>(filters.types) : null;
  const host = filters.host;
  const body = ctx.bodyMatches ?? null;
  const clauses = query.clauses;
  return (e) => {
    if (methods && !methods.has(methodChipOf(e.method))) return false;
    if (statuses) {
      const classes = statusClassesOf(e);
      if (!classes.some((c) => statuses.has(c))) return false;
    }
    if (types && !types.has(typeCategoryOf(e))) return false;
    if (host !== null && e.host !== host) return false;
    if (filters.errorsOnly && !isErrorEntry(e)) return false;
    if (filters.slowOnly && !((e.duration ?? 0) >= filters.slowMs)) return false;
    if (filters.mockedOnly && !e.mocked) return false;
    let freeSeen = false;
    for (const c of clauses) {
      if (c.key === null && !c.negate && body) {
        // Body search: the server already matched all free words (URL, headers and bodies).
        if (!freeSeen) {
          freeSeen = true;
          if (!body.has(e.id)) return false;
        }
        continue;
      }
      const hit = clauseMatches(e, c, ctx);
      if (hit === c.negate) return false;
    }
    return true;
  };
}
