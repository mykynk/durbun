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
- Android: Dürbün never restarts an adb server of another version (for example Android Studio's). It uses a
  matching adb found on the Mac, or says what to do.
- Android: a phone connected over USB and Wi-Fi is one device. It moves between the two without losing log
  lines, and a new wireless-debugging port no longer creates a new device.
- iOS: **Stop** works for TestFlight and App Store apps, or says why iOS refuses.
- System check no longer runs `xcrun devicectl` on a Mac without Xcode, which could open the install dialog.
- Flutter debug apps that were started before Dürbün attach by themselves (Android, simulators).
- React Native: server-sent events and other open streams over XHR appear as soon as their headers arrive
  instead of staying pending.
- React Native: binary mock bodies arrive intact when they are valid UTF-8; other binary bodies on `blob`
  responses go to the network with a warning instead of arriving corrupted.
- React Native: watching a request no longer switches React Native to chunk-by-chunk response delivery.
- React Native: Expo Go apps show under their own bundle id, name and version instead of "main" or "Expo Go".
- A React Native app connected over Wi-Fi attaches to the plugged-in phone that runs it, and several iPhones
  no longer collapse into one row.
- An app's session export holds the same lines as the app's view shows, device lines included.
- A response too large to receive no longer stays pending: the request ends with a note that says so, and
  Dürbün writes a line when it drops a message from an app because it is too large or unreadable.
- React Native console lines on Android no longer show twice (once from the SDK, once from logcat).
- A search that froze the page is cleared on reload instead of coming back.
- A slow regular expression in a flow condition or URL rule can no longer freeze Dürbün.
- A flow whose header reported an error still showed "Ready" on the run button.
- A mock made from a request targets that request's app.
- Comparing two requests with identical bodies shows a short "identical" state instead of an empty table;
  the SDK guide buttons on the empty Network screen open the guide for the selected app's platform.
- React Native: large text responses fetched as Blobs no longer stall the app; the platform decodes them, and
  where it cannot, decoding runs in short slices.
- An app connected over Wi-Fi moves under the plugged-in phone it runs on once that phone reports it.
- After the Mac wakes from sleep, Dürbün checks device connections, port forwards and log streams again.
- A Flutter layout overflow is shown as an error line instead of a crash banner.
- Flutter in-app panel, new look: the selected tab and the main action in the accent colour, two-line request
  rows with one status signal, log levels as words, Performance and Statistics led by one large figure,
  grouped Tools, 44 pt tap targets, readable contrast in light and dark, and a 720 pt wide layout in
  landscape and on tablets.
- `durbun_dio`: requests answered by another interceptor, retried after a token refresh or cancelled no
  longer stay "pending". The new `DurbunDioAdapter` wraps the adapter, so every request that reaches the
  network has its own row with the bytes and the time the adapter delivered.
- Flutter in-app panel: opening a large body (256 KB or more) no longer freezes the app; the performance
  chart uses the display's real refresh rate; the panel stays left to right in right-to-left apps.
- Secondary text has more contrast in both themes.
- Slack: when Slack limits the rate, the message says how long to wait.
- iOS SDK: URLSessions that differ only in their additional headers (a new token after each login) share one
  capture slot, so long-running apps no longer stop showing requests of new sessions. When the limit of
  different session configurations is reached, a warning line says so on the Mac.
- Android SDK: a `respond` mock skipped because `DurbunInterceptor` was added as a network interceptor is
  explained on the desktop, not only in logcat.
- Flutter SDK: the README's wrapper for `CronetClient` / `OkHttpClient` keeps responses streaming instead of
  reading them into memory.
- Closing a request comparison also ends the "pick the second request" bar.
- A refused app install shows its reason in the interface language; the tool's error code stays as a short
  detail instead of a raw English line.
- The footer of paused automations was cut off and the last-run pill covered the minimap.
- A selected warning or error log row keeps its colour.
- Flows: the minimap no longer covers a step. The canvas fits the flow again when the run panel opens and gets
  its view back when the panel closes.
- Logs: the crash banner keeps the app and the device readable; the detail panel keeps its title and its footer
  on one line at narrow widths.
- Turkish: stack chips read "yığın satırı"; the pin-limit and Slack messages end with a full stop. Selected mock
  presets and the "new lines" pill keep their contrast in the light theme.
- The top bar keeps the device name readable next to the selected app in narrow windows instead of cutting it
  to one letter; both names have a tooltip. Server messages of more than one sentence end with a full stop.
- Flows: a step moved down to avoid an overlap stays on the grid.

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
- React Native / JS SDK: FPS measurement stops while the app is in the background.
- When the connection to Dürbün drops and comes back, the window continues where it was instead of loading
  everything again.
- When the memory limit deletes older log lines or requests, Logs and Network say how many went in the
  current view and why; the window keeps exactly what the server keeps.
- Turning Wi-Fi off or airplane mode on is refused for a device connected over Wi-Fi, because it would cut
  its connection.
- Device tab: reasons and action errors are worded in the interface language, with the tool, the versions
  and the install command as data, instead of English text inside the sentence.
- System check rows, device driver states and the errors for invalid action parameters, unreadable mock
  rules in a package and session import problems are worded in the interface language too.
- Light theme: level, method, status and SDK colours are darker where they were hard to read; a test checks
  every text and background pair (WCAG AA).
- Status bar badges open what they describe; "Connect Slack" in a share dialog connects in place.
- Removing a noise rule, a highlight rule or a saved filter can be undone; the level buttons show a level
  set in the search.
- `npm run app:release` stops when the Developer ID or notarization variables are missing
  (`DURBUN_ALLOW_UNSIGNED=1` for a deliberate ad-hoc build) and verifies the built apps.
  `scripts/check-versions.mjs` covers lockfiles, the no-op SDK and the install snippets in the docs, and can
  write a new version with `--write`.
- `npm run release:check` runs every check a release needs and stops at the first problem; `app:release`
  writes the update feed files and clears old build files.
- Mac app: the diagnostic log is capped while Dürbün runs, and old crash dumps are removed at startup.
- One Dürbün per data folder. A second one started on the same folder (the Mac app and the CLI, or two CLIs)
  opens the running one instead of both rewriting each other's settings, mock rules and flows;
  `--data-dir` gives a separate copy.
- The CLI opens `http://127.0.0.1:<port>` instead of `localhost`, where another program could answer on
  IPv6. A browser keeps interface preferences per address; at a new address Dürbün brings your settings
  back once from the copy the server keeps, with Undo.
- Flows: a regular expression that can take very long on some inputs is marked in the editor, and every
  match has a time limit.
- Flutter SDK: while no desktop answers, connection attempts slow down after two minutes to about one
  every 30 seconds and stop while the app is in the background; returning to the app tries at once.
- Less work while idle: Android devices are followed through adb's own device list instead of asking every
  two seconds, and simulators are not asked at all while none is open.
- iOS SDK: in a build compiled without `DEBUG`, Dürbün also runs in the Simulator, under a debugger and in
  builds signed for development, so custom configurations such as Debug-Staging work. Ad hoc, enterprise,
  TestFlight and App Store builds still need an explicit opt-in.
- Flutter SDK: sharing a log line from the panel masks secret values in its data, with a switch to turn
  that off; number and boolean values under secret keys are masked too.
- Flutter SDK: release builds with Dürbün off no longer contain the in-app panel's pages (about 0.85 MB
  less Dart code in a typical Android app). The README gives measured sizes and a compile-time gate that
  leaves Dürbün out completely.
