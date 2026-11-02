# Dürbün UI — foundation guide for feature engineers

This document is the contract between the UI foundation (shell, design system, data layer) and the
phase-2 feature views (`src/features/{logs,network,mocks,perf,device}`). Everything here is implemented
and exported; signatures below are the real ones. Data shapes come from `@durbun/protocol`
(`packages/protocol/src/index.ts`) — read SPEC §1.1 (readability) and §7 before building a view.

```ts
import { logStore, useLogVersion, useCompiledScope, sendCommand, api } from '../../data';
import { Button, SplitPane, JsonTree, useShortcut, useCommands, formatBytes, toast } from '../../components';
import { registerMessages, useT } from '../../i18n';
```

---

## 1. Feature contract

- Each tab renders the **default export** of `src/features/<tab>/index.tsx` (`logs`, `network`, `mocks`,
  `perf`, `device`). It is lazy-loaded (own chunk) and mounted inside `.feature`: an absolutely
  positioned, **full-height flex column** (`display:flex; flex-direction:column; min-height:0`). Your root
  should be `flex: 1; min-height: 0` (utility class `fill`) and own its scrolling.
- Views are **kept mounted** after the first visit and hidden (not unmounted) when another tab is active,
  so scroll positions and local state survive tab switches. While hidden they get `inert`,
  `visibility:hidden` and `content-visibility:hidden`. Use `useFeatureActive()` to pause work:
  ```ts
  const active = useFeatureActive();
  useLogVersion({ enabled: active });            // stop re-rendering while hidden
  useShortcut('Space', togglePause, { enabled: active });
  ```
- Each view is wrapped in an `ErrorBoundary` (retry + copy details). Errors are data: catch
  `sendCommand`/`api` failures and show a toast or inline `Callout`; never let a promise reject unhandled.
- The **onboarding** overlay covers every tab except `mocks` while there are no devices and no apps.
- Register your own i18n namespace (`registerMessages('logs', …)`), palette commands (`useCommands`) and
  shortcuts (`useShortcut`) from inside your view.
- Window-wide drag-and-drop imports `.durbun.json` sessions. If your view has its own drop zone (e.g. app
  install on the Device tab), put `data-dropzone` on the element; the global handler then ignores drops
  inside it and you handle `dragover`/`drop` yourself.

## 2. Running

```bash
# terminal 1 — dev mock (WS /ui + REST stubs, realistic live data)
npm run mock -w @durbun/ui            # = node packages/ui/dev/mock-server.mjs --port 9799 (--empty → onboarding, --rate 60 → busier)
# terminal 2 — Vite on :5179 proxied to the mock
npm run dev:mock -w @durbun/ui        # = DURBUN_SERVER=http://127.0.0.1:9799 vite --port 5179
# or against the real server: npm run dev (repo root) / DURBUN_SERVER=http://127.0.0.1:9750 npx vite

npx tsc -p packages/ui/tsconfig.json      # typecheck
npx vitest run                            # in packages/ui (jsdom, 2 workers)
npm run build -w @durbun/ui               # → dist/ui
```

The mock answers every command with `{ok:true}` and plausible data; `demo.set false/true` empties/refills
it (onboarding). It is a dev tool only — the real server is `packages/server`. Its system lines use the real
server params (SPEC §9.2).

**Building your own copy while another team's folder is mid-edit** (SPEC §9.5): `dev/vite.stub.config.ts` is the
normal config plus two escape hatches — a missing CSS import inside `src/features/**` becomes an empty stylesheet,
and `STUB_FEATURES=network,mocks` renders those tabs empty when their code does not build yet. Dev loop only:

```bash
cd packages/ui && npx vite build --config dev/vite.stub.config.ts --outDir <your tmp>/ui --emptyOutDir
STUB_FEATURES=network npx vite build --config dev/vite.stub.config.ts --outDir <your tmp>/ui --emptyOutDir
```

## 3. Source map

| Path | What |
|---|---|
| `src/main.tsx`, `src/App.tsx` | bootstrap (fonts, CSS, prefs → `<html>`, WS connect) and shell composition |
| `src/data/` | WS client, commands, REST, stores, scope, hooks (barrel: `data/index.ts`) |
| `src/components/` | design-system components, hooks and helpers (barrel: `components/index.ts`) |
| `src/i18n/` | i18n core, foundation dictionaries, server-code localization (barrel: `i18n/index.ts`) |
| `src/lib/` | pure helpers: format, fuzzy, hash, json, highlight, shortcuts, commands, persist, clipboard, download, notify |
| `src/shell/` | sidebar, top bar, status bar, palette, settings, doctor, SDK guide, onboarding (foundation-owned) |
| `src/styles/` | `tokens.css`, `base.css` (reset + utilities), `components.css`, `shell.css` |

