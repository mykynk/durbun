# Dürbün — Product & Engineering Spec (v0.1)

> "Dürbün" = binoculars (Turkish). Identifier in code/packages: `durbun`. Display name: **Dürbün**.
> This spec is the contract every contributor (human or agent) builds against. Data shapes live in
> `packages/protocol/src/index.ts` (source of truth). Server-internal contracts live in
> `packages/server/src/types.ts`. Do not change either file's existing signatures; if you truly need
> something extra, add an OPTIONAL member and say so in your report.

---

## 1. Product

A desktop tool (runs on the developer's Mac, UI in a browser/app window) for mobile developers. Plug an
Android or iOS device in over USB (or run a simulator/emulator) and watch, in ONE live, readable UI:

- **All device logs** — Android logcat (all processes), iOS device syslog, iOS simulator unified log.
- **App logs** — structured logs, errors, crashes and custom events sent by the Dürbün SDK inside the app
  (Flutter, Android/Kotlin, iOS/Swift, React Native/JS) or — for Flutter debug builds with no SDK —
  pulled automatically from the Dart VM Service.
- **Network** — every HTTP(S) request/response with headers, bodies, timings (SDK or Dart VM Service).
- **Performance** — CPU, memory, FPS / janky frames over time.
- **Act** — filter/search, mock responses / inject latency / simulate failures, replay requests,
  screenshots, deep links, app launch/stop/clear-data/install, dark mode, font scale, push to simulator,
  location, export/import/share sessions.

Primary users: a Turkish team building **Flutter** apps for Android + iOS on macOS. Secondary: native
Android (Kotlin/OkHttp), native iOS (Swift/URLSession), React Native.

UI language: **Turkish by default** (when `navigator.language` starts with `tr`, else English), fully
translated to English, switchable at runtime.

Out of scope for v0.1: MITM proxy, screen mirroring, Windows/Linux-specific testing (keep code portable
where it's cheap).

### 1.1 Readability principles (non-negotiable — the user explicitly asked for this)

While logs stream at hundreds of lines per second, a developer must be able to understand what is going
on at a glance:

1. **Level is visible instantly**: colored level pill + colored left edge; warn/error/fatal rows get a
   subtle background tint. Errors never look like info.
2. **Who said it**: tag and process shown as stable, hash-colored chips (same tag = same color always).
   Source (device log vs app SDK vs Dürbün system line) has a distinct small icon.
3. **No walls of text**: multi-line messages collapse to the first line + "+N lines"; stack traces fold
   to "▸ 24 frames" with the app's own frames highlighted and framework frames dimmed; JSON payloads are
   detected and shown as a compact preview, expandable to a tree.
4. **Noise control**: one toggle hides known-noisy system tags/processes (editable list); identical
   consecutive lines fold into one row with a ×N counter.
5. **Structure in time**: app start/stop, SDK connect/disconnect, device connect/disconnect and
   user-inserted markers render as full-width separator rows. Network requests can appear inline in the
   log stream as compact rows (`→ GET /api/users 200 · 123 ms · 4.2 KB`), clickable.
6. **Calm live view**: auto-follow while at bottom; scrolling up pauses following and shows a
   "↓ 57 new" pill; explicit Pause freezes the view without losing data.
7. **Crashes are loud**: crash/ANR/Flutter-error entries are visually distinct (red block, icon) and
   raise a banner with "jump to crash".
8. **Typography**: monospace for log content (JetBrains Mono bundled), adjustable size (11–16 px) and
   density (compact/comfortable), wrap toggle, absolute/relative/delta timestamps.
9. **Every value is copyable**, every filter is one click away (click tag → filter; alt-click → exclude).
10. **Show in context**: from any filtered result, jump to the same row in the unfiltered stream.

---

## 2. Architecture

```
 ┌──────────── device / simulator ────────────┐            ┌────────────────── desktop (Mac) ───────────────────┐
 │ app + Dürbün SDK ── NDJSON/TCP ────────────┼─adb reverse┼─▶ per-device port ┐                                 │
 │   (Flutter/Kotlin/Swift/RN)  ◀─ usbmux ────┼────────────┼── usbmux Connect  ├─▶ SDK layer ─▶ Hub (store,    │
 │   simulator: 127.0.0.1:9751 directly ──────┼────────────┼─▶ :9751 TCP ──────┘     batching) ─▶ WS /ui ─▶ UI │
 │   RN: ws://localhost:9750/sdk ─────────────┼────────────┼─▶ WS /sdk                  ▲           REST /api   │
 │ Dart VM Service (debug Flutter) ◀──────────┼─adb fwd/usbmux── Flutter VM module ──────┤                      │
 │ logcat / syslog / os_log ──────────────────┼─adb/idevicesyslog/simctl─ platform drivers┘                      │
 └────────────────────────────────────────────┘            └────────────────────────────────────────────────────┘
```

- **Server** (`packages/server`, Node ≥ 20, TypeScript, ESM): device discovery + log streaming
  (platform drivers), SDK ingestion, Dart VM Service bridge, in-memory store (Hub), HTTP/WS API, demo
  data generator, CLI. Bundled by esbuild into `dist/durbun.mjs`.
- **UI** (`packages/ui`, React 19 + Vite 8 + TypeScript + zustand + @tanstack/react-virtual): built into
  `dist/ui`, served by the server at `http://localhost:9750`.
- **SDKs** (`sdks/*`): Flutter/Dart package, Android library (Kotlin), iOS Swift package,
  React Native/JS package. All speak the same wire protocol (§6).

### 2.1 Ports

| Port | Bound on | Purpose |
|---|---|---|
| 9750 | 127.0.0.1 (0.0.0.0 when `allowLan`) | HTTP: UI static, REST `/api/*`, WS `/ui` (UI), WS `/sdk` (JS/RN SDK) |
| 9751 | 127.0.0.1 (0.0.0.0 when `allowLan`) | Generic raw-TCP NDJSON SDK listener (simulators, LAN) |
| dynamic | 127.0.0.1 | One per Android device: `adb -s S reverse tcp:9751 tcp:<dyn>` so the server knows which device a connection came from. Also `adb reverse tcp:9750 tcp:<device gateway>` (for RN WS). |
| dynamic | 127.0.0.1 | Device gateway, the target of `adb reverse tcp:9750`: WS `/sdk` and `GET /api/health` only. A reversed connection arrives from 127.0.0.1, so the HTTP port (which trusts loopback with `/api` and `/ui`) is never the target. |
| 9752–9755 (on device) | device 127.0.0.1 | On-device SDK listener (iOS physical devices). Desktop reaches it with usbmux `Connect`. |

### 2.2 Device ids

`android:<adb serial>` · `ios:<udid>` (physical) · `ios-sim:<udid>` · `demo:<n>` · `import:<n>`
(imported sessions) · `net:<key>` (SDK connected over LAN without a known device) · `desktop` (requests
replayed from the desktop).

---

## 3. Repository layout & ownership

```
/SPEC.md                         this file (owner: lead)
/package.json                    npm workspaces root (owner: lead)
/packages/protocol/src/index.ts  shared types (owner: lead — read-only for others)
/packages/server/
  src/types.ts                   server-internal contracts (owner: lead — read-only)
  src/version.ts, src/util/logger.ts   (owner: lead — read-only)
  src/platform/**  (except flutterVm)  Android/iOS drivers            → agent "server-platform"
  src/platform/flutterVm/**            Dart VM Service bridge         → agent "server-vm"
  src/hub/**, src/sdk/**, src/demo/**  store, SDK protocol, demo data → agent "server-hub"
  src/http/**, src/server.ts, src/cli.ts, src/config.ts, src/doctor.ts, scripts/** → agent "server-http"
  test/platform/** test/vm/** test/hub/** test/http/**  (each agent its own folder)
/packages/ui/                    shell + design system + data layer → agent "ui-foundation";
  src/features/logs/**           → agent "ui-logs"      (phase 2)
  src/features/network/**, src/features/mocks/** → agent "ui-network" (phase 2)
  src/features/device/**, src/features/perf/**   → agent "ui-device-perf" (phase 2)
/sdks/flutter/                   → agent "sdk-flutter"
/sdks/android/                   → agent "sdk-android"
/sdks/ios/                       → agent "sdk-ios"
/sdks/js/                        → agent "sdk-js"
/scripts/, /bin/                 → agent "server-http" (dev/build/launch scripts)
```

Never edit files outside your ownership. If you need a change elsewhere, describe it in your report.

---

## 4. Data model

See `packages/protocol/src/index.ts`. Key rules:

- `LogEntry.id` is a global monotonically increasing integer assigned by the Hub. **The UI orders logs by
  `id` (arrival order)**, not by `ts` (device clocks differ). `ts` is epoch milliseconds (fractional ok).
- Device timestamps are kept as reported by the device (logcat/syslog/SDK all use the device clock).
- System lines (`source: 'system'`) carry an i18n `code` + `params`; `message` is the English fallback.
  Codes used by the server: `device.connected`, `device.disconnected`, `app.connected`,
  `app.disconnected`, `app.reconnected`, `process.started`, `process.died`, `marker`,
  `logs.streamStarted`, `logs.streamStopped`, `logs.streamError`, `vm.attached`, `vm.detached`.
- When the Hub receives `net.request` it ALSO appends a `LogEntry` with `kind: 'network'`,
  `netId` = the network entry id, `level: 'info'`, `tag: 'network'`, `message: '<METHOD> <url>'`. The UI
  renders such rows from the live `NetworkEntry` (status/duration update as the response arrives). This
  gives correct interleaving of network events in the log timeline for free.
- Network bodies are NOT pushed to the UI; the UI fetches `GET /api/network/:id` on selection.

---

## 5. Server

### 5.1 Wiring (`src/server.ts`, owner server-http)

```ts
const config = await loadConfig(dataDir)            // settings.json + mocks.json in ~/.durbun (or --data-dir)
const hub = createHub({ settings, logger })        // src/hub/index.ts
const sdk = createSdkLayer({ hub, logger, settings: () => config.settings, mocks: () => config.mocks, serverVersion })
const platform = createPlatform()                  // src/platform/index.ts → { drivers, services }
const vm = createFlutterVmModule()                 // src/platform/flutterVm/index.ts
const demo = createDemoDriver()                    // src/demo/index.ts
ctx: DriverContext → start all platform drivers (each must degrade gracefully when its tool is missing),
vm.start({ ...ctx, platform: platform.services }), demo.start(ctx) if --demo / demo.set
await sdk.listen(ports.sdk, allowLan ? '0.0.0.0' : '127.0.0.1')
startHttp(...)                                       // src/http/**
```

Graceful shutdown on SIGINT/SIGTERM: stop drivers (kill child processes: logcat, idevicesyslog,
`log stream`), remove adb reverse/forward mappings created by us, close sockets, flush config.

### 5.2 Hub (`src/hub/**`, owner server-hub)

In-memory store + change batching. Interface: `Hub` in `types.ts`.

- **Logs**: ring buffer of `settings.maxLogEntries` (default 200 000). Assigns `id`, `deviceId`,
  `source`. For device logs: fills `process` from the pid map when missing; sets `appId` when
  `(deviceId, pid)` matches an app session's `app.pid`.
- **Lifecycle lines** (system source) are generated automatically for: device connect/disconnect, app
  (SDK) connect/disconnect/reconnect, process start/death for processes whose name equals the `app.id`
  or `processName` of any app session ever seen on that device or listed in `settings.watchedApps`.
- **Network**: `netRequest/netResponse/netError` merge into `NetworkEntry` (id = `<appId>:<sdk id>`).
  Derive `host`, `path`, content types (from headers), sizes (`body.size`), `duration`
  (`endTs - startTs`), `graphql` (request JSON body with a `query` string → operation type/name).
  Response before request → create the entry with `method: '?'`. Keep at most
  `settings.maxNetworkEntries` (drop oldest with bodies) and at most `settings.maxBodyStoreMB` of bodies
  (evict oldest bodies first → `bodyEvicted: true`). On app disconnect, still-pending requests become
  `failed` with `error: 'App disconnected before the response arrived'` (a later response for the same id
  still upgrades it to `complete`).
- **Metrics**: ring per (deviceId, appId ?? pid), 3600 samples.
- **Processes**: per device `pid → {name, event, ts}`; exposed through `ProcessUpdate`s.
- **Batching**: changes are coalesced and flushed to subscribers every 100 ms (or immediately when 2 000
  logs are queued). Network/devices/apps are coalesced by id (latest state wins).
- **Export/import**: `SessionExport` (see protocol). Import loads entries under new `import:<n>`
  virtual devices (ids re-assigned, names prefixed "📁 ") so imported data never collides with live data.

### 5.3 SDK layer (`src/sdk/**`, owner server-hub)

Implements the wire protocol (§6.1) for raw streams (NDJSON), WebSockets (JSON text frames) and in-process
virtual sessions (used by the Flutter VM module and the demo driver).

- First message must be `hello` within 10 s, else close. Unknown/invalid messages are ignored (debug log).
- **Device resolution** for a new session: `meta.deviceId` (transport knows it: adb reverse per-device
  port, usbmux) → else `hello.device.simulatorUdid` → `ios-sim:<udid>` → else an existing device whose
  platform/model/name matches unambiguously → else upsert a `net:<platform>-<model>-<name>` device
  (`kind: 'physical'`, `connection: 'wifi'`).
- Register/reuse an `AppSession` (same `sessionKey` + device → reuse, mark connected, `app.reconnected`).
- Reply `welcome` with `appId`, `SdkConfig` (`deviceLogsAvailable` = that device's `logs.status ===
  'streaming'`) and the mock rules applicable to the app (`rule.apps` empty or contains `app.id`).
- `ping` every 15 s; close after 45 s without any inbound data.
- `mocks.set` from the UI → broadcast `{type:'mocks'}` to every connected session (filtered per app).
- `sendCommand(appId, name, params)` → `{type:'command', id}`; resolves on `command.result` (timeout 10 s).
- `event` messages become logs: `kind:'event'`, `tag:'event'`, `message: name`, `data: props`,
  `level:'info'`. `metric` → `MetricSample` (`source: 'sdk'`, or `'vm-service'`/`'demo'` per transport).
- Size limits: 16 MiB per NDJSON line / WS frame; bodies already truncated by SDKs (trust `size`).

### 5.4 HTTP / WS API (`src/http/**`, owner server-http)

Static UI: serve the built UI dir (`--ui-dir` → `<bundle dir>/ui` → `<repo>/dist/ui`), SPA fallback to
`index.html`, long-cache hashed assets. If no UI build exists, serve a minimal page explaining
`npm run build`.

**Security**: `/ui` WS and every `/api/*` request must come from a loopback address AND (if an `Origin`
header is present) from an allowed origin (`http://localhost:<port>`, `http://127.0.0.1:<port>`,
`http://localhost:5173`, `http://127.0.0.1:5173`). Reject others with 403. (Prevents random websites in
the developer's browser from reading app traffic.) `/sdk` accepts any origin.

WS `/ui`: on connect send `hello`, `snapshot`, then the full log buffer as `history` chunks of 5 000
(`done: true` on the last), then live `batch`es from the Hub, `cleared`, `mocks`, `settings`, `drivers`,
`notice`. Commands (`UiToServer`) are answered with `reply` (see protocol for reply data shapes).
Routing: `device.action` → the driver that `owns(deviceId)`; `app.action` → `sdk.sendCommand`;
`vm.attach/detach` → VM module; `demo.set` → start/stop demo driver; `metrics.watch` → driver
`watchMetrics`; `net.replay` → perform the request from the desktop with `fetch` (30 s timeout, no
redirects follow? → follow; record via `hub.recordDesktopRequest` on device `desktop`, source `replay`),
reply with the new `NetworkEntry`.

REST:

| Method & path | Result |
|---|---|
| `GET /api/health` | `{ ok: true, name: 'durbun', version }` (used by the CLI to detect a running instance) |
| `GET /api/network/:id` | `NetworkDetail` (with bodies) |
| `GET /api/network/:id/body/request` · `/response` | raw bytes, original `Content-Type`; `?download=1` adds `Content-Disposition` |
| `POST /api/network/search` `{ text, ids?, caseSensitive? }` | `{ ids: string[] }` (searches URL, headers and bodies) |
| `POST /api/har` `{ ids?: string[] }` | HAR 1.2 JSON (all when no ids) as download |
| `GET /api/export?deviceId=&appId=` | `SessionExport` JSON download (`durbun-<date>.durbun.json`) |
| `POST /api/import` (body = SessionExport JSON) | `{ deviceIds }` |
| `GET /api/doctor` | `ToolCheck[]` (all drivers' `checks()` + ports + node version) |
| `POST /api/upload?name=<file>` (raw body, ≤ 2 GB streamed to tempDir) | `{ file }` server path to pass to `app-install` |
| `GET /api/files/:name` | files saved in tempDir (screenshots, recordings) |
| `GET /api/files/crash/:udid/:name` | copied iOS crash reports (phase 3): udid `/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/`, name `/^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}\.ips$/i` without `..`, realpath must stay inside `<tempDir>/crash/<udid>/`; always `Content-Disposition: attachment`, `text/plain`, `nosniff`; same /api access rules |

The UI document, every static file, 304s and the "please build the UI" page carry a Content-Security-Policy:
scripts only from the server (inline scripts are hashed at startup and re-hashed when index.html changes; no
`'unsafe-inline'` for scripts), `connect-src` names `ws://<Host>`, `img-src` / `media-src` allow `blob:` and
`data:`, plus `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.

### 5.5 Platform drivers (`src/platform/**`, owner server-platform)

`createPlatform(): Platform` → drivers `android`, `ios-sim`, `ios-device` + `PlatformServices`.
Every external command is spawned with `execFile`/`spawn` (never through a shell), with timeouts, and
every failure is reported as data (device `logs.status`, `DriverStatus`, `ToolCheck`), never a crash.

**Tool resolution**
- adb: `settings.adbPath` → `$ANDROID_HOME|$ANDROID_SDK_ROOT/platform-tools/adb` →
  `~/Library/Android/sdk/platform-tools/adb` → `adb` on PATH.
- idevicesyslog / idevicescreenshot: `settings.idevicesyslogPath` → PATH (incl. `/opt/homebrew/bin`,
  `/usr/local/bin`) → **Flutter's cache**: resolve `flutter` on PATH (follow symlinks; also scan
  `~/fvm/versions/*`, `~/flutter`, `~/development/flutter`) →
  `<flutter>/bin/cache/artifacts/libimobiledevice/idevicesyslog`, run with `DYLD_LIBRARY_PATH` =
  `artifacts/{libimobiledevice,libimobiledeviceglue,libplist,libusbmuxd,openssl}` joined by `:`.
- simctl / devicectl: `xcrun simctl`, `xcrun devicectl` (Xcode ≥ 15).

**Android (`android` driver)**
- Poll `adb devices -l` every 2 s (after `adb start-server`). States: device/offline/unauthorized
  (`stateCode: 'device.unauthorized'` → UI tells the user to accept the RSA prompt).
- Device info: `getprop` (model, manufacturer, release, sdk, `ro.kernel.qemu`/serial prefix → emulator),
  `dumpsys battery` (every 30 s), `wm size`, `wm density`. Wi-Fi adb serials (`ip:port`, `adb-…._tcp`) →
  `connection: 'wifi'`.
- Logcat: `adb -s S logcat -v threadtime -v epoch -v printable -T <settings.logcatTail>` (verify the exact
  output format; parse epoch AND classic `MM-DD hh:mm:ss.mmm` / year formats robustly; ignore
  `--------- beginning of …`). Merge consecutive lines with an identical header (ts, pid, tid, level,
  tag) into one multi-line entry (hold the pending entry ≤ 60 ms). Restart with backoff when the process
  exits while the device is online, resuming with `-T <last epoch>` and de-duplicating the boundary.
- Grouping/classification: Flutter error boxes (tag `flutter`, from a line containing
  `══╡ EXCEPTION CAUGHT BY` to the closing `════…` line) → one entry `kind: 'flutter-error'`,
  `level: 'error'`. `AndroidRuntime` `FATAL EXCEPTION` → `kind: 'crash'`, `level: 'fatal'`. Native
  tombstones (tag `DEBUG`, `*** *** ***` … ) grouped per pid within 2 s → `kind: 'crash'`.
  `ActivityManager` `ANR in <pkg>` → `kind: 'anr'`, `level: 'error'`.
- Pid → process: initial `adb shell ps -A -o PID,NAME` (fallback plain `ps`), refresh (debounced 1 s)
  when unknown pids appear; parse ActivityManager `Start proc <pid>:<pkg>/…` → `setProcess(started)`,
  `Process <pkg> (pid <pid>) has died` / `Killing <pid>:<pkg>/…` → `setProcess(died)`.
- SDK routing: per online device create a 127.0.0.1 listener on a dynamic port,
  `adb -s S reverse tcp:9751 tcp:<dyn>` and `adb -s S reverse tcp:9750 tcp:<device gateway port>` (never the HTTP port, see §2.1); hand accepted
  sockets to `ctx.sdk.attachStream(socket, { transport: 'adb-reverse', deviceId })`. Re-apply when lost;
  remove on stop.
- Actions (only list those that work for the device): `screenshot` (`exec-out screencap -p`),
  `open-url` (`am start -a android.intent.action.VIEW -d`), `list-apps` (`pm list packages -3`
  [+ `-s` when includeSystem], mark debuggable when cheap), `app-launch` (`monkey -p pkg -c
  android.intent.category.LAUNCHER 1`), `app-stop` (`am force-stop`), `app-restart`, `app-clear-data`
  (`pm clear`), `app-uninstall`, `app-install` (`install -r -t -d`), `logs-clear-buffer`
  (`logcat -c`), `logs-restart`, `appearance` (`cmd uimode night yes|no`), `font-scale`
  (`settings put system font_scale`), `animations` (three `*_animation_scale` settings),
  `input-text` (escape for `input text`), `key-event`, `location` (emulator: `emu geo fix lon lat`),
  `screen-record` (optional: `adb shell 'echo $$; exec screenrecord --time-limit 180 …'` until
  `screen-record-stop` sends SIGINT to that pid on the device, then pull; a screen whose long side is over
  1920 px is recorded with `--size` scaled to 1920, since encoders refuse more: "Encoder failed (err=-38)").
- Metrics (`watchMetrics`): every 2 s `top -b -n 1 -p <pid> -o %CPU,RES` (verify toybox columns) or
  `dumpsys meminfo <pid>` (TOTAL PSS) → `pushMetrics` (`source: 'adb'`).

**iOS simulator (`ios-sim` driver)**
- Poll `xcrun simctl list devices booted -j` every 3 s (only booted devices are online; remove/mark
  disconnected on shutdown).
- Logs: `xcrun simctl spawn <udid> log stream --style ndjson --level <iosSimLogLevel>` with, when
  `iosSimLogScope === 'apps'`, a predicate limiting to user-installed apps
  (`processImagePath CONTAINS "/Containers/Bundle/Application/"`) — verify on a real simulator. Skip
  non-JSON lines. Map `messageType` Default/Info→info, Debug→debug, Error→error, Fault→error (`fatal` is reserved for real crashes). Process =
  basename(processImagePath); tag = `subsystem` (+ `category` field) when present, else
  basename(senderImagePath). Lines from process `Runner` (or any) starting with `flutter: ` → strip the
  prefix, `tag: 'flutter'`. Apply the same Flutter error-box grouping.
- Simulator processes are host processes → metrics via `ps -o %cpu=,rss= -p <pid>` (`source: 'host'`).
- Actions via simctl: `screenshot` (`io <udid> screenshot --type=png`), `open-url` (`openurl`),
  `list-apps` (`listapps`, plist → parse), `app-launch`, `app-stop` (`terminate`), `app-restart`,
  `app-clear-data` (wipe contents of `get_app_container <udid> <bundle> data`, after terminate),
  `app-uninstall`, `app-install` (`.app` dir; unzip `.zip` first), `appearance` (`ui <udid> appearance`),
  `font-scale` (`ui <udid> content_size` mapping), `push-notification` (`push <udid> <bundle> <json file>`),
  `location` (`location <udid> set lat,lon`), `status-bar` (`status_bar override --time 9:41
  --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3` / `clear`), `logs-restart`,
  `screen-record` (optional: `io <udid> recordVideo` until SIGINT).

**iOS physical (`ios-device` driver)**
- usbmux client in Node (`/var/run/usbmuxd`, 16-byte little-endian header + XML plist, message type 8):
  `ListDevices` + persistent `Listen` for Attached/Detached; `Connect` (port in network byte order) for
  tunnels; `ReadBUID`/`ReadPairRecord` if needed. Device name/model/OS via lockdown `GetValue` without a
  session when possible (`QueryType` first), fallback `xcrun devicectl list devices --json-output`.
- Logs: `idevicesyslog -u <udid> --no-colors` (resolved as above). Parse
  `Mon DD HH:MM:SS(.ffffff) <device name> <process>(<image>)[<pid>] <Level>: message`; device names may
  contain spaces (use the known device name); continuation lines without a header append to the previous
  entry; strip ANSI; assume current year (handle Dec→Jan). If unavailable: `logs.status: 'unavailable'`,
  `code: 'logs.idevicesyslogMissing'` and a doctor fix (`brew install libimobiledevice`).
- SDK tunnel: every 2 s, for each attached device and each port 9752–9755 without an active session, try
  usbmux `Connect`; on success hand the tunnel to `ctx.sdk.attachStream(stream, { transport: 'usbmux',
  deviceId })`. If a tunnel closes without traffic within 3 s, back off that port to 10 s.
- Actions via `xcrun devicectl` where possible: `list-apps` (`device info apps`), `app-launch`
  (`device process launch`), `app-stop`, `app-restart`, `app-install` (`device install app`),
  `app-uninstall`, `open-url` (`device process launch --payload-url`), `screenshot` (try
  `idevicescreenshot`; report a clear error when the device refuses), `screen-record` (`device capture
  screen-record` without `--duration`, until SIGINT; needs a devicectl that has it).
- Screen recording (all platforms, `platform/shared/screenRecord.ts`): one per device, from `screen-record`
  until `screen-record-stop`, the optional `durationSec` or the platform limit (Android 180 s, iOS 600 s);
  both replies carry the file and `DeviceInfo.recording` is set while it runs.

**PlatformServices.forwardToDevice(deviceId, devicePort)** — Android: `adb forward tcp:0 tcp:<port>`
(parse the allocated port; dispose → `adb forward --remove`). iOS simulator: identity
(`127.0.0.1:<port>`). iOS device: local `net.Server` on 127.0.0.1:0 that pipes every connection through a
usbmux `Connect` to the device port.

### 5.6 Flutter VM module (`src/platform/flutterVm/**`, owner server-vm)

Zero-integration capture for Flutter **debug/profile** builds through the Dart VM Service (JSON-RPC 2.0
over WebSocket).

- `attach(input)`: accepts a VM service http/ws URL, a DevTools URL (`?uri=`), or a whole pasted block of
  `flutter run` output (find the first matching URL). Normalize to `ws://host:port/<token>=/ws`. Follow
  HTTP redirects (the VM service redirects clients to DDS when `flutter run` is attached). Opens a
  **virtual SDK session** (`ctx.sdk.openVirtual({ transport: 'vm-service', deviceId })`) and sends a
  `hello` (`sdk.platform: 'dart-vm'`, app name/id from the isolate/VM, `pid` from `getVM`).
- Streams: `Logging` (dart:developer `log()` — never visible in device logs!) → `log` messages (map
  `level` int to LogLevel, `loggerName` → tag, `error`/`stackTrace` → error); `Extension` events
  `Flutter.Frame` → FPS/jank metrics, `Flutter.Error` → `kind: 'flutter-error'`; `Stdout`/`Stderr` only
  when the device has no streaming device logs; `Isolate` stream to re-enable profiling after hot restart.
- HTTP: `ext.dart.io.httpEnableTimelineLogging {enabled: true}`, poll `ext.dart.io.getHttpProfile`
  (`updatedSince`) every 1 s, `ext.dart.io.getHttpProfileRequest` for bodies of finished requests; emit
  `net.request` / `net.response` / `net.error` (source `vm-service`). Verify method names/shapes against
  the installed Dart SDK (`<flutter>/bin/cache/dart-sdk/lib/io/network_profiling.dart`, `_http`).
  Skip network capture for an isolate whose pid already has an SDK session with the `network`
  capability on the same device (avoid duplicates).
- Metrics: `getMemoryUsage` every `metricsIntervalMs` (heap+external → `heapMB`).
- App actions (advertised in `hello.actions`, executed when the virtual session receives `command`):
  `flutter.debugPaint`, `flutter.repaintRainbow`, `flutter.slowAnimations` (`ext.flutter.timeDilation`
  5.0/1.0), `flutter.performanceOverlay`, `flutter.invertOversizedImages`, `flutter.brightness`
  (light/dark/system), `flutter.platform` (android/iOS/macOS/default), `flutter.dumpWidgetTree`,
  `flutter.dumpRenderTree` (output arrives via logs).
- Auto-attach (when `settings.autoAttachVmService`): watch `ctx.onLogs` for
  `The Dart VM service is listening on http://…` / `Observatory listening on …`; forward the device port
  via `PlatformServices.forwardToDevice` (Android, iOS device; simulator is direct) and attach; detach the
  previous session of the same device+app when a new URL appears (restart). Never crash on failures —
  emit a `notice` and a `vm.*` system line.

### 5.7 Demo driver (`src/demo/**`, owner server-hub)

`--demo` (or UI `demo.set`) adds two virtual devices ("Pixel 8 · Demo" Android, "iPhone 16 Pro · Demo"
iOS simulator) and, through virtual SDK sessions, two apps (a Flutter app `com.mykynk.demo` and a
second one). It must produce **realistic** traffic so the UI can be built and judged without hardware:
logcat-like system noise (ActivityManager, chatty, OpenGLRenderer, ViewRootImpl, …), Flutter `flutter`
lines, JSON logs, Dart and Java stack traces, a Flutter error box now and then, a rare crash/ANR, app
lifecycle, custom events, REST JSON calls (lists, details, auth, uploads), images, a GraphQL endpoint,
4xx/5xx, slow (> 2 s) and failed (timeout/DNS) requests, mocked responses honoring mock rules, metrics
(CPU/mem/FPS/jank) with plausible variation. Rate: ~20–60 lines/s with bursts. Supports app commands
(acknowledge `flutter.*` toggles) and device actions (screenshot → generated PNG/SVG placeholder,
others → ok).

### 5.8 CLI / config / doctor (owner server-http)

`durbun [--port 9750] [--sdk-port 9751] [--lan] [--demo] [--no-open] [--data-dir ~/.durbun]
[--ui-dir PATH] [--verbose]`.
- Prints a friendly banner (URL, what to do next). If the port is taken by another Dürbün
  (`/api/health`), just open the UI and exit; otherwise a clear error.
- Opens the UI: on macOS prefer an **app window** (`open -na "<Browser>" --args --app=<url>`) using
  the first installed of Google Chrome, Brave Browser, Microsoft Edge, Arc, Chromium; else `open <url>`.
- Config: `<dataDir>/settings.json` (ServerSettings), `<dataDir>/mocks.json` (MockRule[]); written
  atomically; `settings.update`/`mocks.set` persist and broadcast.
- Doctor: aggregates driver `checks()` + port availability + Node version → `ToolCheck[]` with Turkish-
  friendly `fix` commands (the UI localizes labels; `fix` is a shell command or short English text).

---

## 6. SDKs

### 6.1 Wire protocol (all SDKs)

- Framing: **NDJSON** over TCP (one JSON object per line, UTF-8, `\n`), or one JSON object per **text
  frame** over WebSocket (`ws://<host>:9750/sdk`). Message types: `SdkToServer` / `ServerToSdk` in the
  protocol file. First message: `hello`. Wait for `welcome` before considering the connection active.
- Timestamps: epoch ms (device clock). Body capture: honor `config.captureBodies` and
  `config.maxBodyBytes` (truncate `data`, keep real `size`, set `truncated`). Text-like content types
  (json, text/*, xml, html, javascript, x-www-form-urlencoded, graphql) → `utf8`, everything else →
  `base64`. Never break the app's own request/response streams (tee, don't consume).
- **Transport strategy** (whichever completes the hello/welcome handshake first becomes active; others
  closed):
  1. client → `127.0.0.1:9751` (Android device/emulator via adb reverse, iOS simulator, desktop);
  2. client → user-configured host (`DURBUN_HOST` / option) for Wi-Fi;
  3. **iOS physical device only**: listen on `127.0.0.1:<9752..9755>` (first free) and accept the
     desktop's usbmux connection (accept only when no active connection; close extras immediately).
  Reconnect with backoff (0.5 s → max 3 s) forever while enabled; keep a ring buffer of the last 5 000
  outgoing messages while disconnected and flush on (re)connect (then log a warn line with the number of
  dropped messages, if any).
- `hello.session`: random id per app launch. `hello.device.simulatorUdid`: `SIMULATOR_UDID` env var
  (iOS simulator). `hello.app.pid`: own pid.
- Keepalive: answer `ping` with `pong`.
- **Mocks** (capability `mocks`): apply the first enabled rule that matches (`mockRuleMatches` semantics
  in the protocol file — identical in every SDK). `respond` → synthesize the response without touching
  the network (after `delayMs`); `delay` → wait then perform the real request; `fail` → raise the
  platform's natural error (timeout / connection refused / DNS / TLS) after `delayMs`. Report the
  request normally with `mocked: true, mockRuleId`.
- **Commands** (capability `commands`): handle `command` → reply `command.result`. Unknown → `ok:false`.
- **Metrics** (capability `metrics`): every `config.metricsIntervalMs` send `metric`.
- **Release safety**: SDKs are no-ops in release/production builds unless explicitly forced, and never
  crash or slow down the host app (all I/O off the main thread/isolate where applicable, bounded queues,
  swallow internal errors).
- `deviceLogsAvailable` (in `config`): when true, the desktop already sees the app's stdout through
  device logs, so SDKs that would otherwise capture stdout/print should not duplicate it (Flutter print
  capture follows this flag; native iOS `print` is never in syslog, so iOS captures stdout regardless).

### 6.2 Flutter (`sdks/flutter/durbun`, package `durbun`)

```dart
import 'package:durbun/durbun.dart';

Future<void> main() async {
  await Durbun.run(() async {               // zone: captures print (if needed), uncaught errors
    WidgetsFlutterBinding.ensureInitialized();
    runApp(const MyApp());
  }, options: const DurbunOptions(/* host: '192.168.1.20', enabled: kDebugMode, ... */));
}
// or without a zone: Durbun.init(options); runApp(...);
Durbun.log('Kullanıcı giriş yaptı', tag: 'auth', data: {'userId': 42});
Durbun.d(...), Durbun.i(...), Durbun.w(...), Durbun.e('Ödeme başarısız', error: e, stackTrace: st);
Durbun.event('purchase', {'amount': 49.9});
```

- Network: `HttpOverrides.global` wrapper (chains any previous `HttpOverrides.current`) → wraps every
  dart:io `HttpClient` (covers `package:http` IOClient, Dio's default adapter, image loading via
  dart:io). Must implement the complete current `HttpClient`, `HttpClientRequest`, `HttpClientResponse`
  interfaces of the installed Dart SDK (3.10). Mocks: synthesize `HttpClientResponse`.
- Optional sibling package `sdks/flutter/durbun_dio` with `DurbunDioInterceptor` (for native adapters).
- Errors: `FlutterError.onError` (chain the previous handler; `kind: 'flutter-error'` with the rendered
  diagnostics as message), `PlatformDispatcher.instance.onError`, zone errors (`kind: 'crash'`).
- Metrics: `SchedulerBinding.addTimingsCallback` → fps, janky frames (> 16.7 ms build or raster, or per
  display refresh rate), avg build/raster ms; `ProcessInfo.currentRss` → memoryMB.
- Commands: `flutter.debugPaint`, `flutter.repaintRainbow`, `flutter.slowAnimations`,
  `flutter.brightness`, `flutter.platform`, `flutter.dumpWidgetTree`, `flutter.dumpRenderTree` (same ids
  as §5.6) — re-assemble/re-render where needed.
- Core (transport, protocol, HttpOverrides, logger) must be **pure Dart** (no `package:flutter` imports)
  under `lib/src/core/` so it can be smoke-tested with `dart run`; Flutter glue in `lib/src/flutter/`.

### 6.3 Android (`sdks/android`, Gradle project; module `durbun` + `durbun-noop`)

```kotlin
// Application.onCreate
Durbun.start(this /*, DurbunOptions(host = "192.168.1.20") */)
val client = OkHttpClient.Builder().addInterceptor(DurbunInterceptor()).build()
Durbun.log(Level.INFO, "auth", "Logged in", data = mapOf("userId" to 42))
Durbun.event("purchase", mapOf("amount" to 49.9))
```
Package `dev.durbun`. Transport: TCP to 127.0.0.1:9751 (adb reverse) + optional host. OkHttp
interceptor captures/mocks (gzip-aware, peeks bodies without consuming them). Uncaught exception handler
chained (`kind: 'crash'`). Metrics: memory (PSS/Java heap), FPS/jank via `Choreographer`. `durbun-noop`
exposes the same public API with empty bodies for `releaseImplementation`.

### 6.4 iOS (`sdks/ios`, Swift package `Durbun`, iOS 13+, macOS 11+ for tests)

```swift
import Durbun
#if DEBUG
Durbun.start()            // or Durbun.start(options: .init(host: "192.168.1.20"))
#endif
Durbun.log("Logged in", level: .info, tag: "auth", data: ["userId": 42])
Durbun.event("purchase", ["amount": 49.9])
```
`URLProtocol` subclass registered globally + injected into `URLSessionConfiguration.default/.ephemeral`
(swizzle) → captures/mocks URLSession traffic (avoid recursion with a request property). Transport:
Network.framework client to 127.0.0.1:9751 (simulator) + on-device listener 127.0.0.1:9752–9755 (usbmux)
+ optional host. stdout/stderr capture (dup2 pipe, still forwards to the original fds) → logs.
`NSSetUncaughtExceptionHandler` chained. Metrics: phys_footprint, CPU (thread_info), FPS via
`CADisplayLink` (iOS only). Must compile for macOS (iOS-only pieces behind `#if os(iOS)`).