- Docs: the SDK READMEs share one outline and one vocabulary (the Mac app, device logs, tools, masking) and
  a common option-name table; the React Native Wi-Fi restart step and the Android 8 MB body cap are
  documented.
- Mock rule hit counts are kept by the server: the same in every window, counted since Dürbün started.
- An app whose SDK connected earlier and is not connected right now says so (outlined SDK badge) instead of
  "no SDK". The empty network list says whether you cleared it, the app has not sent anything yet, or its
  SDK is not connected right now.
- Shared reports and bug reports mask secret values in log text, stacks and data, including numbers and
  true/false values under secret keys; HAR and session exports mask true/false values too.
- Package import messages for flows and mocks are in the interface language.
- The "oldest lines dropped" notes say where the list starts, the limit and that raising it keeps more.
- Primary and danger buttons pass AA contrast in both themes; a test checks them.
- Android SDK: FPS counts the frames the app actually drew (Android 7+), so an idle screen no longer reads
  as the display's refresh rate; janky frames use the frame's own deadline on Android 12+.
- Flutter in-app panel: a new look of its own in light and dark, with a switch in the header that keeps your
  choice. Network, Logs, Performance and Tools are tabs at the bottom; on a short screen they move into the
  header.
- Flutter in-app panel: requests and log lines are cards. A request shows a bar of its duration against the
  slowest listed request; tiles above the list show the total, the errors (tap to filter) and the average time.