---

## 4. Data layer

### 4.1 Connection

`startConnection()` runs once in `main.tsx`. One WebSocket to `/ui`; reconnects forever with backoff
(0.3 s → 5 s). **Every (re)connect resyncs from scratch**: `hello` → `snapshot` (stores are cleared and
replaced) → `history` chunks → live `batch`es. Old data stays visible while disconnected.

```ts
useConnection(s => s.status)   // 'connecting' | 'syncing' | 'live' | 'reconnecting'
useConnection(s => s.server)   // ServerInfo | null (version, ports, demo, lan, hostAddresses…) — `demo`/`lan` are
                               // values at connect time: use useDemoActive() / useServerSettings(s => s.settings.allowLan)
isConnected(status)            // syncing || live
reconnectNow()
onResync(() => resetMyDerivedCaches())   // fired on every snapshot
onServerMessage((msg: ServerToUi) => …)  // every message, after stores were updated (keep it cheap)
onNotice((n: UiNotice) => …)             // the shell already shows notices as toasts
```

### 4.2 High-frequency stores (outside React)

Live data lives in mutable singletons; their `version` is bumped **at most once per animation frame**
(timer fallback when rAF is unavailable/throttled). Components subscribe to the version and read the store
during render. **Never mutate store data.**

```ts
useLogVersion(opts?: { throttleMs?: number; enabled?: boolean }): number
useNetworkVersion(opts?), useMetricsVersion(opts?)
useStoreVersion(store, opts?)                 // generic
```

**`logStore`** (`LogStore`)

| Member | Meaning |
|---|---|
| `entries: LogEntry[]` | ordered by `id` (arrival order, SPEC §4); ring trimmed at `maxEntries` (server `maxLogEntries`) |
| `version` | frame-coalesced change counter |
| `generation` | bumped on reset / arbitrary removal (`cleared`) — drop index-based caches when it changes |
| `headDropped` | entries trimmed from the head since the last reset (absolute index = `headDropped + i`) |
| `lastId`, `size` | newest id, `entries.length` |
| `totalReceived` / `liveReceived` | accepted since page load (with / without history) |
| `counts`, `countsByDevice`, `countsByApp` | incremental `{ total, warn, error (error+fatal), crash (crash/anr/flutter-error) }` |
| `getById(id)`, `indexOfId(id)`, `lowerBound(id)` | binary search by id |
| `subscribe(fn)` | called once per frame after changes |

Incremental filtering pattern for a virtualized list (avoid rescanning 200 000 entries per frame):

```ts
const v = useLogVersion({ enabled: active });
const compiled = useCompiledScope();
const cache = useRef({ gen: -1, scope: compiled, lastId: 0, rows: [] as LogEntry[] });
const rows = useMemo(() => {
  const c = cache.current;
  if (c.gen !== logStore.generation || c.scope !== compiled) Object.assign(c, { gen: logStore.generation, scope: compiled, lastId: 0, rows: [] });
  for (let i = logStore.lowerBound(c.lastId + 1); i < logStore.entries.length; i++) {
    const e = logStore.entries[i]!;
    if (compiled.logs(e) && myFilter(e)) c.rows.push(e);
  }
  c.lastId = logStore.lastId;
  // drop rows that fell out of the ring
  const first = logStore.entries[0]?.id ?? Infinity;
  while (c.rows.length && c.rows[0]!.id < first) c.rows.shift();   // (use an index pointer for big drops)
  return c.rows;
}, [v, compiled]);
```

**`networkStore`** (`NetworkStore`): `byId: Map<string, NetworkEntry>` (latest state; updates replace the
object), `order: string[]` (first seen), `list()` (cached array in order), `get(id)`, `size`,
`counts`/`countsByDevice`/`countsByApp` (`{ total, pending, failed, clientError, serverError, mocked }`),
`generation`, `isNetworkError(e)`. Log rows with `kind: 'network'` carry `netId` — render them from
`networkStore.get(netId)` so status/duration update live.

**`metricsStore`** (`MetricsStore`): `series: Map<key, MetricSeries>` where
`MetricSeries = { key, deviceId, appId?, pid?, samples: MetricSample[] (≤ 3600, ts-ordered), updatedAt }`;
`metricSeriesKey({deviceId, appId?, pid?})` → `"<deviceId>|<appId>"` or `"<deviceId>|pid:<pid>"`;
`get(key)`, `seriesFor(target)`, `latest(key)`, `keys()`.

