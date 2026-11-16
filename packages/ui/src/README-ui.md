# Dürbün UI — foundation guide for feature engineers

This document is the contract between the UI foundation (shell, design system, data layer) and the
phase-2 feature views (`src/features/{logs,network,mocks,perf,device,flows}`; `features/transfer` holds the package
dialogs and Settings → Backup, not a tab). Everything here is implemented
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
  `perf`, `device`, `flows`). It is lazy-loaded (own chunk) and mounted inside `.feature`: an absolutely
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
- Window-wide drag-and-drop (and **Import a file…**) opens any Dürbün file by its `format` (first 64 KB,
  `sniffFormat` in `features/transfer/store.ts`): `durbun-session` → session import, `durbun-package` → the package
  import dialog (`transfer.openImport(text)`), `durbun-flow` → the Flows import dialog (`ui.importFlows(text)`). A
  feature's own file picker that may get a package (Flows, Mocks) accepts `.durbun` too and hands a package to the
  package dialog (`readPicked` / `sniffFormat`), which also brings its environments and mocks. If your view has its own drop zone (e.g. app
  install on the Device tab), put `data-dropzone` on the element; the global handler then ignores drops
  inside it and you handle `dragover`/`drop` yourself.

### 1.1 Network: stream entries (WebSocket, SSE)

- One `NetworkEntry` per connection, with `entry.stream` (`StreamInfo`: kind, state, counts, bytes, `dropped`,
  close / failure) once the server opened a stream for it; `entry.duration` stays the handshake's time. The server
  opens one only for an app that sends messages and was asked to (SPEC §6.1.1); any other 101 or bodiless
  `text/event-stream` response stays plain. `connectionKind(entry)` (`data/explain.ts`) recognises both, so filters,
  the type column, the actions and the flow picker treat a plain handshake as a connection too. Helpers live in
  `features/network/model/streams.ts`: `isStreamEntry`, `isLiveStream` (open and not an imported recording: an
  imported "open" connection does not run on), `streamAge` (live: until now; else until close / last message),
  `closeCodeKey` (RFC 6455 names, 3000–3999 library, 4000–4999 app), `buildMessageRows` (seq order, filters, a gap
  row wherever `seq` jumps; `head` when the gap follows the `STREAM_HEAD_KEPT` kept first messages).
- List: `StreamChip` (state icon + WS / SSE + growing count) next to the path (stream entries only); Size = message bytes; Time = how
  long the connection is / was open (ticks while live; handshake time in the tooltip). `is:stream|ws|sse|open`
  (TR `akış`, `açık`, `canlı`) and `type:stream` filter them.
- Detail: the **Messages** tab (`components/StreamMessages.tsx`) is the default for stream entries (own saved tab
  key `network.detailTab.stream`). Messages come only from `useStreamMessages(id)` (`data/streamMessages.ts`, paged
  after the newest seq held); the entry row's `stream` is the live truth for counts. Every state has its own
  text: loading, fetch failed (retry), SDK without the `streams` capability, capture off in Settings (button to
  Settings → Network), open with nothing yet, closed / failed without messages, all removed by limits, imported,
  request removed from memory, filters hide everything / only ping/pong so far. Messages removed by the limits are
  one quiet item on the counts line (the sentence and the why in its tooltip) and a gap row in place; the header
  keeps at least 12 message rows in view at 920 × 760.