- Flutter in-app panel: Performance is a tab and leads with the frame rate against the screen's refresh rate
  and the janky frames. Tools is a page: the app on a card, tiles for Statistics, Mac connection, App tools and
  Device & SDK, and Clear on a card of its own.

### Added

- **Report a bug.** One dialog from the crash banner, the crash notification, a log line, a request, ⌘K and
  the top bar. It gathers the moment's time window: the app's log lines, the failed requests, a fresh
  screenshot, device and app facts and your note, and shows the counts before anything leaves. Secret values
  are masked by default. Copy it as Markdown, save one .zip (report, logs, masked HAR, screenshot, iOS crash
  report and a Dürbün recording of the window) or send the text to Slack.
- Logs and Network say when the memory limit has dropped the oldest lines or requests.
- An iPhone with Developer Mode off says so, and actions that need it explain how to turn it on.
- Android: log lines of your apps from before the phone was plugged in are read from the phone's log buffer.
- Apps closed by the system for memory are shown: iOS Jetsam reports and Android low-memory kills.
- iPhones on iOS 16 and older say which actions need a newer iOS instead of failing without a reason.
- Importing a masked recording says that `••••` values are masks.
- iPhones that cannot use Xcode's device tools (iOS 16 and older, Developer Mode off, a Mac without Xcode 15)
  get their app list and crash reports through `ideviceinstaller` and `idevicecrashreport` when these are
  installed; System check lists both.
- Android: `.apks` (bundletool) and `.xapk` files install like an `.apk`; Dürbün picks the parts that fit the
  phone. A refused install says why: another signature, an older version, no space, blocked by a phone
  setting.
- Android: dark mode, font scale and animation changes remember the value from before. The device card
  lists what Dürbün changed, and **Undo** puts it back.
- Android: **End in background** ends an app the way the system does under memory pressure, to check that
  it restores its state.
- Android: the device card can enlarge the phone's log buffer to 16 MB, shows both connections of a phone
  that is plugged in and on Wi-Fi, and names two phones of the same model apart.
- Android: how long a screen took to open (`Displayed … +350ms`) is shown on its log line.
- Apps the system closed for memory have their own badge and crash banner, and `is:oom` finds them.
- System check gives the command that fixes a simulator problem.
- A line says when an app's SDK is newer than this Dürbün understands or older than it supports, and when a
  phone's clock is far off the Mac's. The app's info panel shows the SDK protocol, what to update when it
  does not match, and how far the device clock is off.
- Reports of an earlier launch (Android exit reasons, iOS MetricKit), screen changes (`is:nav`) and app
  lifecycle changes read as plain rows in the log list; `is:anr` finds exits after an ANR.
- Flows: a flow with problems or a failed run can be handed to your AI tool from the More menu and the run
  panel.
- Exported flow files name their schema, so editors complete and check them without setup; the pack for
  your AI tool lists the flow's problems and what failed in its last run.
- Flows: an environment can trust extra certificates (an internal CA) or turn certificate checks off for a
  self-signed test server. The check before a run and the run history say when checks were off.
- Network: a request the Mac could not resend because of the server's certificate can be sent once without
  the check.
- Importing a recording says how much of it fit when the file is larger than the log limit.
- Demo mode comes with two example flows.
- HAR files open in Dürbün: the import button, a drop on the window, or a `.har` file opened with the Mac
  app.