Counters & rates (throttled hooks): `useScopedLogCounts(throttleMs = 250)`,
`useScopedNetworkCounts(throttleMs = 250)`, `useIngestRate()` → `{ logsPerSec, requestsPerSec, history: number[60] }`,
`useNow(intervalMs)`.

### 4.3 zustand stores

| Hook / API | State |
|---|---|
| `useConnection` | see 4.1 |
| `useHub` | `{ devices: Record<id, DeviceInfo>, apps: Record<id, AppSession>, drivers: DriverStatus[], processes: Record<deviceId, Record<pid, ProcessUpdate>> }` |
| `useDevices()` / `useDevice(id)` | sorted device list (live → demo → imported; disconnected last) / one device |
| `useApps()` / `useApp(id)` / `useAppGroups()` | sessions; `AppGroup` = sessions of one bundle id on one device (`latest`, `sessions` newest first, `connected`) |
| `useDrivers()`, `useDemoActive()`, `useProcessName(deviceId, pid)`, `useIsEmpty()` | `useDemoActive()` follows the demo driver's live status |
| `isImportedDevice(id)`, `isNetworkDevice(id)`, `isReadOnlyDevice(id)`, `DESKTOP_DEVICE_ID` | virtual-device helpers (see 4.6) |
| `useScope()` / `setScope(scope, hint?)` / `getScope()` | current scope (see 4.4); persisted; validated after every resync |
| `useMocks(s => s.rules)` / `saveMocks(rules): Promise<MockRule[]>` | mock rules; `saveMocks` = `mocks.set` (optimistic, reverts on error) |
| `useServerSettings(s => s.settings)` / `updateServerSettings(patch)` | `ServerSettings`; update = `settings.update` (optimistic) |
| `usePrefs` | UI prefs, persisted to localStorage (`durbun.prefs.v1`) |
| `useUi` / `ui` | active tab + global screens: `ui.setTab(id)`, `ui.openPalette()`, `ui.openSettings(section?)`, `ui.openDoctor()`, `ui.openSdkGuide(tab?)`, `ui.openShortcuts()`; cross-feature navigation: `ui.focusLog(logId)`, `ui.focusNetwork(netId)`, `ui.focusMock(ruleId)`, `ui.newMockFromDraft(draft)` set `useUi(s => s.focus)` (`UiFocus` with a `seq`) and switch tabs — the target view handles it in an effect keyed on `focus?.seq`, then calls `ui.consumeFocus(seq)` |

`UiPrefs` fields: `theme ('system'|'dark'|'light')`, `language ('tr'|'en')`, `logFontSize (11–16)`,
`density ('compact'|'comfortable')`, `timeFormat ('absolute'|'relative'|'delta')`, `wrapLines`,
`showNetworkInLogs`, `hideNoise`, `noiseRules: NoiseRule[]`, `highlightRules: HighlightRule[]`,
`notifyOnCrash`, `sidebarCollapsed`, `panelSizes: Record<string, number>`, `lastTab`.
Write with `usePrefs.getState().setPref(key, value)` / `updatePrefs(patch)`. `DEFAULT_NOISE_RULES`,
`HIGHLIGHT_COLORS` are exported. `<html>` already reflects theme (`data-theme`), density
(`data-density` → `--row-h`), font size (`--log-fs`) and `lang`.

`NoiseRule = { id, field: 'tag'|'process'|'message', match: 'exact'|'prefix'|'contains', value, enabled }`;
`compileNoiseRules(rules) → (entry) => boolean` (device logs only; app/system lines are never noise).
`HighlightRule = { id, pattern, regex, caseSensitive, color: 'red'|'orange'|'yellow'|'green'|'blue'|'violet'|'pink', enabled }`
— colors are tokens `var(--pick-<color>)`.

### 4.4 Scope

```ts
type Scope = { kind: 'all' } | { kind: 'device'; deviceId: string } | { kind: 'app'; appId: string; exact?: boolean };
const compiled = useCompiledScope();     // memoized on scope + apps
compiled.logs(entry); compiled.network(entry); compiled.metrics(series);
compiled.deviceId; compiled.appIds; compiled.app
compileScope(scope, { apps }) / entryInScope(entry, scope) / networkInScope(entry, scope)
scopeLogCounts(compiled, logStore) / scopeNetworkCounts(compiled, networkStore)
```

