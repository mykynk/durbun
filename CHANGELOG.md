# Changelog

All notable changes to Dürbün are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org). The Mac app, the server and every SDK share one version.

## [Unreleased]

### Security

- Requests sent from the Mac (resends and flow steps) can no longer reach Dürbün's own server or its device
  gateway, directly, by name or through a redirect. Other services on this Mac still work, and a flow warns
  before it runs a step that calls one.
- Session exports and HAR files mask secret values by default: credential headers, cookies, and token and
  password fields in URLs and bodies. Saving an unmasked file is an explicit choice with a warning. Exports
  no longer contain local file paths.
- A share package with run history contains only the runs of the flows you picked and the sub-flows they
  call, and says how many.
- React Native guide: the Android notes no longer suggest a manual `adb reverse` command that would have
  opened Dürbün's whole API to apps on the phone.

### Fixed

- React Native: unhandled promise rejections are reported again in dev builds of React Native 0.71 and later,
  once each, with the original stack where React Native keeps it.
- Importing a session file kept no device apps (name, version, build type, installer, crash counts). Session
  files written by a newer version are imported instead of refused.
- Failed requests and 5xx responses count as errors in the log (4xx as warnings), so "errors only" shows them.
- Crash notifications work from any tab and for every connected device, and name the app and the device.
- "Show in context" and jumps from other tabs no longer erase your log filters: a bar shows what is turned
  off for the moment, and "Back to my filters" restores them.
- HAR export of a device or an app contains only that scope's requests.
- Crash share reports from apps without the SDK include the app name, version (build) and install source.
- Flutter: builds with Android Gradle Plugin 9 and built-in Kotlin, and still with older versions
  (Flutter 3.27+).
- Flutter in-app panel: the Performance page no longer shows a "Dart heap" tile and chart line that never
  filled.
- `durbun_dio` works with dio 5.4 again.
- React Native: server-sent events and other open streams over XHR appear as soon as their headers arrive
  instead of staying pending.
- React Native: binary mock bodies arrive intact when they are valid UTF-8; other binary bodies on `blob`
  responses go to the network with a warning instead of arriving corrupted.
- React Native: watching a request no longer switches React Native to chunk-by-chunk response delivery.

### Changed

- Mac app: **Check for Updates…** shows what is new, downloads only after you say yes and asks before it
  restarts. A copy that cannot update itself (a local build, or one opened from the disk image) gets the disk
  image for your Mac. Dürbün asks once whether it may check by itself once a day
  (**Dürbün → Check for Updates Automatically**); that check reads one static file from GitHub Releases and
  carries no identifier.
- Export session and Export HAR open a dialog that shows the scope and the counts before saving.
- Network "Clear" (and ⌘⌫) asks first, with the number of requests; Shift skips the question.
- Crash records from the last 7 days (was 24 hours) are read when a phone connects.
- The SDK guides point to the Mac app's "Allow local network (Wi-Fi) connections" setting for Wi-Fi.
- React Native / JS SDK: while Dürbün is closed the SDK stops reading bodies after 30 seconds and keeps at
  most about 8 MB waiting; the oldest bodies are dropped before any request row.
- `npm run app:release` stops when the Developer ID or notarization variables are missing
  (`DURBUN_ALLOW_UNSIGNED=1` for a deliberate ad-hoc build) and verifies the built apps.
  `scripts/check-versions.mjs` covers lockfiles, the no-op SDK and the install snippets in the docs, and can
  write a new version with `--write`.
- `npm run release:check` runs every check a release needs and stops at the first problem; `app:release`
  writes the update feed files and clears old build files.
- Mac app: the diagnostic log is capped while Dürbün runs, and old crash dumps are removed at startup.

### Added

- Logs and Network say when the memory limit has dropped the oldest lines or requests.
- An iPhone with Developer Mode off says so, and actions that need it explain how to turn it on.
- Importing a masked recording says that `••••` values are masks.
- Mac app: `.durbun` packages and backups and `.durbun.json` recordings open from Finder (double click, Open
  With, the Dock icon), also when Dürbün is not running; **File → Open…** (⌘O).
- Mac app: **Help → Copy Diagnostic Info**; **Report an Issue…** fills in the version and environment and
  copies the diagnostics with secrets masked. About lists the Electron, Chromium, Node and server versions.
- Mac app: closing the window says once that capture continues in the menu bar; **Open at Login**; the
  menu-bar icon shows a dot for warnings; a copy opened from the disk image offers to move to Applications.
- Flutter in-app panel: **Tools → Mac connection** says why the app is not connected to the Mac and what to
  do next, with the addresses tried; debug builds print the same once in the console.
- Flutter in-app panel: the Mac's Wi-Fi address can be typed in at run time. It is kept for later launches,
  and "Use the build's address" goes back.
- Flutter in-app panel: **Tools → App tools** runs the app's own `DurbunAction`s and the built-in tools from
  the phone, without the Mac.
- Flutter: `Durbun.showInspector()` without a running SDK opens a page that says why and what to do, and the
  first launch shows a one-time "shake to open" hint (`DurbunInspector(showHint: false)` turns it off).