- Performance: drag a time range on a chart to jump to its first error, its log lines and its requests.
- Flows: three starter flows in the new-flow menu and on the welcome page; an import that has problems can
  be copied as a text for your AI tool, and an imported flow shows what it changes step by step.
- Device tab: actions that are missing on a device are listed with the reason (a tool on the Mac or a
  setting on the phone) and a link to System check.
- Settings shows the Mac app's own options: check for updates automatically and open at login.
- Mac app: **Window → New Window** (⌘N, also in the Dock menu) opens another window, so two devices can be
  watched side by side. Clicking a notification brings forward the window that sent it.
- Mac app: the ports and the verbose diagnostic log can be kept in the app's own settings file, so a copy
  opened from Finder no longer needs environment variables for them; environment variables still win.
  **Settings → Mac app** changes them and restarts the app after asking.
- Several windows share settings live; each keeps its own tab and panel sizes.
- Device tab: the reason is shown when an action is not available on this device.
- Device tab, tester controls: app permissions and app language, airplane mode, Wi-Fi, mobile data, screen
  rotation, "Don't keep activities" and the simulator keychain reset. Every setting Dürbün changed is listed
  with its previous value and can be put back.
- Device tab: when Android refuses an install (another signature or an older version), Dürbün can remove
  the installed copy and install again, after a warning.
- Device tab: a picker for Android users and work profiles; app actions apply to the chosen one.
- Device tab: a full Android device report with progress and cancel, also offered from Report a bug.
- Logs: show only the lines around a moment (±10 s to ±5 min) or a span dragged on the histogram with
  Shift; select several lines with Shift/⌘-click or Shift+↑/↓; copy or share just those lines. Shared lines
  mask passwords, tokens, cookies and keys by default.
- Network: App and Device columns, shown by themselves when the list mixes devices or apps; a note above the
  list when some of an app's requests cannot be captured, with the fix.
- Network: JWTs in headers, cookies and query values are decoded on your Mac: claims, header, and whether
  the token was still valid when the request was sent.
- Network: with body search on, the request detail opens where the text was found and highlights it; "Show
  in logs" opens the moments around a request when its own log line is no longer in memory.
- Mocks: a rule's hit count keeps the session total when the request list is cleared, and clicking it opens
  the requests it answered; Live test warns when an all-apps rule catches several apps.
- Flows: unsaved edits are kept on this Mac and offered back when the flow is opened again.
- Flows: new device steps for app permissions, app language, airplane mode, Wi-Fi, mobile data, screen
  rotation and "Don't keep activities"; each puts the setting back when the run ends unless you turn that
  off.
- Flows: a bar under the list shows every flow that runs on its own; switch one off, or pause them all and
  resume later. The step picker puts an exact name first, explains steps in plain words and marks steps
  that cannot run on the flow's device.
- Command palette: screenshot, record, restart the app, device info, open or run a flow, open a mock rule
  and pause automations; the shortcuts window lists every shortcut, including the flow editor.
- The first-launch screen can open a file or restore a backup; dropping several files imports all of them
  with one summary. The SDK guide says when your app has connected and what to check if it does not.
- When another window changed the mock rules, a flow or the environments first, a save stops and asks: load
  the current version or save yours.
- Keyboard: the sidebar is one Tab stop with arrow keys, `i` opens "What can I see?", and Shift+F10 opens a
  request's menu in the network list. Flow steps announce their connections to screen readers.
- Mac app: `.durbun` packages and backups and `.durbun.json` recordings open from Finder (double click, Open
  With, the Dock icon), also when Dürbün is not running; **File → Open…** (⌘O).
- Mac app: **Help → Copy Diagnostic Info**; **Report an Issue…** fills in the version and environment and
  copies the diagnostics with secrets masked. About lists the Electron, Chromium, Node and server versions.
- Mac app: closing the window says once that capture continues in the menu bar; **Open at Login**; the
  menu-bar icon shows a dot for warnings; a copy opened from the disk image offers to move to Applications.
- Mac app: the menu bar shows how many devices and apps are connected; **Help → Dürbün Guides** opens the
  guides; **Help → Verbose Diagnostic Log**; macOS permission prompts (local network, Documents, Desktop,
  Downloads) say why Dürbün asks, in English and Turkish.