- **device**: entries of that device. Markers are visible in every scope. Network entries replayed from
  the desktop (`deviceId: 'desktop'`) are visible in every scope.
- **app** (default): **all sessions of that app (same bundle id) on that device** — relaunches and hot
  restarts stay in view, separated by lifecycle lines. Logs match when `appId` is one of those sessions;
  device lines without `appId` match by process name (`app.id`, `processName`, `"<app.id>:…"`
  sub-processes), else by pid. Device-level system lines (`device.*`, `logs.*`) and `process.*` lines of the
  app's process are included.
- **app with `exact: true`** (picked from "earlier sessions" in the sidebar): only that session; device lines
  match by pid when the session has one.

### 4.5 Commands (WS) and REST

```ts
sendCommand<C extends UiCommand>(cmd: C, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandReply<C>>
```
Reply `data` types (`CommandReplyMap`): `clear → null`, `marker.add → LogEntry`, `device.action → unknown`
(`DeviceActionResult.data`), `app.action → unknown`, `mocks.set → MockRule[]`, `settings.update → ServerSettings`,
`vm.attach → {appId}`, `vm.detach/metrics.watch → null`, `net.replay → NetworkEntry`, `demo.set → {enabled}`,
`doctor.run → ToolCheck[]`. Rejects with `CommandError { message, code?, command, data? }` — server codes, or
local `command.timeout` / `command.disconnected` / `command.aborted` (show them with `errorText(err)`). Commands issued while disconnected
are queued and sent on connect (within their timeout). `sendCommandDetailed(cmd, opts)` resolves `{ data, code? }` — a
successful `device.action` forwards `DeviceActionResult.code` (`action.screenshot.saved`, `action.done`, …), localize it
with `tCode(code, data, fallback)`. Default timeouts: 15 s; `device.action` 30 s
(`screenshot`/`list-apps`/`app-uninstall` 60 s, `app-install` 300 s, `screen-record` duration + 60 s);
`net.replay` 40 s.

`api` (REST, same origin; `ApiError { status, message, code? }`):

| Function | Endpoint |
|---|---|
| `api.getNetworkDetail(id, signal?)` | `GET /api/network/:id` → `NetworkDetail` (bodies) |
| `api.bodyUrl(id, 'request'|'response', { download? })` | raw body URL (for `<img src>`, download links) |
| `api.searchNetwork(text, { ids?, caseSensitive?, signal? })` | `POST /api/network/search` → `string[]` |
| `api.exportUrl({ deviceId?, appId? })` | `GET /api/export` URL |
| `api.importSession(input, signal | { name?, signal? })` | `POST /api/import?name=<file name>` → `{ deviceIds }` (a `File` sends its own name; the server labels the imported devices with it) |
| `api.harExport(ids?)` / `api.downloadHar(ids?, filename?)` | `POST /api/har` |
| `api.doctor()` | `GET /api/doctor` → `ToolCheck[]` |
| `api.upload(file, { name?, onProgress?, signal? })` | `POST /api/upload` → `{ file }` (pass to `app-install`); errors keep the server `code` (`upload.tooLarge`…) |
| `api.fileUrl(name)`, `api.health()` | `/api/files/:name`, `/api/health` |

Also: `downloadUrl(url, name?)`, `downloadBlob(blob, name)`, `downloadText(text, name)`,
`pickFiles({ accept, multiple })`, `copyText(text)` in `components`.

### 4.6 Device removal and virtual devices

- **Removal**: the server only removes devices in `clear('all')` (gone / imported / desktop devices without a live
  app). Order on the wire: `cleared` (stores are cleared with the hub's predicate) → next `batch.removedDevices`. The
  data layer then drops those devices' **app sessions, processes and metric series** and re-validates the scope (an
  app scope on a removed device falls back to "all devices"). Features don't need to do anything.
- **`desktop`** — requests replayed from Dürbün (`net.replay`). Name it with `deviceDisplayName(d)` → "Masaüstü ·
  yeniden gönderilenler" / "Desktop · replays". No logs, no actions; its requests are visible in every scope.
- **`import:<n>`** — an imported `.durbun.json` (name starts with "📁 ", `state: 'disconnected'`,
  `stateCode: 'device.imported'`, `stateDetail: 'Imported from <file label>'`). A read-only recording: no device actions
  (`device.readOnly`), no app commands; don't present it as an unplugged device. The sidebar shows an
  "İçe aktarıldı" badge and the shell a read-only banner.