### 6.5 React Native / JS (`sdks/js`, npm `@durbun/react-native`)

```js
import { Durbun } from '@durbun/react-native';
if (__DEV__) Durbun.start({ host: 'localhost' });   // Android: adb reverse makes localhost work over USB
```
WebSocket to `ws://<host>:9750/sdk`. Patches `XMLHttpRequest` (RN fetch is built on it) and global
`fetch` when it is not XHR-based; `console.*` (keeps originals); `ErrorUtils.setGlobalHandler` (RN) /
`window.onerror` + `unhandledrejection` (web). Mocks for XHR/fetch. TypeScript source → compiled JS +
d.ts; no runtime dependencies.

---

## 7. UI (`packages/ui`)

### 7.1 Design system

Dark theme is the default look; light theme fully supported (`data-theme` on `<html>`: `dark` | `light`,
`system` follows `prefers-color-scheme`). Calm, crisp, dense-but-airy developer tool (think Linear /
Proxyman / Raycast). No gratuitous gradients or animations; 120 ms transitions.

CSS variables (define in `src/styles/tokens.css`; features MUST use them, never hard-coded colors):

| Token | Dark | Light |
|---|---|---|
| `--bg-app` | `#0B0D12` | `#F5F6F9` |
| `--bg-panel` | `#11141B` | `#FFFFFF` |
| `--bg-elevated` | `#171B24` | `#FFFFFF` |
| `--bg-sunken` | `#0D1016` | `#EEF0F4` |
| `--bg-hover` | `#1B2030` | `#F0F2F7` |
| `--bg-active` | `#222839` | `#E6E9F1` |
| `--bg-selected` | `rgba(124,108,242,.16)` | `rgba(91,75,224,.10)` |
| `--border` | `#232937` | `#E3E6EE` |
| `--border-strong` | `#2F3647` | `#CDD2DE` |
| `--text` | `#E6E9F0` | `#161A23` |
| `--text-muted` | `#9AA3B5` | `#5B6476` |
| `--text-subtle` | `#6B7488` | `#8A93A6` |
| `--accent` (brand violet) | `#7C6CF2` | `#5B4BE0` |
| `--accent-hover` | `#9587F7` | `#4B3BD0` |
| `--accent-soft` | `rgba(124,108,242,.18)` | `rgba(91,75,224,.10)` |
| `--lv-verbose` | `#7D8799` | `#6B7488` |
| `--lv-debug` | `#4EA1FF` | `#1F6FEB` |
| `--lv-info` | `#3DD68C` | `#1A7F4B` |
| `--lv-warn` | `#F5B544` | `#B7791F` |
| `--lv-error` | `#FF6369` | `#D93A41` |
| `--lv-fatal` | `#FF4FD8` | `#C2188F` |
| `--lv-warn-bg` / `--lv-error-bg` / `--lv-fatal-bg` | warn/error/fatal at 7%/9%/13% alpha | 8%/7%/9% |
| `--m-get` `--m-post` `--m-put` `--m-patch` `--m-delete` `--m-other` | `#4EA1FF #3DD68C #F5B544 #B18CFF #FF6369 #9AA3B5` | `#1F6FEB #1A7F4B #B7791F #7A4CD9 #D93A41 #5B6476` |
| `--st-2xx` `--st-3xx` `--st-4xx` `--st-5xx` `--st-fail` `--st-pending` | `#3DD68C #5CC8FF #F5B544 #FF6369 #FF6369 #9AA3B5` | `#1A7F4B #0E7AB8 #B7791F #D93A41 #D93A41 #5B6476` |
| `--json-key` `--json-string` `--json-number` `--json-bool` `--json-null` | `#9CC2FF #A5E3B4 #F5C27A #D7A4FF #8B94A7` | `#1F4FB8 #1A7F4B #A15C00 #7A4CD9 #6B7488` |
| `--tag-l` `--tag-c` (OKLCH text) / `--tag-bg-a` | `0.80 0.11` / `.14` | `0.48 0.13` / `.10` |