- Flutter in-app panel: **Tools → Mac connection** says why the app is not connected to the Mac and what to
  do next, with the addresses tried; debug builds print the same once in the console.
- Flutter in-app panel: the Mac's Wi-Fi address can be typed in at run time. It is kept for later launches,
  and "Use the build's address" goes back.
- Flutter in-app panel: **Tools → App tools** runs the app's own `DurbunAction`s and the built-in tools from
  the phone, without the Mac.
- Flutter: `Durbun.showInspector()` without a running SDK opens a page that says why and what to do, and the
  first launch shows a one-time "shake to open" hint (`DurbunInspector(showHint: false)` turns it off).
- Flutter: `DurbunNavigatorObserver` sends screen changes as `navigation` events, and app lifecycle changes
  arrive as log lines; `DurbunOptions.maxBodyBytes` and `captureBodies` set the body limit and body capture
  from code.
- Flutter in-app panel: the Device & SDK page lists what is not captured (background isolates, native HTTP
  stacks, WebView, WebSocket messages), and Tools always shows **Previous run** with how to turn it on.
- React Native: `waitForDesktop` lets mock rules apply to requests made at launch;
  `Durbun.network.begin` reports requests from clients the SDK cannot see (file downloads, gRPC-web);
  `Durbun.trackNavigation(ref)` sends screen changes as events; an Appearance action (system, light, dark);
  the `@durbun/react-native/noop` entry keeps the SDK out of release bundles.
- Guides in `docs/guides`: Dürbün for testers, troubleshooting by symptom, mock rules, versions and
  upgrading, and Dürbün in test builds. The Android and iOS SDK guides gain a "Test builds" section.
- `docs/README.md` lists every guide by reader. The bug report form asks for the build type, the connection
  and the diagnostic info, and questions have their own place in Discussions. The security policy covers
  files from someone else, backups, flows and updates, says what is out of scope and when to expect an
  answer.
- React Native / JS SDK: when no connection is made within 10 seconds, one console note lists the addresses
  tried and the fix for the device, and a line confirms when it connects.
- React Native: a fatal JS error that ends the app before it reaches Dürbün shows on the next launch as
  "Previous launch crashed — …". iOS keeps it in React Native's Settings; on Android pass a store with the
  new `crashStorage` option (MMKV or AsyncStorage); `crashStorage: false` turns it off.
- React Native: "Toggle element inspector" and "Open debugger" actions in development builds; new-architecture
  apps without the interop layer are identified correctly and get the dev menu action.
- Android and iOS SDKs: when no desktop connects within about 10 seconds, one console line says what was
  tried, the likely reason and the next step. `Durbun.connectionStatus` gives the same in code, for a status
  label in the app's debug menu (iOS also posts a notification when it changes).
- Android and iOS SDKs: the Mac's Wi-Fi address can be given without a rebuild. `Durbun.setDesktopHost`
  takes it at run time and keeps it for later launches; a launch extra (`durbun.host`, debuggable Android
  builds) or launch argument (`-DurbunHost`, iOS) does the same from Android Studio, Xcode or a test runner;
  a manifest entry (`dev.durbun.host`) or Info.plist key (`DurbunHost`) sets it per build.
- Android SDK: how earlier launches ended is reported on the next launch (Android 11+): ANRs with the main
  thread's stack, native crashes with their signal, low-memory kills and other system kills.
- iOS SDK: MetricKit diagnostics of earlier launches are reported (iOS 14+): crashes the SDK could not catch
  such as watchdog kills, main-thread hangs, CPU and disk-write exceptions, slow launches.
- Android SDK: `DurbunEventListenerFactory` shows DNS, connect, TLS, send and wait times of OkHttp calls and
  keeps the app's own event listener working.
- Android SDK: `redactHeaders` and `ignoredHosts` in `DurbunOptions` apply to every OkHttp client.
- Android SDK: Appearance (light / dark, Android 12+), Dump view hierarchy and Dump SharedPreferences tools.
- Android SDK: Dürbün can start without code: add `<meta-data android:name="dev.durbun.autoStart"
  android:value="true" />` to the app's manifest. Without the entry nothing changes.