- **`net:<key>`** — an app connected over the network without a known device: `logs.code: 'logs.networkOnly'` (only
  SDK data, no device logs), no device actions (`device.networkOnly`); when its last app leaves it becomes
  `disconnected` with `stateCode: 'device.networkIdle'`.
- `isReadOnlyDevice(id)` (import / desktop) and `isNetworkDevice(id)` tell views when to hide device tools.

---

## 5. i18n

```ts
registerMessages('logs', {                       // namespace = your feature folder name
  tr: { pause: 'Duraklat', lines: { one: '{count, number} satır', other: '{count, number} satır' } },
  en: { pause: 'Pause',    lines: { one: '{count, number} line',  other: '{count, number} lines' } },
});
const t = useT();            // re-renders on language change
t('logs.pause'); t('logs.lines', { count: 12345 });   // "12.345 satır" / "12,345 lines"
```
- Placeholders `{name}`; `{name, number}` formats per language. Plurals `{ zero?, one, other }` use
  `params.count`. A message may be an array of candidates (`['{name} bağlandı', 'Cihaz bağlandı']`): the
  first whose params are present wins. Nested objects flatten with dots. Missing key → English → key
  (a dev warning is logged).
- `t` (non-reactive, current language) is fine in event handlers and in very hot render paths (log rows);
  a language change re-renders the whole app anyway. `translate(lang, key, params)` / `translateOr(lang, key, params,
  fallback)` work for an explicit language (`tOr` = `translateOr` in the current language).
- Server texts: `systemLineText(entry)` for `source: 'system'` lines, `noticeText(n)`,
  `tCode(code, params, englishFallback)` (`tCodeIn(lang, …)` for a fixed language), `deviceStateText(device)`,
  `logStatusText(device)`, `driverStatusText(driver)`, `deviceDisplayName(device)`, and `errorText(err)` (caught
  `CommandError`/`ApiError` → localized message that keeps the specific part of the server's English text as
  `{detail}`: "Kurulum başarısız oldu: INSTALL_FAILED_VERSION_DOWNGRADE"). `hasCode(code)` tells whether the UI has text.
- **Every code the server emits is localized** (`src/i18n/codes.ts`, list in `SERVER_CODES`: system lines, device
  states, log-stream codes, driver codes, notices, command/action errors and results, REST errors). Params are the
  ones the server really sends (SPEC §9.2): `device.connected {device, platform, kind, connection, osVersion}`,
  `device.disconnected {device, state, detail}`, `app.* {app, version, sdk, transport, device, failedRequests}`,
  `process.* {process, pid}`, `marker {label, n}`, `logs.stream* {via}`, `vm.* {app, url | reason | error}`,
  `settings.lanOn|lanOff {sdkPort, httpPort, restartRequired}`, `settings.adjusted {details}` (localized item by item).
  `src/i18n/codes.test.ts` fails when a code lacks TR/EN text, when the server source has a code the list misses, or
  when a system line rendered with real params leaves a `{placeholder}` or double space behind.
- Shared keys you may reuse: `common.*` (`copy`, `copied`, `clear`, `close`, `cancel`, `retry`, `search`,
  `filter`, `noMatches`, `levelHint.<level>`, `net.*`, `json.*`, `code.*`, `groups.<tab>` for palette groups).
- Turkish: natural, sentence case, correct ı/İ/ş/ğ/ç/ö/ü; terminology per SPEC §7.1 (Loglar, Ağ, Mock'lar,
  Temizle, Duraklat / Devam et, Canlı takip, İşaret ekle, İstek, Yanıt, Başlıklar, Gövde, Zamanlama,
  cURL olarak kopyala, Yeniden gönder, Mock oluştur…). Level names stay technical.
- `useLanguage()` → `'tr' | 'en'`. A test (`src/test/i18n-keys.test.ts`) fails when a literal
  `t('common|shell|code.…')` key is missing in either language; add a similar test for your namespace.

---

## 6. Components (`src/components`)

All accept `className`. Icons are lucide-react components (`IconType`), 16 px, stroke 1.75.