- Guides in `docs/guides`: Dürbün for testers, troubleshooting by symptom, mock rules, versions and
  upgrading, and Dürbün in test builds. The Android and iOS SDK guides gain a "Test builds" section.
- React Native / JS SDK: when no connection is made within 10 seconds, one console note lists the addresses
  tried and the fix for the device, and a line confirms when it connects.

## [0.2.0] - 2026-11-12

### Added

- **Flows.** A new tab for tests you draw as a graph: HTTP requests sent from the Mac, conditions, loops and
  variables, checks, waits on what the app does (a request, a log line, an event), mock rules switched on for a
  scenario, device actions (open a link, launch, clear data, screenshot, recording, dark mode, location…),
  notes, markers and Slack reports. Flows call each other as sub-flows with inputs and outputs, pick values
  from earlier steps with `{{templates}}`, and run against the device and app you choose, with environments
  (Staging, Production…) whose secret values stay on the Mac. Each run keeps its steps, timings, responses and
  screenshots in a run history. A flow can also start by itself when something happens (a crash, a failing
  request, a log line, an app connecting) while Dürbün is open.
- Make a flow from captured requests (Network → **Create a flow from this request…**, or several at once): the
  host becomes an environment variable and values from one response feed the next request.
- **Flows with your own AI.** Dürbün never calls an AI. **Write with AI** copies a pack (the flow format, every
  node type, your flows, environment keys and the app's recent requests without headers, bodies or query
  values) to paste into the assistant you use;
  paste its answer back and Dürbün checks it, shows what is new or changed, and imports it. The flow format is
  public: `docs/flows/durbun-flow.schema.json`.
- **Share your setup.** Flows (with the sub-flows they call), mock rules, environments, settings and look and
  log rules go into one `.durbun` file for your team. Secret values never go in.
- **Backups.** Everything Dürbün keeps in one `.durbun` file for a new Mac, by hand or automatically into a
  folder you choose (iCloud Drive, Dropbox…; Settings → Backup). Secret values go in only encrypted with a
  passphrase (AES-256-GCM). Opening a package shows what is new, what already exists and what differs, and asks
  whether to replace, keep both or skip.
- **Import a file** opens any Dürbün file by its contents: session recordings, packages and flows; drop them on
  the window too.
- **Send to Slack.** Share a log line or a request with your team's Slack channel in one click. The Mac app
  keeps one incoming webhook (Settings → Slack, stored in `slack.json` in the data folder, never shown again)
  and posts only when someone clicks Send; log lines get a Share dialog of their own (context menu, detail
  panel, command palette) with Copy, Save as .md and Send to Slack.
- **Add to Slack** (Settings → Slack, or https://appnify.dev/durbun/slack/): adds the Dürbün Slack app to a
  channel and shows that channel's webhook URL. The page trades Slack's code for the URL in your own browser
  (PKCE): no client secret, no server, nothing stored. The app's manifest and icon are in `docs/slack-app/`.
- Flutter in-app panel: **Send to Slack** on the request and log Share sheets, from the phone itself, with the
  webhook from `--dart-define=DURBUN_SLACK_WEBHOOK` or `DurbunOptions.slackWebhook`; log lines can be shared
  through the system share sheet too.

## [0.1.0] - 2026-11-09

First public release.

### Mac app and server

- Live logs from Android logcat, iOS devices (`idevicesyslog`, `devicectl`) and iOS simulators, merged with
  the app's own logs, errors, crashes and events. Stack traces and JSON fold, repeated lines collapse,
  crashes raise a banner. Crash reports (`.ips`, tombstones, ANRs) are read without an SDK.
- Network view for every captured HTTP(S) request: headers, bodies, timings, GraphQL labels, copy as
  cURL / fetch / Dio / Swift / OkHttp, resend or edit and send, compare, HAR export and shareable reports.
- Mock rules (`respond`, `delay`, `fail`) that the SDKs apply inside the app.
- Performance charts: CPU, memory, heap, FPS and jank, requests and logs per second.
- Device tools: screenshots, screen recording, deep links, app launch, stop, install and uninstall, dark
  mode, font size, location, simulator push and status bar, and app-defined actions.
- SDK-less Flutter debug apps attach automatically through the Dart VM Service.
- English and Turkish interface; a System check screen and an SDK setup guide.
- The Mac app (Electron, macOS 13+) runs the server inside the app; `npm start` runs it from the command
  line. Nothing leaves the Mac unless the user asks.

### SDKs

- Flutter: `durbun` (plugin with native Android and iOS layers and an in-app inspector) and `durbun_dio`.
- iOS: `Durbun` Swift package and pod (URLSession capture, `print` / `NSLog` output, crashes, metrics).
- Android: `io.github.mykynk:durbun` and the no-op `durbun-noop` (OkHttp interceptor, Timber, metrics).
- React Native / JavaScript: `@durbun/react-native` (fetch / XMLHttpRequest, console, errors).

[Unreleased]: https://github.com/mykynk/durbun/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mykynk/durbun/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mykynk/durbun/releases/tag/v0.1.0