- Android SDK: when no OkHttp client has `DurbunInterceptor`, one line on the desktop says why the network
  list is empty.
- iOS SDK: `captureBodies`, `maxBodyBytes`, `appName` and `captureOSLog` options.
- iOS SDK: usable from Objective-C as `DURDurbun`.
- iOS SDK: the `DurbunEnabled` Info.plist key turns Dürbün on or off per build configuration.
- Flutter SDK: `Durbun.log` and `Durbun.event` work in background isolates (`compute`, `Isolate.run`,
  background engines) with no setup; `Durbun.attachIsolate()` also captures that isolate's HTTP requests.
- Flutter SDK: `DurbunOptions.secretNames` adds your own field names to the masking used by Share, Send to
  Slack, Export and the previous-run file.
- Flutter SDK: stacks from `--split-debug-info` / `--obfuscate` builds are marked in the panel and in shared
  reports, with the `flutter symbolize` command; the crash carries the command to the desktop as `symbolize`.
- Flows: pin a run to keep it through automatic clean-up and "Clear history" (up to 50 pinned runs). The
  history lists the runs with a pin toggle and says how many pinned runs were kept.
- Flows: a flow made from requests shows where the requests came from and the filter that was on, and can
  pick all visible requests.
- Logs: a crash or Flutter error from a `--split-debug-info` build explains the address-only stack and offers
  the `flutter symbolize` command, with copy and "Save as stack.txt".
- Network: when an Android app has no `DurbunInterceptor`, the empty list says so; a mock skipped by a
  network interceptor links to its rule and its request.
- The sidebar folds by itself on windows narrower than 1000 px and comes back when there is room; your own
  choice wins.
- Android SDK and iOS SDK: the cold start time is sent once as the `durbun.launch` event: process start
  (the launch request on Android 13+) to the first drawn frame. Prewarmed iOS launches say so and carry no
  duration.