| Component | Key props |
|---|---|
| `Button` | `variant: 'primary'|'secondary'|'ghost'|'danger'|'subtle'`, `size: 'sm'|'md'|'lg'`, `icon`, `iconRight`, `loading`, `kbd` (combo hint), `fullWidth`, + button attrs/`ref` |
| `IconButton` | `icon`, **`label`** (aria-label + tooltip), `shortcut`, `size: 'xs'|'sm'|'md'`, `variant: 'ghost'|'subtle'|'solid'`, `active` (aria-pressed), `badge: boolean|number`, `tone`, `tooltipSide`, `noTooltip` |
| `Toggle` | `checked`, `onChange(bool)`, `label?`, `description?`, `size`, `disabled`, `aria-label` |
| `Checkbox` | `checked`, `onChange`, `label?`, `indeterminate?` |
| `SegmentedControl<T>` | `value`, `onChange`, `options: { value, label?, icon?, tooltip?, disabled? }[]`, `size` |
| `Chip` | `tone: 'neutral'|'accent'|'success'|'warn'|'danger'|'info'`, `size`, `icon`, `onRemove`, `onClick`, `active`, `mono` |
| `CountBadge` | `count`, `tone`, `max`, `showZero` |
| `StatusDot` | `tone`, `pulse`, `size`, `title` (+ class `dot--hollow`) |
| `TagChip` | `name` (stable hash color), `onClick` (filter), `onExclude` (Alt-click), `size`, `maxWidth` — memoized, cheap for rows |
| `LevelBadge` | `level`, `variant: 'pill'|'letter'|'text'` (`INFO`, `I`); `levelLabel(level, 'full'|'letter')` |
| `MethodBadge` / `StatusBadge` | `method` / `{ status?, state, error?, statusText? }`; `methodClass()`, `statusClass()` |
| `Tooltip` | `content`, `shortcut`, `side`, `align`, `delay` — wraps any child (`display: contents`) |
| `Popover` | `open`, `onClose`, `anchor` (ref or `{x,y}`), `side`, `align`, `width: number|'anchor'`, `autoFocus`, `role` |
| `Menu` / `DropdownMenu` | `items: MenuItem[]` (`{ label, icon?, shortcut?, hint?, danger?, disabled?, checked?, onSelect, keepOpen?, type?: 'item'|'separator'|'label' }`); `DropdownMenu` children = `(triggerProps) => <IconButton {...triggerProps} … />`; items may be a function |
| `openContextMenu(event, items)` | one shared context menu (cheap for virtualized rows) |
| `Dialog` | `open`, `onClose`, `title`, `description`, `icon`, `size: 'sm'|'md'|'lg'|'xl'|'full'`, `footer`, `initialFocus`, `autoFocusField`, `bare`, `closeOnOverlay` — focus trap, Esc, inert app, suppresses global shortcuts |
| `confirm(opts): Promise<boolean>` | `{ title, message?, confirmLabel?, cancelLabel?, danger?, icon? }` |
| `toast(...)` | `toast('Kaydedildi')`, `toast.success/info/warn/error(title, { description?, action?: {label, onClick}, duration?, id? })`, `toast.dismiss(id)`; duplicates collapse into ×N |
| `Tabs<T>` | `value`, `onChange`, `items: { value, label, icon?, badge?, disabled?, title?, shortcut? }[]`, `variant: 'pill'|'underline'`, `size`, `idPrefix` |
| `SplitPane` | `id` (persists size in prefs), `direction`, `sizedPane: 'first'|'second'`, `defaultSize`, `minSize`, `maxSize` (px or 0–1), `collapsed: 'first'|'second'|null`, **`overlayBelow` (default 900: the sized pane floats as an overlay on narrow containers)**, `onOverlayDismiss`; drag, arrow keys, double-click resets |
| `Toolbar`, `ToolbarSeparator`, `ToolbarSpacer`, `ToolbarGroup` | 40 px feature header row (`dense` → 34 px) |
| `SearchInput` | `value`, `onChange`, `placeholder`, `shortcut` (e.g. `['/', 'Mod+F']`), `shortcutEnabled`, `matches: {current,total}`, `onNext`, `onPrev`, `onSubmit`, `invalid`, `trailing`, `inputRef`, `mono`, `size` — Esc clears, then blurs |
| `Field`, `Input`, `Select`, `Textarea` | form primitives (`Input`: `size`, `mono`, `icon`, `trailing`, `invalid`; `Select`: `options`) |
| `Card`, `Callout`, `EmptyState` | `Callout tone: 'info'|'success'|'warn'|'danger'`, `title`, `actions`, `compact`; `EmptyState icon, title, description, actions, size, tone` |
| `KeyValueTable` | `rows: KeyValueRow[] | [k, v][]` (headers), `filterable`, `copyAll`, `mono`, `keyWidth`, `onRowContextMenu` |
| `JsonTree` | `data`, `rootLabel` ('data' → `data.items[0].id`), `defaultExpandDepth` (1), `search`, `toolbar`, `pageSize` (100), `maxStringLength` — lazy children, paging for 10k+ nodes, copy value/path (hover, right-click, Mod+C), ↑↓→← navigation |
| `CodeView` | `code`, `language: 'json'|'xml'|'html'|'javascript'|'css'|'plain'|'auto'`, `contentType`, `lineNumbers`, `wrap`/`defaultWrap`/`onWrapChange`, `toolbar` (true or extra node), `findable` (Mod+F), `maxHeight`, `highlightLimit` (150 000 chars) — virtualized above 1 500 lines |
| `CopyButton` | `value: string | () => string`, `label`, `text` (button style), `size`, `toastOnCopy` |
| `Highlight` | `text`, `query` or `ranges` → `<mark>`; `findRanges(text, query)` |
| `Kbd` | `combo` ("Mod+K" → ⌘ K / Ctrl K), `size` |
| `Spinner`, `Sparkline` | `Sparkline values, width, height, color ('var(--accent)'), fill, min, max` |
| `PlatformIcon`, `AndroidIcon`, `SdkBadge`, `sdkLabel`, `DurbunMark` | device/SDK identity |
| `ErrorBoundary` | `name`, `resetKey`, `fallback?` |