Plus: `--radius-sm 4px`, `--radius 6px`, `--radius-lg 10px`; `--shadow-pop`, `--shadow-modal`;
`--font-ui: "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
`--font-mono: "JetBrains Mono Variable", "SF Mono", ui-monospace, Menlo, monospace`;
`--fs-xs 11px; --fs-sm 12px; --fs-md 13px; --fs-lg 15px; --fs-xl 18px`; `--log-fs` (pref, default
12.5px); `--row-h` (compact 20px / comfortable 24px); `--sidebar-w 248px; --topbar-h 44px;
--statusbar-h 26px`. Fonts are bundled from `@fontsource-variable/inter` and
`@fontsource-variable/jetbrains-mono` (works offline).

Hash-colored chips: `hue = fnv1a(name) % 360`; `color: oklch(var(--tag-l) var(--tag-c) var(--h))`,
background the same hue with `--tag-bg-a` alpha.

**Turkish locale pitfalls**: set `<html lang>` to the UI language; NEVER use CSS `text-transform:
uppercase` on technical tokens (in `lang=tr`, "info" → "İNFO"); write `GET`, `INFO` etc. literally. Use
plain `toLowerCase()` (not `toLocaleLowerCase('tr')`) for search/filter matching.

Icons: `lucide-react`, 16 px, stroke 1.75. Every icon-only button has `aria-label` + tooltip (with the
shortcut). Visible focus rings (`:focus-visible`). Keyboard-first.

Terminology (TR): Loglar · Ağ · Mock'lar · Performans · Cihaz · Tüm cihazlar · Cihaz logları ·
Uygulama logları · Sistem · Temizle · Duraklat / Devam et · Canlı takip · İşaret ekle · Ara · Filtre ·
İstek · Yanıt · Başlıklar · Gövde · Zamanlama · Genel · cURL olarak kopyala · Yeniden gönder · Mock oluştur ·
Ayarlar · Sistem kontrolü · SDK kurulumu · Dışa aktar · İçe aktar · Bir cihaz bağlayın. Level names stay
technical (Verbose/Debug/Info/Warn/Error/Fatal) with Turkish tooltips.

### 7.2 Shell & data layer (owner ui-foundation)

Layout: left **sidebar** (Dürbün logo; "Tüm cihazlar"; devices with platform icon, name, OS, connection
badge, state dot, log-stream status; under each device its app sessions — name, version, SDK platform
badge, live dot; older sessions of the same app collapsed; collapsible to icons) · **top bar** (tabs
Loglar / Ağ / Mock'lar / Performans / Cihaz with counts/badges, scope breadcrumb, global actions:
command palette, import/export, settings, theme, language) · **main** (active feature view) · **status
bar** (WS connection, server version, totals: logs / errors / requests, ingest rate lines/s, LAN mode,
demo mode).

Data layer (`src/data/**`): one WebSocket client (`/ui`, auto-reconnect with backoff, re-sync on
reconnect by clearing and re-receiving history), request/reply helper `sendCommand(cmd): Promise<data>`,
REST helpers (`api.ts`). High-frequency data lives OUTSIDE React state in mutable stores with a `version`
counter bumped at most once per animation frame:
- `logStore`: `entries: LogEntry[]` (append-only ring, trimmed at maxLogEntries), `version`,
  `totalReceived`, `subscribe(fn)`, `useLogVersion()`.
- `networkStore`: `byId: Map<string, NetworkEntry>`, `order: string[]`, `version`, `useNetworkVersion()`.
- `metricsStore`: series by key, `useMetricsVersion()`.
Normal zustand stores: connection, devices/apps/drivers/processes, scope (`{kind:'all'} |
{kind:'device', deviceId} | {kind:'app', appId}`), mocks, server settings, UI prefs (persisted to
localStorage with try/catch): theme, language, logFontSize, density, timeFormat, wrapLines,
showNetworkInLogs, hideNoise, noiseRules, highlightRules, notifyOnCrash, sidebarCollapsed, panel sizes.
Scope helpers: `entryInScope(entry, scope)` for logs (app scope = `appId === A` OR device log on A's
device whose `process`/pid belongs to A) and network.

Shared components (`src/components/**`): Button, IconButton, Toggle, SegmentedControl, Chip, TagChip
(hash color), LevelBadge, MethodBadge, StatusBadge, Tooltip, Popover, Menu/ContextMenu, Dialog,
ConfirmDialog (`confirm()` promise API), Toasts (`toast()` API), Tabs, SplitPane (resizable, persisted,
double-click reset), Toolbar, SearchInput, EmptyState, KeyValueTable (copy per row, filter),
**JsonTree** (lazy collapsible tree, expand/collapse all, search highlight, copy value/path like
`data.items[0].id`, handles 10k+ nodes by rendering children only when expanded), **CodeView**
(highlight.js for json/xml/html/javascript/css/plain, line numbers, wrap toggle, find), CopyButton, Kbd,
Spinner, StatusDot, Sparkline (SVG), formatters (`formatBytes`, `formatDuration`, `formatTime`,
`formatRelative`), `useShortcut(combo, handler, opts)`, command palette registry
`useCommands(commands)`, i18n `useT()` + `registerMessages(namespace, { tr, en })` (features keep their
own dictionaries), `usePersistentState(key, initial)`.

Global screens: **Onboarding** empty state when no devices/apps (cards: Android USB debugging steps, iOS
"Trust this computer" + log tool status, simulators/emulators auto-detected, "Demo verisiyle dene" →
`demo.set`), **SDK kurulumu** guide (tabs Flutter / Android / iOS / React Native with copyable snippets
matching §6 APIs exactly, USB vs Wi-Fi notes), **Sistem kontrolü** (doctor: `GET /api/doctor` with status
icons and copyable fixes), **Ayarlar** (server settings + UI prefs), **İçe/Dışa aktar** (session export
download, import via file picker or drag-and-drop anywhere), **Kısayollar** help (`?`), **Command
palette** (`Mod+K`, fuzzy). Toasts for server `notice`s (localized by `code`). Responsive: ≥ 1000 px
ideal; below 900 px the sidebar auto-collapses and detail panels become overlays.

Shortcuts: `Mod+K` palette · `/` or `Mod+F` focus search · `Mod+1..5` tabs · `Space` pause/resume
(outside inputs) · `M` marker · `Mod+Backspace` clear current view (outside inputs) · `↑/↓` or `j/k`
move selection · `Enter` open detail · `Esc` close/clear · `G` jump to bottom & follow · `?` help.

### 7.3 Logs view (owner ui-logs, phase 2)
Virtualized list (dynamic row heights), smart message rendering (§1.1), Android-Studio-like query
language (`tag:` `-tag:` `tag=:` `tag~:` `message:` `process:`/`package:` `pid:` `level:` (≥)
`source:` `app:` `is:crash|anr|error|json|network|event|marker|stacktrace|flutter` `age:5m`, quoted
phrases, `|`, parentheses) with autocomplete & syntax highlight, min-level segmented control, source
toggles, noise toggle + editor, saved filters, highlight rules, follow/pause, density/font/wrap/time
format controls, marker, clear, histogram strip, detail panel (formatted message, JSON tree, stack trace
with app frames highlighted, metadata, copy, filter shortcuts, show in context), crash banner + optional
desktop notification, export visible logs (txt/json), dedupe of identical app-vs-device lines.

### 7.4 Network & 7.5 Mocks (owner ui-network, phase 2)
Request table (status, method, host, path / GraphQL op, type, size, duration, start time, waterfall;
sortable, column toggles), filters (text, body search via server, method, status class, content type,
host, errors only, slow), detail (Genel / İstek / Yanıt / Zamanlama; headers, query params, cookies,
body viewers: JSON tree, raw/pretty code, image preview, hex for binary, truncated notice), copy as
cURL / fetch / Dart(dio) / Swift / Kotlin(OkHttp), share report (Markdown-light text identical to the in-app
panel's: request line, outcome, time local + UTC, app, device, client, trace IDs, mock note, error, headers,
bodies cut at 20 000 chars, cURL; secret headers / query keys / JSON and form fields masked as `••••` by default;
copy or save as .md), replay and edit-&-replay, create mock from request,
HAR export (filtered / single), compare two responses (diff). Mocks tab: rule list (enable, reorder,
duplicate, delete, hit count), editor (method, URL pattern + match type with live tester against recent
requests, action respond/delay/fail, status presets, header rows, body editor with JSON validate/format,
delay, app scope), master enable switch, capability hints per connected app.

### 7.6 Performance & 7.7 Device (owner ui-device-perf, phase 2)
Performance: target picker (apps in scope / device processes), stat tiles (CPU, memory now/peak, FPS,
jank, req/s, log/s, errors), time-series charts (uPlot) with window selector, start/stop polling via
`metrics.watch`, CSV export. Device: info card, action cards shown according to `device.actions`
(screenshot gallery, open URL with history, app management with picker from `list-apps` + SDK apps,
drag-and-drop install, appearance / font scale / animations, input text & key events, location presets,
push notification JSON editor, status bar override, log buffer clear/restart), Flutter tools card driven
by `AppSession.actions` (`app.action`).

---

## 8. Engineering rules (every agent)

- TypeScript `strict`. Small focused modules. English code comments, sparse and useful.
- **Do not run `npm install`/`npm i`/`npx <pkg>` that downloads anything.** All JS deps are pre-installed
  at the repo root (see root `package.json` + workspace `package.json`s). If you truly need another
  dependency, implement it yourself or list it in your report.
- Machine load (the Mac overheats): at most ONE `flutter test` at a time and always `--concurrency=2`;
  Gradle only with `--no-daemon --max-workers=2` and run `pkill -f GradleDaemon; pkill -f
  KotlinCompileDaemon` when done; `swift build -j 2`; never start the Android emulator; boot an iOS
  simulator only if your brief explicitly allows it and shut it down (`xcrun simctl shutdown <udid>`)
  right after. Never run long-lived processes in the foreground without a timeout; kill any server you
  start.
- Tests: vitest (`packages/*/test/**` or colocated `*.test.ts`), Flutter `flutter test --concurrency=2`,
  Swift `swift test`, Gradle unit tests. Parsers and protocol logic MUST have unit tests built from
  realistic sample lines.
- Before finishing: run your typecheck/tests; report precisely what you verified, what you could not
  verify, any deviations from this spec, and any cross-team requests. Never claim something works
  without having run it.

---

## 9. Integration notes after phase 1 (authoritative where they differ from earlier sections)

Phase 1 is done: protocol, hub, SDK layer, platform drivers (android / ios-sim / ios-device), Flutter VM
module, demo driver, HTTP/WS/CLI, UI foundation and the four SDKs all exist, typecheck and pass their tests.
`node dist/durbun.mjs --demo` runs the real server with the real UI shell. What follows is what the code
ACTUALLY does — trust it over older wording above.

### 9.1 Demo data (`--demo`, or "Demo verisiyle dene")
- `demo:1` "Pixel 8 · Demo" (Android emulator) runs **Pati** (Flutter, `com.mykynk.pati`) and
  **Mahalle** (native Android/OkHttp, `com.mykynk.mahalle`); `demo:2` "iPhone 16 Pro · Demo" (iOS
  simulator) runs **Pati**; `demo:3` "iPhone 13 · Demo" (physical iPhone over USB, iOS 17.6.1, iPhone action
  set, no host metrics) has **Pati** installed (debug, `xcode`, not running until launched from the UI).
  ≈ 38 lines/s with bursts.
- SDK-less builds (phase 3) are reported as DeviceApps only: **Kumbara** `com.mykynk.kumbara` 3.1.0 (310)
  on the Pixel (release, Play, main + `:widget` process; an old `data_app_crash` with `previousLaunch`, a live
  AndroidRuntime crash every 5–8 min with its dropbox copy marked `duplicateOf`, a live ANR with its
  `data_app_anr` copy), **Pati QA** `com.mykynk.pati.staging` 2.5.0-rc.2 (252) on the Pixel (release,
  Firebase, quiet), and **Kumbara** on `demo:3` (release, `store-or-testflight`, process `Runner`; an old `.ips`
  report and a live SIGSEGV followed by the copied `.ips`). Demo lines carry the origin the real driver would
  set (`logcat`, `simctl-log`, `idevicesyslog`, `dropbox`, `crash-report`), not `'demo'`.
- The first ~20 s of every launch are scripted so the interesting things show early: crash → restart, ANR,
  Flutter error boxes (sent TWICE on purpose: SDK log `source:'app'` + stdout device log, same text and ts —
  the app-vs-device dedupe case), Dart exceptions, iOS native crash → relaunch, app reconnect.
- Network: REST auth/login/refresh, paging, detail, POST/PUT/PATCH/DELETE, multipart upload, real PNG
  bodies, GraphQL (incl. an `errors` response), 401/404/422/429/500/503, slow requests, timeout/DNS/
  connection failures, cancellation; mock rules apply. Metrics vary believably. Every device action except
  `screen-record` / `screen-record-stop` is simulated (screenshot writes a real PNG).

### 9.2 System lines (`source:'system'`, tag `durbun`, kind `lifecycle` | `marker`) — code → params
| code | params |
|---|---|
| `device.connected` | `{device, deviceId, platform, kind, connection, osVersion}` |
| `device.disconnected` (level warn) | `{device, deviceId, state, detail}` |
| `app.connected`, `app.reconnected` | `{app, bundleId, version, sdk, transport, device}` |
| `app.disconnected` | same + `failedRequests` |
| `process.started`, `process.died` | `{process, pid}` |
| `marker` (kind `marker`) | `{label ('' when none), n}` — markers without a device have `deviceId: ''` (global: show in every scope) |
| `logs.streamStarted`, `logs.streamStopped`, `logs.streamError` | `{via, detail?}` |
| `logs.connectionLost` (warn, iPhone) | `{via, connection: 'usb' \| 'wifi', graceSeconds, detail}` — every drop of the last usbmux connection |
| `logs.connectionRestored` (iPhone) | `{via, connection, seconds, detail}` — back within the grace (else `device.disconnected` follows) |
| `logs.streamStalled` (warn, iPhone) | `{via, seconds, detail}` — idevicesyslog alive but silent; restarted with backoff 2 s, 5 s, 15 s, then every 30 s |
| `logs.scopeNotApplied` (warn, iPhone) | `{via, reason: 'devicectlMissing' \| 'appListFailed', device}` — every line is shown |
| `logs.scopeApplied` (iPhone) | `{via, device}` — the app list is readable again; system lines are left out |
| `vm.attached` / `vm.detached` / `vm.attachFailed` | `{app, url}` / `{app, reason}` / `{url, error}` |
| `vm.hotRestart`, `vm.hotReload` (kind `lifecycle`) | `{app}` |
Empty-string params count as missing for i18n candidates. Replays performed by the desktop appear on the
virtual device `desktop` (name "Desktop" — localize by id); imported sessions on `import:<n>` devices whose
names start with `📁 `.

### 9.3 Other codes (localize all of them, TR + EN; grep the server for the exhaustive list)
- `DeviceInfo.stateCode`: `device.unauthorized` (Android RSA prompt), `device.authorizing`,
  `device.noPermissions`, `device.notBooted`, `device.offline`, `device.untrusted` (iPhone did not accept
  "Trust This Computer"), `device.simulatorShutdown`, `device.driverStopped`, `device.imported`,
  `device.networkIdle` (a `net:` device whose last session closed), `demo.stopped`.
- `DeviceInfo.logs.code`: `logs.adbMissing`, `logs.deviceOffline`, `device.unauthorized`, `device.untrusted`,
  `logs.processExited`, `logs.idevicesyslogMissing`, `logs.usbmuxdUnavailable`, `logs.simctlMissing`,
  `logs.networkOnly` (`net:` devices: only SDK data, no device logs), `logs.scopeNotApplied` (status
  `streaming`: the iPhone 'apps' scope cannot be applied, every line is shown), `logs.streamStalled` (status
  `error`: the stream is silent while the device is attached; Dürbün restarts it).
- `DriverStatus.code`: `logs.adbMissing`, `driver.adbError`, `logs.simctlMissing`, `driver.simctlError`,
  `logs.usbmuxdUnavailable`, `logs.idevicesyslogMissing`, `driver.initFailed`, `driver.statusFailed`,
  `demo.active`, `demo.inactive`.
- Notices: `settings.adjusted {details}`, `settings.lanOn` / `settings.lanOff {sdkPort, httpPort,
  restartRequired 0|1}`, `settings.sdkRebindFailed`, `config.writeFailed`, `replay.bodyTruncated`,
  `replay.bodyMissing`, `replay.bodyDropped`, `vm.attached` (success, auto-attach only), `vm.detached`,
  `vm.attachFailed`.
- Command reply / `CommandError` codes: `command.invalid|unknown|failed`, `device.unknown|readOnly|noActions|
  networkOnly`, `action.failed|timeout|invalidResult`, `app.unknown|disconnected|timeout|notConnected|
  commandTimeout|commandsUnsupported`, `server.shutdown`, `config.invalid`, `vm.unavailable|timeout`,
  `metrics.unsupported`, `net.unknown`, `replay.invalidMethod|invalidUrl|unsupportedUrl`,
  `demo.unavailable|timeout|inactive|unsupportedAction|actionFailed`, `params.invalid`, `app.notInstalled`,
  `screenshot.writeFailed`, `sdk.unavailable`. A successful `device.action` reply forwards
  `DeviceActionResult.code` (`action.done`, `action.listApps`, `action.screenshot.saved` with data
  `{url, file, width, height}`, `action.recording.saved` with data `{url, file}`); action errors:
  `action.failed`, `action.invalidParams`, `action.unsupported`, `action.deviceOffline`,
  `action.deviceNotFound`, `action.toolMissing`, `action.screenshotRefused`.
- REST errors are JSON `{error, code}`; call `/api` only same-origin with relative URLs. WS `/ui` close code
  1013 = resync now, 1001 = server shutting down. `net.replay` network failures reply `ok:true` with a
  NetworkEntry whose `state` is `failed`.

### 9.4 What real SDK / device traffic looks like
- `hello.sdk.name`: `durbun-flutter`, `durbun-android`, `durbun-ios`, `@durbun/react-native`,
  `durbun-vm-service` (platform `dart-vm`), demo.
- Tags: SDK self-messages use tag `durbun` (e.g. "N messages were dropped"). Untagged SDK logs get tag `app`.
  Flutter print → `flutter`; iOS `stdout` / `stderr` / `crash` / `ui` / `userdefaults`; RN `app` /
  `console` / `[Tag]`-derived / `uncaught` / `unhandled-rejection`; VM service: logger name (`log` when
  empty), `flutter`, `navigation` (`→ /route` lines), `stdout` / `stderr`.
- Crashes (kind `crash`, level `fatal` unless noted):
  - Flutter SDK: `Unhandled exception: <error>` + `error.stack` (Dart frames `#0 …`).
  - Android SDK: `FATAL EXCEPTION in thread "main": <Throwable>` + `error.stack` in Java format (`\tat …`,
    `Caused by: …`); undelivered crashes arrive next launch as `Previous launch crashed — …` with
    `data.previousLaunch = true`.
  - iOS SDK: live NSException crashes; signal crashes arrive on the next launch as `Crash in previous
    launch: …` with `data.previousLaunch = true` and `ts` = crash time (older than surrounding rows — order
    is by `id`, show the real ts).
  - Device logs: grouped Java crashes and native tombstones (kind `crash`, data may hold `signal`,
    `abortMessage`, `package`, `reporterPid`), ANR (kind `anr`), Flutter error boxes (kind `flutter-error`),
    engine `[ERROR:flutter/…] Unhandled Exception` (kind `crash`, level `error`), iOS `*** Terminating app due
    to uncaught exception` (crash). iOS os_log **Fault → level `error`** (`fatal` is only for crashes).
- `flutter-error`: `message` = the full rendered box (starts `══╡ EXCEPTION CAUGHT BY … ╞═══`), `error.message`
  = one-line summary (e.g. `A RenderFlex overflowed by 42 pixels on the right.`) → use it as the headline.
- Dumps arrive as ONE log row: Flutter `Widget tree (N lines)\n…` / `Render tree (N lines)\n…` (tag
  `flutter`), Android `Thread dump · N threads` + `\tat` frames, iOS view hierarchy (tag `ui`) and
  UserDefaults (tag `userdefaults`).
- Network: ids `<appId>:<sdkId>`; `source` ∈ `dart:io`, `dio`, `okhttp`, `urlsession`, `xhr`, `fetch`,
  `vm-service`, `demo`, `replay`. iOS reports each redirect hop as its own entry; Flutter/OkHttp fold
  redirects into one entry. **Size-only bodies** `{encoding:'utf8', data:'', size:N, truncated:true}`
  (capture off or too large) → show "body not captured · N bytes", never an empty viewer. Android timings
  are coarse (`connect` = DNS+TCP+TLS). An entry can be `state:'failed'` AND have a `status` (body stream
  broke after the headers) — show both.
- Metrics: `fps` may be absent (no frames rendered — Flutter only paints on change: absent/0 fps = idle, not
  frozen); `cpu` = % of one core; `memoryMB` = RSS; `heapMB` = Dart/JS/Java heap; `threads` (Android, iOS);
  RN `fps` is the JS-thread FPS. VM-service metrics have `source:'vm-service'`.
- App actions (`AppSession.actions`): groups `flutter` (toggles `flutter.debugPaint`, `flutter.repaintRainbow`,
  `flutter.slowAnimations`, `flutter.performanceOverlay`, `flutter.invertOversizedImages`; selects
  `flutter.brightness` system|light|dark and `flutter.platform` default|android|iOS|macOS; buttons
  `flutter.dumpWidgetTree` / `flutter.dumpRenderTree` → reply data `{text, lines}` and also a log row),
  `android` (`android.dumpThreads`, `android.gc`), `ios` (`ios.appearance` select, `ios.slowAnimations`
  toggle, `ios.dumpViewHierarchy`, `ios.dumpUserDefaults`), `react-native` (`rn.reload`, `rn.devMenu`),
  `web` (`web.reload`), `app` (custom). Built-ins have `labelKey === id`. **`app.action` params: toggles and
  selects send `{ value }`** (boolean / option value), buttons `{}`; the SDK then pushes an `actions`
  update with current values.
- Devices: `screen.density` is a scale factor (e.g. 2.625), not dpi. Simulator recordings are `.mov`,
  Android / iOS-device recordings `.mp4`.

### 9.5 Dev loop for phase-2 engineers working in parallel
- Never write to `dist/` (shared) and never run `npm run build`. Build your own UI copy:
  `cd packages/ui && npx vite build --outDir <your tmp>/ui --emptyOutDir` (≈ 2 s).
- Run your own server from the frozen snapshot bundle given in your brief:
  `node <snapshot> --demo --no-open --port <P> --sdk-port <P+1> --ui-dir <your tmp>/ui --data-dir <your tmp>/data`
  (background; kill it when done). Open `http://localhost:<P>` in your OWN built-in-browser tab
  (`preview_start` with `url`), always pass your `tabId`, never navigate or close other tabs.
- `npx tsc -p packages/ui/tsconfig.json` also checks the other engineers' in-progress folders: judge only
  errors in your own paths. Tests: `npx vitest run src/features/<yours>` from `packages/ui`.

---

## 10. Zero-integration capture, source transparency, one-step SDK, Mac app (phase 3 — authoritative)

### 10.1 Why (the user's words, summarized)
The team (Flutter apps with a native layer, several projects) needs, in this order of difficulty:
1. A tester comes with a bug on an **old build** → plug that phone in and see what that build does.
2. **Debug builds** appear automatically.
3. **Release builds** and 4. builds from **Firebase App Distribution or the stores** expose everything
   that is technically possible.
Constraints: **the team decides per project** whether a build runs the SDK, store builds included —
Dürbün supports every case and polices nothing (decision of 2026-11-02, replacing an earlier "never in store
builds" rule; there is no install-source guard). Apps use **SSL pinning** (a third-party provider) → no proxy
route. Whether the Firebase build is the same binary as the store
build **differs per project**. SDK setup must be minimal. Every user must understand **where each piece
of data comes from**, and when something is missing **why** (and what would enable it). UI/UX matters.

Consequences: for builds without the SDK we take everything the OS exposes from outside (device logs,
crash/ANR records, Android process + frame stats, device tools). Network and mocks for such builds are
impossible and the UI says so plainly (`noOutsideNetwork`), without blaming the user.

### 10.2 Device apps (protocol `DeviceApp`, server `HubSink.upsertDeviceApp/removeDeviceApps`)
- A `DeviceApp` is an app the **device** reports (running, recently active ≤ 15 min, or with a crash
  report) — independent of SDK sessions. Third-party apps only (no system apps). Key `'<deviceId>|<id>'`.
- Drivers own `pids`/`running`, version/build/buildType/install. The hub owns storage, `lastActivity`
  (bumped when device log lines arrive whose pid ∈ pids or `process` == id / starts with `id + ':'`),
  batching (`HubChange.deviceApps/removedDeviceApps` → WS `batch.deviceApps/removedDeviceApps`,
  `snapshot.deviceApps`), removal when a device is removed, `getDeviceApps()`.
- Android: `dumpsys package <pkg>` → versionName, versionCode → `build`, DEBUGGABLE → buildType,
  installer (`installerPackageName=` / `InstallerPackageName`, `installInitiatingPackageName`):
  `com.android.vending` → 'play', `dev.firebase.appdistribution` → 'firebase', shell/none → 'adb',
  other → 'other-store' + `installer`; `firstInstallTime` / `lastUpdateTime`.
- iOS device: `devicectl device info apps` default list vs `--include-all-apps` → developer apps are
  'xcode' (buildType 'debug'), others 'store-or-testflight' (buildType 'release'). Simulator: `simctl
  listapps` `IsDeveloperApp` → 'simulator'.
- Device log lines get `origin` (`'logcat' | 'idevicesyslog' | 'simctl-log'`), SDK lines `'sdk'`, VM
  service `'vm-service'`, system lines `'durbun'`, demo `'demo'`, imports keep theirs or `'import'`.
  The demo mirrors the real drivers' origins (§9.1).
- Hub rules: when a device leaves `online` its apps get `running:false, pids:[]` and stay listed; removing a
  device removes its apps; activity-only changes are throttled to one per app per second; on iOS a shared
  `processName` (e.g. `Runner`) bumps an app only when exactly one app on the device has it; crash entries
  with `data.previousLaunch` (dropbox / crash-report) do **not** bump `lastActivity` (the driver sends
  `lastActivity = reportTs` for them); at most 2000 apps (the least recently active non-running one goes).
- Export writes `SessionExport.deviceApps` (an app-scoped export keeps that bundle id only); import puts them on
  the `import:` devices as not running.
- Android `DeviceApp.name` comes from `cmd package resolve-activity` `nonLocalizedLabel` (Android 7+, literal
  labels only; `@string/…` labels stay undefined because there is no aapt on the device). Unplugging a phone or
  stopping the driver keeps its DeviceApps (not running); they are removed only on uninstall, or by the hub when
  the device itself is removed.
- The hub merges `readers` per reader id: a patch for one reader keeps the others, `null` / `undefined` removes
  one, `code` / `detail` belong to the state they came with, `lastOk` carries over until a newer one; imports keep
  sanitized readers. `hello.sdk.layers` keeps only known values, deduplicated, in order (imports keep them).

### 10.3 Crash reports (any build)
- Android `dumpsys dropbox --print <tag>` for `data_app_crash`, `data_app_anr`, `data_app_native_crash`,
  `SYSTEM_TOMBSTONE` (third-party packages only): on connect the last 24 h, then every 30 s new records.
  Each record → `LogEntry` kind `crash`/`anr`, `origin 'dropbox'`, `data: {origin:'dropbox', package,
  process, pid?, reportTs, previousLaunch: reportTs < watchStart}`, `error` with type/message/stack;
  `upsertDeviceApp({crashReportsDelta:1})`. De-duplicate against live logcat crashes (same pid or same
  package within ±5 s) by marking the dropbox copy `data.duplicateOf` = live entry id (UI hides it).
- iOS device: `xcrun devicectl device copy from --domain-type systemCrashLogs` (list, then copy new
  `.ips` files to `<tempDir>/crash/<udid>/`); simulator: `~/Library/Logs/DiagnosticReports/*.ips` whose
  path is inside the simulator's data dir. Parse the two-part .ips (JSON header line + JSON body):
  bundleID, app_version, build_version, timestamp, exception type/codes, termination reason, crashed
  thread frames (image + offset; **unsymbolicated** — say so). Third-party bundle ids only. Same LogEntry
  shape with `origin 'crash-report'`.
- Simulator reports are matched to the simulator by the report's `coalitionName` / paths inside the
  simulator's data dir (macOS 26+ writes them to the Mac's DiagnosticReports).
- Download: every crash-report entry whose file was copied to `<tempDir>/crash/<udid>/<name>` carries
  `data.reportUrl = '/api/files/crash/<enc(udid)>/<enc(name)>'` (and `data.file`, the absolute path).
  The server serves only `.ips` names from that folder (loopback + Origin rules like every `/api` route,
  `Content-Disposition: attachment`); the UI offers "İndir (.ips)" and says how to symbolicate.
- Reader state: drivers report `DeviceInfo.readers.crashReports` (`ok` / `unavailable` / `unsupported` +
  `reader.crashReports.<reason>` code + English detail) so "no crash reports" and "crash reports cannot be read
  here" never look the same (§10.8). Android reports a failure at once before the first good read, afterwards
  only after two failed polls in a row.
- Android counting: one crash counts once in `crashReports` (a `data_app_native_crash` + `SYSTEM_TOMBSTONE` pair
  linked to the same live entry is one crash).
- iOS dedupe: only `.ips` entries are marked. A copied report gets `data.duplicateOf` when an earlier live row
  matches it — a device line with "*** Terminating app due to uncaught exception" or an SDK native crash row
  ('Uncaught exception …' / 'Crash in previous launch: …') — with the same pid within 60 s or the same bundle id
  within 10 s. A live row that arrives after the report was pushed is not de-duplicated.
- Real devicectl facts (checked on an iPhone 15 Pro Max, iOS 27.2, devicectl 651.32): the `systemCrashLogs`
  listing `name` is a path (`Retired/…`); the `bug_type` / `LogType` extended attributes are used as a pre-filter;
  `ProxiedDevice-<id>/` folders hold a paired Apple Watch's reports and are skipped; `copy from --destination` is a
  file path. Copy names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,155}\.ips$`.

### 10.4 Android frame stats (any build)
`dumpsys gfxinfo <pkg>` (+ `reset`) every 2 s for native UI; for Flutter's SurfaceView use
`dumpsys SurfaceFlinger --latency '<layer>'` (find the layer with `dumpsys SurfaceFlinger --list`).
→ `MetricSample{source:'adb', fps, jankyFrames}`. If neither yields data (permissions/OS), emit nothing
and let the UI explain (`frameStatsApproximate`), and set `DeviceInfo.readers.frameStats` to `unavailable`
(`reader.frameStats.noData`) after about 10 s of a live watched process without frames; iOS reports
`unsupported` (§10.8). Android 15 prints `--list` entries as `RequestedLayerState{<name> parentId=…}`; a
SurfaceView (Flutter) app never falls back to gfxinfo's decor frames for its fps.

### 10.5 Source transparency in the UI (`packages/ui/src/data/explain.ts`, frozen contract)
- `explainSources({device, deviceApp, sessions})` → `{badge, rows}`: one row per capability (logs,
  network, metrics, crashes, mocks, tools) with status yes/partial/no, sources, reasons, actions.
  Pure + unit-tested; the only place this logic lives.
- Sidebar: under each device, apps = SDK/VM sessions ∪ DeviceApps (joined by device + bundle id), each
  row: name, version (build), a source badge (SDK / VM Service / Yalnızca cihaz logu) and a build badge
  (Debug, Firebase, Play, Xcode, Store/TestFlight, Simülatör). Selecting a DeviceApp scopes logs to its
  pids / process names (extend `data/scope.ts`).
- "Neler görünüyor?" (What can I see?) popover from the app row and the scope header: the matrix in
  plain language + action buttons. Empty states in Network / Performance / Mocks use the same reasons
  for the scoped app. Log rows' source tooltip and the detail panel name the exact origin.
- Writing: calm, specific, never blame the developer; one sentence why + one sentence how.
- Details fixed during phase 3: the scope kind `deviceApp`; `ExplainResult.notes` (caveats for the whole app)
  and `context` (what the explanation was based on); reason codes `fpsNeedsApp`, `networkOnly`,
  `deviceToolsAvailable`, `sdkInStoreBuild` (plus the reader-driven ones, §10.8); 'yes' rows may carry
  caveat reasons; the short sidebar source label is «Cihaz logu».
- `install.source = 'other-store'` is worded from `install.installer` (package installer → "APK elle kuruldu",
  Samsung → Galaxy Store, Huawei → AppGallery, Xiaomi → GetApps, Amazon → Appstore, else the installer id);
  `adb` also covers Android Studio / `flutter run`; the iOS badge reads "Store / TestFlight / ad-hoc" (iOS
  cannot tell App Store, TestFlight and ad-hoc installs apart). A hand-installed APK (package installer) gets the
  `apk` build badge and counts as an internal build, not a store build.
- The demo is explained like the device and build each demo app stands for (`ExplainContext.demo` + a
  `demoData` note), never as all-'demo' rows.
- Reasons added in phase 3: `crashReportsUnavailable`, `frameStatsUnavailable` (from `DeviceInfo.readers`),
  `nativeLayerActive`, `nativeLayerMissing` (from `sdk.layers`), `demoData`; source `native-layer`; build badge
  `apk` and `otherStoreKind()`. Reader codes get UI text under `code.reader.*`; a test fails when a server
  source emits a `reader.*` literal without TR / EN text.
- Sidebar folding on crowded phones: connected, selected and running developer builds and apps active within
  the last 3 minutes stay visible; the rest fold under "N uygulama daha".

### 10.6 One-step SDK (`sdks/**`)
- `durbun` becomes a Flutter **plugin** (Android + iOS) that carries the native cores; native side is
  started by Dart over a method channel (no native init call); native events go out over the Dart
  side's single connection (one app session).
- Enablement: debug/profile on; release only with `--dart-define=DURBUN=true` (per project/flavor —
  e.g. the Firebase build when it is a separate build). Never auto-on in release. Native follows Dart.
  The define (or `DurbunOptions.enabled`) is the team's choice for any build, store builds included; the SDK
  never checks how the app was installed. Docs state the facts neutrally: Flutter writes the defines into
  `ios/Flutter/Generated.xcconfig`, so a later Xcode Archive keeps `DURBUN=true` until the next `flutter build`
  without it; an enabled build talks to whatever answers on its device loopback port (no pairing yet).
- Setup = pubspec line + `Durbun.run(...)` in main. Android native network: one optional line
  `.addInterceptor(DurbunInterceptor())`; iOS URLSession capture automatic. Measure release size delta.
- Packaging: Android compiles the shared Kotlin core into the plugin through Gradle `sourceSets`; iOS carries a
  synced copy of the Swift core (`dart run tool/sync_native.dart`, drift-checked by `--check` and a test).
- `--dart-define=DURBUN=false` turns the SDK off in every mode (debug and profile too); `DurbunOptions.enabled`
  overrides both defines.
- Measured release size delta: Android +35 KB APK when the app already has a plugin, +71 KB (arm64) when
  Dürbün is its first plugin (≈ 36 KB of androidx resources); iOS +868–888 KB unstripped `.app`, +278 KB zipped.
  Xcode 27 rejects iOS deployment targets below 15 for apps (the example's Podfile raises it); the plugin
  itself stays at iOS 13.
- Hosted-mode native crashes: a main-thread Kotlin crash blocks Dart, so the native core sends the crash report
  over a short-lived second connection that reuses Dart's hello and session (same app session on the desktop);
  next-launch delivery stays the fallback. Native metrics are off in hosted mode (Flutter metrics only).
- `hello.sdk.layers` says which layers feed the session (`['dart']`, plus `'android'` / `'ios'` when the native
  core attached); the UI uses it to say native crashes / logs / URLSession are covered (§10.8).
- The on-device listener (iOS, usbmux path) binds its port only once the hello is ready, so an early desktop is
  refused (and retries) instead of being accepted and dropped.
- `durbun_dio` recognizes the dart:io adapter by type (survives `--obfuscate`); its iOS NativeAdapter dedupe is
  name-based, so obfuscated iOS builds may show those requests twice (never lose them).

### 10.7 Mac app (`apps/desktop`, Electron; releases signed with a Developer ID and notarized)
One click: the app starts the server in-process (programmatic entry built from `startServer`), opens
the UI window, fixes PATH from the login shell (`$SHELL -ilc env`), single instance, tray/menu-bar item,
quit stops the server. `npm run app` (dev) / `npm run app:dist` (→ `.app` + `.dmg`, arm64).
- Output: `apps/desktop/release/mac-arm64/Dürbün.app` and `apps/desktop/release/Durbun-<version>-arm64.dmg`
  (ad-hoc signature after the fuses are flipped). `npm run app:release` with the signing environment
  (electron-builder.config.cjs) builds the Developer ID signed, notarized release DMGs and ZIPs.
- Environment variables: `DURBUN_PORT` / `DURBUN_SDK_PORT` (defaults 9750 / 9751; when another program holds
  the HTTP port the app tries 9760, 9770, 9780, then an OS port; an existing Dürbün on the port is reused),
  `DURBUN_DATA_DIR` (default `~/.durbun`), `DURBUN_USER_DATA_DIR` (Electron profile), `DURBUN_DEMO`,
  `DURBUN_DEBUG`, `DURBUN_DESKTOP_SELFTEST=<report.json>` (writes a report + screenshot, then quits).
- Pitfall: electron-builder names the helper apps in Unicode NFD but writes `CFBundleName` in NFC, so a
  `productName` with "ü" must be given as `'Dürbün'.normalize('NFD')` or the packaged app never starts.
- The server entry for embedders is `dist/server.mjs` (`startServer(opts, {logger})`, `probeServer(port)`);
  `startServer` installs no process handlers and never exits the process; a busy HTTP port rejects with
  `ServerStartError.code === 'EADDRINUSE'`.
- Desktop-only styles live in the UI under `html[data-desktop='mac']` (+ `html[data-desktop-fullscreen]`), set
  by the app's preload: drag areas, the traffic-light inset, compact mode.
- Attach: when a Dürbün already answers on the port the app opens a window on it; when that server stops, the app
  takes over with its own server; a version mismatch shows a tray notice. Port rules: a port held on 0.0.0.0
  counts as busy; on `EADDRINUSE` the app tries 9760, 9770, 9780, then an OS-assigned port.
- Variables taken from the login shell: PATH, ANDROID_HOME, ANDROID_SDK_ROOT, ANDROID_ADB_SERVER_PORT,
  FLUTTER_ROOT, FVM_CACHE_PATH, FVM_HOME, DEVELOPER_DIR, JAVA_HOME. A login shell that times out or fails is shown
  (tray / diagnostic log), not only logged.

### 10.8 Contracts added while reviewing phase 3 (lead)
- `DeviceInfo.readers?: Partial<Record<'crashReports' | 'frameStats', DeviceReaderState>>`,
  `DeviceReaderState = {status: 'ok' | 'unavailable' | 'unsupported', code?, detail?, lastOk?}`. `ok` means an
  empty result is real; `unavailable` = tried and failed; `unsupported` = impossible on this device/OS. Codes
  are `reader.<readerId>.<reason>`: `reader.crashReports.dropboxRefused`, `reader.crashReports.devicectlMissing`,
  `reader.crashReports.developerModeOff` (iOS, detail = devicectl's error line), `reader.crashReports.failed`, `reader.frameStats.noData`, `reader.frameStats.unsupported` (drivers may add
  more; the UI falls back to `detail`). The hub merges `readers` per reader id on `upsertDevice` / `patchDevice`.
- `SdkIdentity = {name, version, platform, layers?: ('dart' | 'android' | 'ios')[]}` is the type of
  `SdkHello.sdk` and `AppSession.sdk`; the server keeps only known layer values.
- `SessionExport.deviceApps?: DeviceApp[]`.
- `ToolCheck.code?` / `params?` for wording variants, e.g. `doctor.node.embedded {electron, node}` when the
  server runs inside Dürbün.app.
- `ServerSettings.iosDeviceLogScope?: 'apps' | 'all'` (default 'apps'): physical iPhones keep the lines of
  third-party apps (DeviceApp pids / process names), crash-relevant system lines and lines of not-yet-listed
  processes with third-party-looking names (kept until the process listing they trigger decides).
- Crash/ANR entries (kind crash | anr, or origin dropbox | crash-report) survive log-ring eviction in a small
  protected store (≤ 5 000) on the server and in the UI (`logStore.kept`, a plain head trim that never rebuilds
  the list); a scoped clear subtracts only the crash records it removed from `DeviceApp.crashReports`.
- Clearing an app's logs removes what its scope shows, device lines of its processes included (hub/appScope.ts,
  mirrored by the UI on `cleared`): an app scope sends `clear {deviceId, bundleId}` (also for apps without an
  SDK, which no longer wipes the whole device), one session (exact scope) `clear {deviceId, appId}`. Global
  markers stay.
- `/sdk` WebSocket: refused when `Sec-Fetch-Site` is cross-site or the `Origin` is not loopback / one of this Mac's
  own addresses; the raw SDK TCP port closes a connection whose first line is not JSON (a browser's no-cors POST).
  Mock rules a peer pushed are cleared when it disconnects, in every SDK layer.
- The UI document is served with a Content-Security-Policy (scripts only from the server, hashed when inline;
  WebSocket to the same host; `blob:` / `data:` for images and media; `frame-ancestors 'none'`).