- Android SDK: UI-thread and RenderThread time per frame (Android 7+).
- Wire protocol and server: WebSocket messages and Server-Sent Events have a contract (`net.ws`, `net.sse`,
  capability `streams`, asked for by the server's `captureStreams`). The server keeps them per connection
  within limits and counts what it drops; session export / import and HAR files (`_webSocketMessages`,
  `_eventSourceMessages`) carry them, masked like bodies.
- Network: WebSocket and SSE connections. The list shows each connection's state, message count and how long
  it has been open; a Messages tab shows every message with its direction, time since the connection opened,
  type and size, with search, a ping / pong switch, follow-live, JSON / text / hex payloads, close codes by
  name and a note where the memory limit removed messages. A connection whose messages were not captured says
  why. Replay, edit and send, mock, compare and flows say that they do not apply to connections.
- Settings → Network: a switch to capture WebSocket and SSE messages (on by default).
- React Native / JavaScript SDK: WebSocket messages and server-sent events. Each connection is one entry in
  Network with its messages in the order the app saw them (both directions, text and binary, close codes and
  reasons); SSE from `XMLHttpRequest`-based libraries such as `react-native-sse`, from `fetch` streams and from
  the browser's `EventSource`. They are sent only while the Mac app asks for them, and their payloads follow the
  body settings.
- Android SDK: Server-Sent Events (okhttp-sse, Retrofit `@Streaming`, plain calls) show as one entry with their
  events, the end of the stream, a cancel or an error; `DurbunInterceptor` is all they need.
- Android SDK: `DurbunWebSocketFactory` opens OkHttp WebSockets whose text, binary and close frames, in both
  directions, show under the handshake entry. It is a `WebSocket.Factory`, so it also fits Ktor's OkHttp engine.
  A socket opened with `client.newWebSocket` shows its handshake and one line saying how to see its messages.
  A busy socket drops its own oldest messages before any log or request.
- iOS SDK: `URLSessionWebSocketTask` connections show with their handshake, every text and binary message in
  both directions, the app's pings and their pongs, and the close frame with its code and reason. Completion
  handlers and `async` calls both work, with no code change.
- iOS SDK: Server-Sent Events over URLSession show one row per event (`event`, `id`, `retry` and the data) as
  they arrive; the stream is no longer held as a response body.
- Android SDK and iOS SDK: `DurbunWebView.attach(...)` shows what a page inside a `WebView` / `WKWebView` does:
  its fetch and XMLHttpRequest calls in Network (client `webview:fetch` / `webview:xhr`) and its console lines
  and uncaught errors in Logs (tag `webview`). On Android the page is covered from its first request when the
  app has androidx.webkit; without it, call `DurbunWebView.onPageStarted`. `durbun-noop` has the same API.
- Android SDK and iOS SDK: sample apps (`sdks/android/sample`, `sdks/ios/Example`) tour every feature against a
  built-in local server.
- iOS SDK: an API reference (DocC catalog `Durbun.docc`), set up for Swift Package Index (`.spi.yml`).
- Flutter SDK: WebSocket messages and Server-Sent Events from dart:io (`WebSocket.connect`,
  `IOWebSocketChannel`, `package:http`, Dio) with no code change, compressed messages decoded; background
  isolates included. `DurbunNetwork.webSocket(...)` and `DurbunHttpCall.eventStream(...)` report sockets and
  streams that dart:io does not carry. `durbun_dio` shows event streams read with `ResponseType.stream`. On
  Android and iOS the native cores in the plugin report OkHttp and URLSession streams too.
- Flutter in-app panel: WebSocket messages and Server-Sent Events show on the phone, without the Mac. A
  connection's row carries WS or SSE, its state and the message count; its detail opens on **Messages**
  (**Events**) with direction, time since open, kind and size, search, a ping/pong switch and how the
  connection ended. A message opens as JSON, text or hex and shares with secrets masked. The phone keeps the
  first 20 and the newest messages of a connection (500 in all, 16 KB of each) and says where it dropped
  some. OkHttp, URLSession and background-isolate connections show their messages there while the Mac app
  records them.
- Flutter in-app panel: **Report a bug** sends what just happened from the phone alone, without the Mac: the
  log lines and failed requests around a crash, an error, a failed request or the moment the panel opened, a
  screenshot of the app as it was before the panel covered it, the device and app facts and your note. The
  page shows the counts before anything leaves and the screenshot can be left out. One share sheet carries
  the Markdown text, the full report as a `.md` file and the screenshot as a PNG. Secret values are masked by
  default, in log text too.
- Logs and Performance: the cold start time the Android and iOS SDKs measure (`durbun.launch`) reads as a line
  in Logs ("Cold start 1.24 s"; a prewarmed iOS launch is named and carries no time) and as a Launch tile in
  Performance that opens the line.
- Performance: frame times have their own chart, named after the platform (Flutter build / raster, Android UI
  thread / RenderThread). An Android or Flutter app that draws nothing reads as idle, never as 0 FPS.
- Flows: run several flows as one set, picked by hand or by tag, one after another on one device. Before it
  starts you see which flows are ready and which will be skipped, and why; flows with hard-to-undo steps run
  only when you tick the box. You can follow or stop the set and get one report per set: copy it, save it as
  .md, send it to Slack or share it together with its runs.
- Flows: version history with Restore, and Undo for a restore. A deleted flow can be undone from the toast
  and stays under **Deleted flows** for 30 days.
- Logs: saved filters travel with backups and packages and follow your other windows; an import adds them to
  the filters already there.
- Device: screenshots and screen recordings are kept in a library on this Mac (30 days, up to 2 GB or 1000
  items, oldest removed first) and survive a reload and a restart. Each one leaves a line on the device's log
  timeline that opens it.
- Device: **Pull app data** saves a debuggable Android app's data folder, or a simulator app's data
  container, as one `.tar.gz` (up to 1 GiB, caches left out). Each refusal says why: not a debug build, not
  installed, phone locked, too large.
- Device: **Pair over Wi-Fi** connects an Android 11+ phone without a cable: the steps for the phone, the
  phones seen on the network, the address and the six-digit code.
- Device: an iPhone gets a step-by-step guide for its full diagnostic report (sysdiagnose) and where to find
  it.
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