Helpers: `formatBytes`, `formatDuration`, `formatTime(ts, { format, base, prev })`, `formatClock`,
`formatOffset`, `formatRelative`, `formatDateTime`, `formatNumber`, `formatCompact`, `formatPercent` (all take
`{ lang }`); `jsonPath`, `tryParseJson`, `prettyJson`, `looksLikeJson`, `previewValue`, `valueToText`,
`detectCodeLanguage(contentType?, text?)`; `fuzzyMatch`, `fuzzyFilter`, `fold`; `hashHue`, `fnv1a`;
`notifyDesktop(title, { body, tag, onClick })` (respects `notifyOnCrash` + permission; only when the window is
not focused); `isMac`.

### Hooks

```ts
useShortcut(combo: string | string[], handler: (e) => void | false, opts?: {
  enabled?: boolean;        // default true
  allowInInputs?: boolean;  // default: true for Mod/Ctrl/Meta combos and Escape
  allowInModal?: boolean;   // default false (dialogs suppress global shortcuts)
  allowRepeat?: boolean;    // default false (set true for ↑/↓/j/k)
  preventDefault?: boolean; // default true
  priority?: number;        // higher first; ties → most recently registered first
})
```
Combos: `Mod` (⌘ on macOS, Ctrl elsewhere), `Ctrl`, `Alt`, `Shift`, letters, digits, symbols (`/`, `?` —
Shift-independent), `Space`, `Enter`, `Escape`, `Backspace`, `ArrowUp`/`Up`… Return `false` to pass the event
on. Space/Enter never fire while a button/link has focus. SPEC shortcuts owned by views: `/` or `Mod+F`
search, `Space` pause/resume, `M` marker (the shell has a low-priority fallback that adds a marker on the
scoped device — register your own to override), `Mod+Backspace` clear view (pass `allowInInputs: false`),
`↑/↓`, `j/k`, `Enter`, `Esc`, `G`. The shell owns `Mod+K`, `?`, `Mod+,`, `Mod+B`, `Mod+1..5`.

```ts
useCommands([{ id: 'logs.clear', title: t('logs.clear'), group: t('common.groups.logs'), icon: Trash,
  shortcut: 'Mod+Backspace', keywords: ['clear', 'temizle'], run: clear }]);
```
The palette reads the latest array whenever it opens (no memoization needed). Commands with a `shortcut`
also appear in the `?` help. Include Turkish and English keywords.

`usePersistentState(key, initial)` (localStorage `durbun.state.<key>`, never throws), `useEvent(fn)`,
`useElementSize(ref)`, `useMediaQuery(q)`, `useOutsidePointerDown(refs, fn)`, `useFeatureActive()`,
`useFeatureTab()`.

---

## 7. Styling

Import nothing: global CSS is loaded by `main.tsx`. Put feature CSS in your folder and import it from your
view (Vite bundles it). **Use tokens only — never hard-coded colors.**