- `ConnectionNote` replaces the request actions with one line: for a stream, that replay / edit / mock work on
  one-off requests (full reason in the tooltip); for a plain handshake, why it has no messages
  (`streamCaptureState`): the SDK does not capture them, capture is off (Settings), or the SDK captures them but had
  no hook on this socket (`net.response.noStream`, e.g. an Android socket opened without `DurbunWebSocketFactory`;
  the SDK's `noWebSocketFactory` line, `sdkNoteOf`, opens with "Show in Logs"; Logs words that line in the UI language, `sdkNoteText`). ping/pong are hidden by default
  (counted), the direction filter and the hide-ping/pong choice persist (`network.streamFilter`), the search does
  not (the list's body search seeds it).
- Availability: `networkActionAvailability(entry, action)` and `streamCaptureState(...)` in `data/explain.ts` are
  the only place deciding whether replay / edit and send / mock / compare / flow work and whether messages can
  arrive (the Flows "from requests" dialog lists only `canBecomeStep` entries); `features/network/actions.ts` (`canRun`, `actionBlockText`, `actionBlockHint`) turns them into
  disabled controls with a reason. Streams show one note in place of the action buttons, not dead buttons.
- Settings → Network → "Capture WebSocket and SSE messages" (`captureStreams`, absent = on) is shown only when
  the server reports the key.

### 1.2 Device: media library, app data, Wi-Fi pairing

- **Media library** (`features/device/media/`): screenshots and recordings a window takes are kept by the server
  under `<dataDir>/media` (`GET|DELETE /api/media[?deviceId=]`, `GET|DELETE /api/media/:id`, `MediaList`; 30 days,
  2 GB, 1000 items, oldest first past a limit). `store.ts` holds the list (`useMediaLibrary`, `ensureMedia`,
  `loadMedia`), the deferred delete with Undo (`deleteMedia`, 6 s, sent on `pagehide`) and the viewer state
  (`openMedia`, `openMediaRef`); it refreshes on the `media.*` log markers and on resync. `addFromReply` takes the
  `screenshot` / `screen-record` reply (`data.media`; an older server without it gives a window-only item).
  `Gallery.tsx` (tiles, status, policy line), `LibraryDialog.tsx` (all devices, device + kind filter, day groups,
  delete a device's items) and the lazy `MediaViewer.tsx` (newer / older, download, copy, delete, "Show in Logs";
  states: loading, gone, file missing, cannot play) are the only views. Logs: a marker line with
  `code: 'media.screenshot' | 'media.recording'` and `data.media` gets a camera / video icon and an "Open" button
  (`media/marker.tsx`, used by `LogRow`'s `MarkerRow`); `MediaViewerHost` is mounted in the Device and Logs views.
- **App data** (`AppData.tsx`, under the app actions): `app-data` copies the selected app's data folder into one
  `.tar.gz` (`AppDataPullData`; temp folder, 24 h). One copy per device at a time; the run, the last files and the
  last refusal live in `useAppDataPulls` (survive device switches). `appDataAvailability(device, app)` in
  `data/explain.ts` decides the row: blocked on a physical iPhone (Xcode's way said in its place), a "not a debug
  build" heads-up on Android (a hint, not a lock: the app list can miss the flag). Refusals about the phone or the
  app (`notDebuggable`, `notInstalled`, `locked`, `empty`) are a warning, others an error.
- **iPhone full report** (`IphoneReportCard.tsx`): text only — how to start sysdiagnose with the phone's buttons and
  where it lands; shown by `showsIphoneReportGuide(device)` in the "Report" section.
- **Pair over Wi-Fi** (`wireless/PairDialog.tsx`, Device toolbar and the no-device state while
  `wirelessPairingAvailable(drivers)`): `GET /api/android/wireless` (`AdbWirelessState`, read every 3 s while open),
  `POST …/pair` and `…/connect` (`AdbWirelessResult`: a refusal is 200 with `ok: false` and a code, bad input 400,
  no adb 503). After a pairing without an automatic connection it asks for the connection address. Dev mock:
  `dev/mock-wireless.mjs` (code `123456` pairs, `000000` is wrong, `10.*` is unreachable, `192.168.1.77` pairs
  without a connect service).

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

The mock also carries the phase-3 data: `snapshot.deviceApps` (Play, Firebase, a hand-installed APK, two "Runner"
apps on a USB iPhone), exact origins, dropbox / .ips crash records (one `duplicateOf`, one downloadable .ips), device
readers and SDK layers.
Flows, environments, packages, backups and UI prefs come from `dev/mock-flows.mjs`: an in-memory store with the real
REST shapes (sample flows tagged `smoke`, runs that pass or fail on purpose, nothing is written to disk). It also
answers set runs (`/api/flow-batches`, one finished `smoke` set seeded), versions (`/api/flows/:id/history`, three
seeded for `login`), deleted flows (`/api/flow-trash`, one seeded), `/api/flows/schema` and
`/api/flows/from-requests` (it reads the mock's own `/api/network/:id`). `packages/server/test/flows/mockContract.test.ts`
compares these answers with the real handlers, so the mock cannot drift from them unnoticed.
`--no-flows` starts with no flows (the Flows welcome page and starters). The showcase lines (seeded once) cover
SDK earlier-launch reports, the low-memory killer, startup times, navigation and lifecycle lines, too-large
bodies and a self-signed server for replay; Pixel's Pati has a clock 47 s behind the Mac, Kasa a newer SDK protocol.
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
(0.3 s → 5 s). Every (re)connect syncs: `hello` → `snapshot` → `history` chunks → live `batch`es. Old data stays
visible while disconnected.

**Resume** (`data/resume.ts`): a reconnect continues this window's copy instead of loading everything again. The
snapshot's `epoch` (changes with every clear) and `netSeq` (also from batches) plus the newest log id held go on the
WS URL (`/ui?epoch=…&afterLogId=…&netSeq=…`). When the server answers with `resumed` for the same epoch, the stores
are kept: only newer lines arrive as history, requests that changed are upserted, requests the server deleted
meanwhile are dropped (`networkStore.retainIds`), and requests that ended while away give their log rows the outcome's
level. Any other snapshot (no epoch: the dev mock and older servers, another epoch after a clear) clears and replaces
everything as before; `forgetResume()` makes the next connection load everything. `useConnection(s => s.resumed)` says
which of the two the latest sync was (the status bar's connection tooltip mentions a resume); `onResync` fires either
way, so derived caches must not assume the stores were emptied (check `logStore.generation` instead).

```ts
useConnection(s => s.status)   // 'connecting' | 'syncing' | 'live' | 'reconnecting'
useConnection(s => s.resumed)  // the latest sync continued this window's data (see Resume)
useConnection(s => s.server)   // ServerInfo | null (version, ports, demo, lan, hostAddresses…) — `demo`/`lan` are
                               // values at connect time: use useDemoActive() / useServerSettings(s => s.settings.allowLan)
isConnected(status)            // syncing || live
reconnectNow()
onResync(() => resetMyDerivedCaches())   // fired on every snapshot, resumed or not
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
| `entries: LogEntry[]` | ordered by `id` (arrival order, SPEC §4); ring trimmed at `maxEntries` (the server's `limits.maxLogEntries`, else its `maxLogEntries` setting; `setMaxEntries`) |
| `version` | frame-coalesced change counter |
| `generation` | bumped on reset / arbitrary removal (`cleared`) — drop index-based caches when it changes |
| `headDropped` | entries trimmed from the head since the last reset (absolute index = `headDropped + i`) |
| `dropped` | entries the limits deleted since the last reset. With a server that reports its evictions it is the server's count (`followServer(evictions)` also drops the lines below the server's `oldestLogId`); otherwise this window's own head trims minus crash records moved to `kept`. Views show it per scope through `useScopeEvictions()` (4.3) at the oldest edge ("the oldest N lines were dropped") |
| `levelRevision` / `setNetworkLevel(netId, level)` | a network log row takes its request's outcome level when the outcome arrives (`networkLogLevel` from `@durbun/protocol`, applied in `data/dispatch.ts` after `networkStore.upsert`; the hub does the same for its copy). The entry object is replaced and counts follow; `RowModel` re-runs its filters on a `levelRevision` change without a new `build` (scroll and selection stay) |
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
`generation`, `dropped` (requests the limits deleted since the last reset; the server's count when it reports one), `maxEntries` / `setMaxEntries` (the server's `maxNetworkEntries`), `retainIds(ids)` (a resumed sync), `isNetworkError(e)`. Log rows with `kind: 'network'` carry `netId` — render them from
`networkStore.get(netId)` so status/duration update live.

**`metricsStore`** (`MetricsStore`): `series: Map<key, MetricSeries>` where
`MetricSeries = { key, deviceId, appId?, pid?, samples: MetricSample[] (≤ 3600, ts-ordered), updatedAt }`;
`metricSeriesKey({deviceId, appId?, pid?})` → `"<deviceId>|<appId>"` or `"<deviceId>|pid:<pid>"`;
`get(key)`, `seriesFor(target)`, `latest(key)`, `keys()`.

**The UI trims to the server's limits.** `hello` and `settings` carry `limits` (`StoreLimits`: `maxLogEntries`,
`maxNetworkEntries`, the log memory budget); `dispatch.applyLimits` sets both stores' `maxEntries` from them (from the
settings when a server sends none), so a window never holds more than the server does. Snapshots, batches and
`cleared` carry `evictions` (`StoreEvictions`: totals, `logsByBytes`, per app / per process counts, `oldestLogId`,
last evicted timestamps); `applyEvictions` makes both stores follow them and puts them in `useStoreLimits`.

Counters & rates (throttled hooks): `useScopedLogCounts(throttleMs = 250)`,
`useScopedNetworkCounts(throttleMs = 250)`, `useIngestRate()` → `{ logsPerSec, requestsPerSec, history: number[60] }`,
`useNow(intervalMs)`.

### 4.3 zustand stores

| Hook / API | State |
|---|---|
| `useConnection` | see 4.1 |
| `useHub` | `{ devices: Record<id, DeviceInfo>, apps: Record<id, AppSession>, drivers: DriverStatus[], processes: Record<deviceId, Record<pid, ProcessUpdate>> }` |
| `useDevices()` / `useDevice(id)` | sorted device list (live → demo → imported; disconnected last) / one device |
| `useApps()` / `useApp(id)` / `useAppGroups()` | sessions; `AppGroup` = one app on one device: its sessions (`latest?` — undefined for SDK-less apps, `sessions` newest first, `connected`) joined with the device's report (`deviceApp?`, `running`, `lastActivity`). `groupApps(apps, deviceApps)`; order: running first (by name), then most recently active. `appGroupName(g)` |
| `useDrivers()`, `useDemoActive()`, `useProcessName(deviceId, pid)`, `useIsEmpty()` | `useDemoActive()` follows the demo driver's live status |
| `useHub(s => s.deviceApps)` / `useDeviceApp(key)` | apps the **device** reports (SPEC §10, `DeviceApp`, key `'<deviceId>\|<bundle id>'` = `deviceAppKey()`), with or without an SDK. Activity-only bumps (`lastActivity` < 10 s) are coalesced and do not re-render |
| `isImportedDevice(id)`, `isNetworkDevice(id)`, `isReadOnlyDevice(id)`, `DESKTOP_DEVICE_ID` | virtual-device helpers (see 4.6) |
| `useScope()` / `setScope(scope, hint?)` / `getScope()` | current scope (see 4.4); persisted; validated after every resync |
| `useMocks(s => s.rules \| s.revision \| s.conflict)` / `saveMocks(rules, { overwrite? })` / `resolveMocksConflict('reload' \| 'overwrite')` | mock rules; `saveMocks` = `mocks.set` (optimistic, reverts on error) with the `revision` this window loaded as `baseRevision`. Another window's save in between is refused (`mocks.conflict`): `rules` shows the server's list and `conflict` keeps the attempted one until the view asks "reload" or "save mine anyway" (see Edit conflicts in 4.5) |
| `useStoreLimits(s => s.limits \| s.evictions)` | the server's `StoreLimits` and `StoreEvictions` (4.2); both null with a server that sends none (the dev mock), then the stores count their own trims |
| `useScopeEvictions()` / `scopeEvictions(compiled, evictions, local?)` | what the limits deleted from the current scope: `{ logs, requests, logsByMemory, lastLogTs?, lastRequestTs?, approximate }` (an app scope counts its sessions and its processes' device lines; `approximate` = this window's own trims, every scope). Show a quiet note at the oldest edge of a list when above 0 |
| `useFlows(s => s.summaries \| s.runs)` | flow list (WS `flows`) and live runs by id (WS `flowRun` deltas merged by step id, `applyFlowRunDelta`); `rememberFlowRun(run)` stores a REST copy unless a newer live copy exists; `latestRunOf(runs, flowId)` |
| `useTransfer` / `transfer` (`features/transfer/store.ts`) | package dialogs: `transfer.openExport('share' \| 'backup', flowIds?)`, `transfer.openImport(text?, fileName?)`, `transfer.close()`; session / HAR export dialog: `transfer.openDataExport('session' \| 'har', { ids?, label?, fileName? }?)` (scope + counts, "mask secret values" on by default; `ids` fixes the requests, e.g. the Network tab's visible rows). Never start an export download without it |
| `useBugReport` / `bugReport` (`features/report/store.ts`) | "Report a bug" (SPEC §12): `bugReport.open({ kind: 'log', logId } \| { kind: 'request', netId } \| { kind: 'now' })` from every entry point (crash banner and notification, log and request detail panels and context menus, both Share dialogs, ⌘K, the top bar button); `bugReport.close()` keeps the note (`draft`), `bugReport.done()` clears it once the report left (saved, copied, sent). The dialog decides the scope from the anchor (`bugScope`), the window (`bugWindow`, ≤ 10 min), the lines and requests (`collectLogs` / `collectRequests`) and the Markdown (`buildBugReport`) in `features/report/model.ts`; never build a bug report elsewhere |
| `useServerSettings(s => s.settings)` / `updateServerSettings(patch)` | `ServerSettings`; update = `settings.update` (optimistic) |
| `usePrefs` | UI prefs, persisted to localStorage (`durbun.prefs.v1`); shared by every window of the same address (see "Several windows" below) |
| `useUi` / `ui` | active tab + global screens: `ui.setTab(id)`, `ui.openPalette()`, `ui.openSettings(section?)`, `ui.openDoctor()`, `ui.openSdkGuide(tab?)`, `ui.openShortcuts()`; cross-feature navigation: `ui.focusLog(logId)`, `ui.focusNetwork(netId)`, `ui.focusMock(ruleId)`, `ui.newMockFromDraft(draft)`, `ui.newFlowFromRequests(ids)`, `ui.importFlows(text)` set `useUi(s => s.focus)` (`UiFocus` with a `seq`) and switch tabs — the target view handles it in an effect keyed on `focus?.seq`, then calls `ui.consumeFocus(seq)`. A jump must never overwrite the user's filters or prefs: Logs suspends only the filters that hide the line ("Show in context" also those hiding its neighbours) behind a "Back to my filters" bar (`features/logs/model/reveal.ts`); Network clears them with a 10 s "Back to my filters" toast action |

`UiPrefs` fields: `theme ('system'|'dark'|'light')`, `language ('tr'|'en')`, `logFontSize (11–16)`,
`density ('compact'|'comfortable')`, `timeFormat ('absolute'|'relative'|'delta')`, `wrapLines`,
`showNetworkInLogs`, `hideNoise`, `noiseRules: NoiseRule[]`, `highlightRules: HighlightRule[]`,
`notifyOnCrash`, `sidebarCollapsed`, `panelSizes: Record<string, number>`, `lastTab`.
**Several windows** (the Mac app's windows, browser tabs) share one localStorage. The rule:
- `durbun.prefs.v1`: a window writes only the keys it changed over what is stored now (`mergePrefsWrite`; panel
  sizes per pane), so it never puts back another window's older choice. Shared keys follow other windows live (the
  `storage` event, `sharedPrefsChange`). `WINDOW_KEYS` (`lastTab`, `panelSizes`, `sidebarCollapsed`) stay as this
  window has them; the stored value is only where a new window starts.
- `durbun.scope.v1` (device / app scope): read once at load, then per window; the last window to change it decides
  where the next one starts.
- `durbun.state.*` (`usePersistentState`: Network's body search and pretty print, Compare's options, the Flows
  minimap and inspector, the logs query, the SDK guide's repo folder) and `durbun.palette.recent`: read when the
  view mounts, written on change, never followed live — the newest choice is what the next view starts with.
- A new address (the Mac app moved from `localhost` to `127.0.0.1`, another port) starts empty: `prefsSync` takes the
  server's copy back once (`restorePatch`, portable keys only) with an Undo toast, before it sends anything, and
  never when the user changed something here first or another window stored preferences meanwhile.
- Saved log filters (`features/logs/model/savedFilters.ts`, `useSavedFilters`) keep their old storage key
  `durbun.state.logs.savedFilters` (nothing to migrate), follow other windows through the `storage` event and ride in
  the preference copy as `logSavedFilters`: backups and packages carry them, and filters that come in are added to
  the ones here (`mergeSavedFilters`: same name + query once, a taken name gets " (2)"), never put in their place.

Write with `usePrefs.getState().setPref(key, value)` / `updatePrefs(patch)`. `DEFAULT_NOISE_RULES`,
`HIGHLIGHT_COLORS` are exported. `<html>` already reflects theme (`data-theme`), density
(`data-density` → `--row-h`), font size (`--log-fs`) and `lang`.

`NoiseRule = { id, field: 'tag'|'process'|'message', match: 'exact'|'prefix'|'contains', value, enabled }`;
`compileNoiseRules(rules) → (entry) => boolean` (device logs only; app/system lines are never noise).
`HighlightRule = { id, pattern, regex, caseSensitive, color: 'red'|'orange'|'yellow'|'green'|'blue'|'violet'|'pink', enabled }`
— colors are tokens `var(--pick-<color>)`.

### 4.4 Scope

```ts
type Scope =
  | { kind: 'all' } | { kind: 'device'; deviceId: string }
  | { kind: 'app'; appId: string; exact?: boolean }
  | { kind: 'deviceApp'; deviceId: string; bundleId: string };   // SDK-less app the device reports
const compiled = useCompiledScope();     // stable until the scope's MEMBERSHIP changes (compiled.key) — not on stats churn
compiled.logs(entry); compiled.network(entry); compiled.metrics(series);
compiled.key; compiled.deviceId; compiled.bundleId; compiled.appIds; compiled.app; compiled.deviceApp
compileScope(scope, { apps, deviceApps?, processes? }) / entryInScope(entry, scope) / networkInScope(entry, scope)
scopeLogCounts(compiled, logStore) / scopeNetworkCounts(compiled, networkStore)
scopeLogTotal(compiled, logStore)        // every line the scope shows (an app scope's device lines too): exports, clear
scopeDisplayName(scope, hub)             // "All devices" / device name / "App · Device"
scopeSignature(scope, hub) / scopeAppRef(scope, hub) / scopeDeviceId(scope, hub) / scopeTarget(scope, hub) → { device, app, deviceApp, bundleId }
```
Use `compiled.key` as the memo key for scans (it changes when the app's sessions, pids or process names change).

- **device**: entries of that device. Markers are visible in every scope. Network entries replayed from
  the desktop (`deviceId: 'desktop'`) are visible in every scope.
- **app** (default): **all sessions of that app (same bundle id) on that device** — relaunches and hot
  restarts stay in view, separated by lifecycle lines. Logs match when `appId` is one of those sessions;
  device lines without `appId` match by process name (`app.id`, `processName`, `"<app.id>:…"`
  sub-processes), else by pid. Device-level system lines (`device.*`, `logs.*`) and `process.*` lines of the
  app's process are included.
- **app with `exact: true`** (picked from "earlier sessions" in the sidebar): only that session; device lines
  match by pid when the session has one.
- **deviceApp** (an app row without an SDK session — store / Firebase / old builds): device lines whose `pid` is
  one of the app's pids (`DeviceApp.pids` + pids the process list attributed to it), or whose `process` is the bundle
  id / `"<id>:…"` / `DeviceApp.processName`, device crash records naming the package (`data.package|bundleId`), plus
  every SDK / VM session of the same app that connects later. A process name another app on the device shares
  (iOS "Runner") matches only together with the app's own pid. App scopes also include the device's report of the
  app. Log counters for device-app scopes are counted by predicate, incrementally. Persisted like the others; after a
  resync it stays while the device reports the app (or a session exists), else falls back to the device.

### 4.4b "Where does this come from?" (SPEC §10.5, `src/sources/`)

- `explainSources({ device, deviceApp, sessions })` (`data/explain.ts`, pure, the only place the rules live) →
  `{ badge, rows[logs|network|metrics|crashes|mocks|tools] {status, sources, reasons, actions}, notes, context }`.
  Extra exports: `buildBadgeOf()`, `buildKindOf()`, `explainContext()`, `explainRow()`,
  `screenshotAvailability(device)` (`yes | noDevice | imported | offline | unsupported`: whether "Report a bug" can take
  a fresh screenshot, and the reason it shows when not), `hiddenDeviceCards(device)` (the Device tab's actions an
  online physical iPhone cannot offer yet and why: developer mode, devicectl, screenshot tool, screen recording,
  syslog; shown by `features/device/HiddenCards.tsx`, which links to the System check).
- `src/sources/`: `useAppExplain(groupKey)`, `useScopeExplain()`, `pickEmptyReason(capability, scope, {includePartial})`,
  `<SourceBadge badge short?>`, `<BuildBadgeChip>`, `<SourcesPanel item>`, `<WhatCanISeeButton groupKey>` (the ⓘ popover),
  `<ScopeSourcesButton>` (top bar), `<ExplainEmpty capability fallback onAction? includePartial?>` (renders the reasons when
  the scoped app(s) structurally cannot have the capability, else `fallback`), `<ExplainCallout capability>`,
  `<DataSourcesDialog>` ("Veriler nereden gelir?", `ui.openDataSources()`), texts: `reasonText(reason, ctx, capability?)`,
  `entrySourceText(entry)` / `originLabel(origin)` (log origins), `isDeviceCrashRecord`, `isUnsymbolicated`.
- Inputs beyond the session and the device app: `DeviceInfo.readers` (crash records / frame stats that cannot be read →
  `crashReportsUnavailable` / `frameStatsUnavailable`, worded from the reader's `code` under `code.reader.*`, else its
  English `detail`), `sdk.layers` (`nativeLayerActive` / `nativeLayerMissing` notes, `native-layer` source), Android
  installers (`otherStoreKind`: Galaxy Store, AppGallery, GetApps, Amazon; the package installer = `apk` badge, not a
  store build). `net:` devices get no device-side sources; the demo is explained like the device it stands for
  (`context.demo`, `demoData` note).
- Crash empty states: `<CrashRecordsNote onlyProblems?>` ("none yet" vs "this device's records cannot be read") under
  the Logs empty states and `is:crash` / `is:anr` queries; `<FrameStatsNote deviceId>` above a polled process's
  Performance tiles. The log detail panel offers «İndir (.ips)» for `data.reportUrl` (`crashReportDownload`, only
  `/api/files/crash/…`, not for imports) with a short symbolication note.
- `ui.openSdkGuide(tab, section?)` scrolls to `'release' | 'native' | 'vm'` (`data-sdk-section` in the guide).
- Dürbün.app: `html[data-desktop='mac']` (+ `data-desktop-fullscreen`) styles the window drag areas and the
  traffic-light inset (`styles/shell.css`, end of file); the desktop app only sets the attributes.

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
(`screenshot`/`list-apps`/`app-uninstall` 60 s, `app-install` 300 s, `screen-record` duration (else the 600 s limit) + 120 s, `screen-record-stop` 180 s);
`net.replay` 40 s.

`api` (REST, same origin; `ApiError { status, message, code? }`):

| Function | Endpoint |
|---|---|
| `api.getNetworkDetail(id, signal?)` | `GET /api/network/:id` → `NetworkDetail` (bodies) |
| `api.bodyUrl(id, 'request'|'response', { download? })` | raw body URL (for `<img src>`, download links) |
| `api.searchNetwork(text, { ids?, caseSensitive?, signal? })` | `POST /api/network/search` → `string[]` |
| `api.exportUrl({ deviceId?, appId?, bundleId?, mask? })` | `GET /api/export` URL. Masked unless `mask: false` (adds `mask=0`); a masked file ends with `"masked": true`. An app scope exports by `deviceId` + `bundleId` (every session plus its device lines), an exact one by `appId` (`scopeExportParams` in `features/transfer/dataExport.ts`) |
| `api.importSession(input, signal | { name?, signal? })` | `POST /api/import?name=<file name>` → `ImportResult { deviceIds, imported?, dropped?, evicted? }` (a `File` sends its own name; the server labels the imported devices with it). `shell/actions.ts` warns when `dropped` / `evicted` is above 0 and links to Settings → Logs. A `.har` (or a `.json` that `looksLikeHar`) is converted with `harToSession` (`@durbun/protocol`) and sent through the same call: requests only, no logs, no device actions |
| `api.harExport(ids?, { mask?, signal? })` / `api.downloadHar(ids?, filename?, { mask? })` | `POST /api/har` `{ ids?, mask? }`: no `ids` = every request; masked unless `mask: false` (`log._durbun.masked`) |
| `api.bugReport(req)` → `{ blob, fileName, skipped }` | `POST /api/bug-report` (`BugReportRequest`): one .zip with `report.md`, `logs.txt`, `requests.har`, the screenshot, an iOS crash report and `recording.durbun.json` of the window; masked unless `mask: false`; `skipped` names parts the server could not add (`X-Durbun-Skipped`). `api.exportUrl` also takes `fromTs` / `toTs` on the server (a bad value: `export.invalidTime`) |
| `api.doctor()` | `GET /api/doctor` → `ToolCheck[]` |
| `api.upload(file, { name?, onProgress?, signal? })` | `POST /api/upload` → `{ file }` (pass to `app-install`); errors keep the server `code` (`upload.tooLarge`…) |
| `api.fileUrl(name)`, `api.health()` | `/api/files/:name`, `/api/health` |
| `api.listFlows()`, `getFlow`, `createFlow`, `saveFlow(id, flow, { baseUpdatedAt? })`, `deleteFlow`, `duplicateFlow`, `preflightFlow`, `runFlow`, `listFlowRuns`, `getFlowRun`, `cancelFlowRun`, `getFlowEnvironments`, `saveFlowEnvironments(envs, { overwrite? })`, `aiPack`, `previewFlowImport`, `importFlows`, `flowFromRequests` | `/api/flows*`, `/api/flow-runs*`, `/api/flow-environments` (SPEC §11). `baseUpdatedAt` / the environments' `revision` make a save refuse another window's newer copy (see Edit conflicts) |
| `api.exportPackage(req)` → `{ blob, fileName }`, `api.inspectPackage(text, passphrase?)`, `api.importPackage(req)` | `/api/packages/*` (`.durbun` share / backup) |
| `api.getBackup()`, `updateBackup(patch)`, `runBackup()`, `backupSuggestions()`, `backupFiles()`, `readBackupFile(name)`, `getUiPrefs()`, `putUiPrefs(prefs)` | Settings → Backup and the server copy of the portable UI prefs (`features/transfer/prefsSync.ts` keeps it current) |
| `api.slackStatus()`, `api.updateSlack(patch)`, `api.sendToSlack(text)` | `/api/slack` (Send to Slack; never returns the webhook URL). Prefer `useSlackStatus()` / `updateSlack()` from `data` and the `SlackButton` component, which converts a share report with `toSlackText` (`lib/slack.ts`) |

**Edit conflicts.** Mock rules, flows and flow environments are saved against the copy this window loaded:
`mocks.set` with `baseRevision`, `saveFlow` with `baseUpdatedAt` (the loaded flow's `updatedAt`), and
`saveFlowEnvironments` with the `revision` the GET returned (left in the document). When another window saved in
between, the server refuses with `mocks.conflict` / `flow.conflict` / `env.conflict` (409 for REST);
`isEditConflict(err)` recognizes all three. Never overwrite by yourself: show a choice that says what each option
discards — load the current version (this window's edits are dropped, or kept as a draft where the view has one) or
save mine (`overwrite: true` / no `baseUpdatedAt`, the other window's change is lost) — and keep the user's edits
until they pick. The flow editor (`useFlowDocument`: `save === 'conflict'`, `keepMine()`, `loadTheirs()`, which keeps
this window's version as a draft), the environments dialog and the Mocks tab follow this; `setActiveEnvironment`
re-applies only the choice on the current copy.

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
| `Card`, `Callout`, `EmptyState` | `Callout tone: 'info'|'success'|'warn'|'danger'`, `title`, `actions`, `compact`; `EmptyState icon, title, description, actions, size, tone ('neutral'|'accent'|'danger'|'success': success when the message is that nothing is wrong)` |
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
not focused); `isMac`. Crash notifications are the shell's (`shell/crashNotify.ts`, mounted in `App`): every
connected device, any tab; features do not notify for crashes themselves.

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
`--text-on-accent`, `--accent-fill`/`-hover` and `--danger-fill`/`-hover` + `--text-on-danger` (filled controls with
text on them: primary / danger buttons, numbered badges; AA in both themes, `badgeContrast.test.ts` reads the
button rules), `--overlay-bg`, `--hl-mark`, `--hl-mark-current`, `--focus-ring`, `--input-bg`,
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
- Contrast: `styles/contrast.test.ts` keeps `--text-muted` and `--text-subtle` at 4.5:1 or more on every background
  token in the dark, light and OS-fallback blocks (and subtle below muted). Change those tokens only with that test.
- Keyboard: the sidebar is one Tab stop (roving `tabIndex`, arrows, Home / End, `i` opens "Ne görebilirim?" on an app
  row); the network grid is focusable with `aria-activedescendant`, and Shift+F10 / the ContextMenu key opens the
  selected row's menu. Keep both when changing those views.
- Crash banners: `isBannerCrash` (`features/logs/live.ts`) = crashes plus memory kills by the system
  (`data.termination` jetsam / low-memory, `is:oom` in queries); Flutter layout overflow (`isLayoutError`) is a
  quiet error, never a crash banner.
- Performance charts: a drag selects a time range (`TimeChart onSelectRange`); `features/perf/RangeBar.tsx` links to
  the first error, the logs and the requests of that range (`rangeContents`).
- Flows: one-click starter flows live in `features/flows/model/starters.ts` (each must pass `validateFlow`);
  `model/aiFeedback.ts` turns import problems into English text for the AI and diffs an imported flow against the
  one it replaces. Pinned runs (`model/pins.ts`, `setRunPinned`): the run history popover pins and unpins, a 409
  `flowRun.pinLimit` is said with `errorText`; the `flows` broadcast carries no run headers, so lists follow
  `usePinRevision` and read the runs again. "Clear history" (`api.clearFlowRunHistory`) keeps pinned runs and says so.
  "Flow from requests" reads the focus's `visibleIds` / `filterLabel` / `from`: where the requests came from, and
  "select the N visible" when the caller's list was filtered.
- Set runs ("run my smoke flows"): REST in `features/flows/model/setsApi.ts` (same `ApiError` as `data/api.ts`), the
  store in `model/sets.ts` (`useSets` running / recent / byId; `useSetsSync(active)` reads the list when the tab
  shows and every second while a set runs: there is no WS message for sets, a `flowRun` with an unknown `batchId`
  tells a window that another one started a set), words and the Markdown report in `model/batch.ts` (pure, tested).
  Entry points: the list head menu (pick flows, a tag, recent sets), a row's tags, the palette. `BatchDialog` checks
  each flow with its preflight (blocked flows and hard-to-undo steps show as "will be skipped" before the start);
  `BatchView` replaces the editor (`setView` in `index.tsx`) while a set is shown; a set that ends while another
  view is open says so in a toast. "Share with runs…" opens the share package with the set's runs preset
  (`transfer.openExport('share', flowIds, { runs, name })`). A run of a set shows a "Set run" chip in the run panel.
- Deleting a flow moves it to the server's trash (`deleteFlowToTrash`): the toast has Undo (`restoreTrashed`), only a
  flow other flows call asks first. `TrashDialog` lists, restores and removes for good. `VersionsDialog` (More menu,
  palette) lists `flowHistory` with what each save changed (`model/versions.ts`); Restore saves the editor first,
  then the toast's Undo restores the version the restore kept.
- Package notices (`features/transfer/notices.ts`, `packageNoticeText`): `package.flow.invalid` / `.problems` are
  worded from `params.issue` (a flow check code) and `package.mock.invalid` from `field` + `expected`, never from the
  English `problem`.
- Sidebar fit (`shell/sidebarFit.ts`): below 1000 px the sidebar folds to its rail by itself and opens again with
  room; below 900 it is an overlay. A toggle on a tight window holds until the width crosses 1000 again and is not
  saved; `sidebarCollapsed` is the wide-window choice and always wins.
- "SDK away" (`ExplainContext.sdkAway`, reason `sdkDisconnected`): the same build's SDK connected earlier in this
  session and the app still runs. Badge stays SDK (outlined), the rows say what comes back on reconnect, no build
  advice; a different version / build or debug-vs-release falls back to the device-only explanation.
- Empty Network list of one app, four cases: connected and cleared ("liste temizlendi", from the server's `cleared`
  messages kept in `sources/cleared.ts`), connected with nothing yet ("henüz ağ isteği göndermedi" + a setup hint),
  SDK away (`awayTitle` + what comes on reconnect), no SDK (the structural reasons). The view's own "no
  DurbunInterceptor" state still comes first.
- Mac app prefs: `shell/desktopPrefs.ts` reads `window.durbunDesktop.prefs` (`get` / `set`, refreshed on the
  `durbun:command` event `prefs-changed`; `null` = not asked yet). Without the bridge the Settings rows are hidden.
- Mac app server settings: `shell/desktopConfig.ts` reads `window.durbunDesktop.config` (`get` / `set` with a
  `ConfigPatch`, `null` = back to the default; re-read on `config-changed`) and `relaunch()`. A field whose
  `source` is `env` shows the variable and cannot change; `pending` waits for a restart, which always asks first.
- SDK lines with a known shape (`features/logs/model/appEvents.ts`): `app-exit` (Android ApplicationExitInfo) and
  `app-diagnostics` (iOS MetricKit) reports of an earlier launch are worded per reason (`logs.exit.*`); a
  low-memory one counts as `is:oom`, an ANR one as `is:anr`. `navigation` events (`is:nav`) and Flutter lifecycle
  lines render as quiet separator rows (`MomentRow`).
- Launch time (`durbun.launch`, native Android / iOS SDKs, `launchOf`): a quiet `MomentRow` ("Soğuk açılış 1,24 sn",
  prewarmed in words, no time) and the Performance tab's "Açılış" tile for the app's newest launch
  (`LogTraffic.launches`), with the start point (`processStart` / `launchRequest`) in the tooltip. Unknown `kind`s
  stay plain event lines.
- Frame phases follow the app (`perf/model.ts framePlatformOf`): Flutter "Build" / "Raster", native Android "UI
  thread" / "RenderThread". Flutter and Android count only drawn frames: a sample without `fps` is an idle screen
  (`framesIdleWhenAbsent`), never 0 FPS or "does not report".
- Flow canvas (`flows/model/viewport.ts`): when the canvas shrinks (run panel, window) a flow that was all on screen
  is fitted again and gets its view back when the canvas grows; the minimap moves to the top-right corner, then
  hides, rather than sit on a node.
- App sessions (`sources/session.ts`): `sdkProtocol`, a `protocolMismatch` badge with what to update, and the device
  clock when it is more than 5 s off the Mac (`clockSkewOf`; app info, log details, one line above the log list).
  Log times are never corrected.
- Network: `NetworkEntry.tooLarge` is not a failed request in the list (status cell icon, no red row); the detail says
  what was too large and the limit (`tooLargeMessage`). Replay TLS notices are said in place, not as global toasts.
- AI pack (`api.aiPack`): `include.issues` / `include.lastRun` (default on) and `issues` (the editor's, at most
  `AI_PACK_MAX_ISSUES`). A flow with problems or a failed last run offers "Fix with AI" (More menu, run panel).