**Tokens** (`src/styles/tokens.css`, dark + light): every SPEC §7.1 token — `--bg-app/panel/elevated/sunken/hover/active/selected`,
`--border`, `--border-strong`, `--text`, `--text-muted`, `--text-subtle`, `--accent`, `--accent-hover`,
`--accent-soft`, `--lv-verbose…fatal`, `--lv-warn-bg/error-bg/fatal-bg`, `--m-get…other`,
`--st-2xx…pending`, `--json-key/string/number/bool/null`, `--tag-l/--tag-c/--tag-bg-a`, `--radius-sm/--radius/--radius-lg`,
`--shadow-pop/--shadow-modal`, `--font-ui/--font-mono`, `--fs-xs…xl`, `--log-fs`, `--row-h`, `--sidebar-w`,
`--topbar-h`, `--statusbar-h`. Foundation extensions: `--success/--warning/--danger/--info` (+ `-soft`),
`--text-on-accent`, `--overlay-bg`, `--hl-mark`, `--hl-mark-current`, `--focus-ring`, `--input-bg`,
`--tooltip-bg/-text/-border`, `--code-keyword/fn/tag/attr/builtin/comment`, `--sdk-flutter|android|ios|rn|js|dart|demo`,
`--pick-red|orange|yellow|green|blue|violet|pink`, `--dur` (120 ms), `--ease`, `--z-sticky/overlay-panel/dialog/popover/tooltip/toast/drop`.

Hash-colored chip in custom markup: `style={{ '--h': hashHue(name) }}` with
`color: oklch(var(--tag-l) var(--tag-c) var(--h)); background: oklch(var(--tag-l) var(--tag-c) var(--h) / var(--tag-bg-a));`
(or just use `.tag-chip`). Level row backgrounds: `var(--lv-warn-bg)` etc.; level color via `.lvl--<level>`
or `var(--lv-<level>)`.

**Utility classes** (`base.css`): `row`, `col`, `center`, `between`, `wrap`, `items-start`, `items-stretch`,
`gap-1|2|3|4|6` (4/8/12/16/24 px), `grow`, `shrink-0`, `min-w-0`, `fill` (flex: 1 + min sizes 0),
`truncate`, `mono` (no ligatures), `tnum`, `muted`, `subtle`, `text-xs|sm|md|lg`, `medium`, `bold`,
`scroll-y`, `scroll-x`, `selectable`, `no-select`, `hidden`, `sr-only`, `tone-success|warn|danger|info|accent`.
`<mark>`/`.hl`/`.hl--current` are styled search highlights; `::highlight(durbun-find)` is styled for the CSS
Custom Highlight API.

Component classes you can reuse in custom markup: `.lvl .lvl--pill .lvl--info`, `.method .method--get`,
`.status .status--4xx`, `.tag-chip`, `.chip .chip--accent`, `.count-badge`, `.dot .dot--success`, `.kbd`,
`.btn .btn--ghost .btn--sm`, `.icon-btn .icon-btn--sm`, `.input .input--sm`, `.card`, `.callout .callout--warn`.

Layout: features sit inside the rounded main card (`--bg-panel`). Headers: a `Toolbar` (40 px). Lists:
monospace content at `var(--log-fs)`, row height `var(--row-h)`. Detail panes: `SplitPane` with
`sizedPane="second"` and an `id`. Below 900 px the sidebar collapses and SplitPane detail panes become overlays.

---

## 8. Conventions & pitfalls

- **Turkish locale**: `<html lang>` follows the UI language. NEVER use CSS `text-transform: uppercase` on
  technical tokens (in `lang=tr`, "info" → "İNFO"); write `GET`, `INFO`, `WARN` literally (`LevelBadge` does).
  For search/filter matching use plain `toLowerCase()`, never `toLocaleLowerCase('tr')`.
- Every icon-only button: `IconButton` with `label` (+ `shortcut` when it has one). Keyboard-first; visible
  `:focus-visible` rings come from `base.css` — don't remove outlines without a replacement.
- Calm UI: 120 ms transitions (`var(--dur)`), no decorative gradients/animations; badges call attention to
  new problems only (the top bar shows errors that arrived while a tab was hidden).
- Performance: read stores during render keyed on the version hook; compile the scope once per render
  (`useCompiledScope`); scan incrementally (by `lastId`/`generation`), never the whole ring per frame;
  throttle counters (`throttleMs`); pass `enabled: useFeatureActive()`.
- Long-running/async actions: `Button loading`, `toast.error(title, { description: errorText(err) })`.
- Dates/times in logs: `formatTime(ts, { format: prefs.timeFormat, base, prev })`; sizes/durations via
  `formatBytes`/`formatDuration` (they follow the UI language: "4,2 KB", "1,23 sn").
- Don't import from `src/shell/*` (shell internals may change); everything public is in the three barrels.
