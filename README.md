<p align="center">
  <img src="apps/desktop/build/icon.png" width="96" height="96" alt="">
</p>

<h1 align="center">Dürbün</h1>

<p align="center">
  Live logs, network traffic and performance for Android and iOS apps, on your Mac.
</p>

<p align="center">
  <a href="https://pub.dev/packages/durbun"><img src="https://img.shields.io/pub/v/durbun?label=pub.dev" alt="pub.dev"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  English · <a href="README.tr.md">Türkçe</a>
</p>

![Dürbün's network view: a list of HTTP requests and the JSON response of the selected one](docs/images/network.png)

Plug in an Android or iOS device, or start a simulator or emulator, and Dürbün shows everything the app
does in one readable, live window. *Dürbün* is Turkish for binoculars.

- **Logs.** Android logcat, the iOS device and simulator logs, your app's own logs, errors, crashes and
  events. Multi-line output, stack traces and JSON fold; repeated lines collapse into ×N; crashes stand out.
- **Network.** Every HTTP(S) request with headers, bodies and timings. Copy as cURL, fetch, Dio, Swift or
  OkHttp, resend or edit and send, compare two requests, export HAR.
- **Mocks.** Answer matching requests with a canned response, add latency or simulate a failure. The SDK
  applies the rules inside the app, so no proxy or certificate is involved.
- **Performance.** CPU, memory, heap, FPS and jank, requests per second and logs per second.
- **Device tools.** Screenshots and screen recording, deep links, launch, stop, install and uninstall apps,
  dark mode, font size, location, simulator push notifications, status bar overrides, and buttons your app
  adds itself.

Device logs need no SDK. Flutter debug apps without the SDK are attached automatically through the Dart VM
Service. The SDKs add app logs, network capture, metrics and mocks.

The interface is available in English and Turkish and follows your system language.

![Dürbün's log view: logs from three devices, a crash banner and a folded stack trace](docs/images/logs.png)

## Install

### Mac app

Download the DMG for your Mac from [GitHub Releases](https://github.com/mykynk/durbun/releases/latest):
`Durbun-<version>-arm64.dmg` for Apple silicon, `Durbun-<version>-x64.dmg` for Intel. Open it and drag
Dürbün to Applications. Requires macOS 13 Ventura or later.

Release builds are not notarized yet, so macOS asks once on first launch: right-click Dürbün in Finder →
**Open** → **Open**. If macOS does not offer that, go to System Settings → Privacy & Security and click
**Open Anyway** next to Dürbün.

Dürbün never checks for updates on its own. **Dürbün → Check for Updates…** opens the download page when a
newer release exists.

### Requirements

| For | You need |
|---|---|
| The Mac app | macOS 13 or later (Node.js is built in) |
| The command line (`npm start`) | Node.js 20 or later |
| Android devices and emulators | `adb` (Android SDK Platform-Tools) |
| iOS simulators | Xcode (`xcrun simctl`) |
| Physical iOS devices | Xcode and `idevicesyslog` (`brew install libimobiledevice`; the copy in Flutter's cache also works) |

The **System check** screen in the app tells you what is missing and how to fix it.

### Try it without a device

```bash
git clone https://github.com/mykynk/durbun.git && cd durbun
npm install
npm run demo
```

The demo starts with simulated devices, apps, logs and network traffic.

## Add the SDK to your app

The **SDK setup** screen in the app shows the same steps with copyable snippets.

| Platform | Install | Guide |
|---|---|---|
| Flutter | [`durbun`](https://pub.dev/packages/durbun) on pub.dev, plus [`durbun_dio`](https://pub.dev/packages/durbun_dio) for Dio's native adapters | [sdks/flutter/durbun](sdks/flutter/durbun/README.md) |
| iOS (Swift, URLSession) | Swift Package Manager: `https://github.com/mykynk/durbun` from `0.1.0`; CocoaPods from the `v0.1.0` tag | [sdks/ios](sdks/ios/README.md) |
| Android (Kotlin, OkHttp) | Gradle, from this repository (`io.github.mykynk:durbun`; Maven Central publication is pending) | [sdks/android](sdks/android/README.md) |
| React Native / JavaScript | A packed tarball of this repository (`@durbun/react-native`; not on npm yet) | [sdks/js](sdks/js/README.md) |

The SDKs are off in release builds unless you turn them on; each guide shows how. They connect on their
own: `adb reverse` on Android, usbmux on iOS devices, `127.0.0.1:9751` on simulators. Wi-Fi works too when
you allow LAN connections.

## Privacy

- Dürbün sends nothing off your Mac on its own: no analytics, no telemetry, no automatic update check.
  Crash dumps stay on the Mac.
- Requests leave the Mac only when you ask: **Check for Updates** (one call to the GitHub API) and
  resending a captured request (to that request's own host).
- The server listens on `127.0.0.1` only. Turn on **LAN** in Settings (or pass `--lan`) to let devices on
  the same network reach the SDK port.
- The SDKs send what they capture only to the Dürbün on your Mac.

## The Mac app in detail

<details>
<summary>Ports, window, shell environment, quitting and diagnostics</summary>

- Dürbün runs its server inside the app and opens the interface in its own window; no terminal needed.
- Ports 9750 (interface) and 9751 (SDKs). If a Dürbün is already running, for example `npm start`, the app
  opens that one and starts its own server once the other stops; the menu bar icon tells you if the
  versions differ. The window only connects to a server that proves it is Dürbün (`/api/health` name and
  version, and the Dürbün interface at `/`). If another program holds the port, Dürbün tries 9760, 9770 and
  9780 and shows the port it uses in the menu bar.
- The window opens the server at `http://127.0.0.1:<port>`, not `localhost`, which tries `::1` first where
  another program may be listening.
- Menus and menu bar notices follow the interface language (the system language on first launch). The
  server's English text goes to the diagnostic log.
- The server and the interface ship inside `app.asar`; Electron's integrity check refuses to run a modified
  copy.
- Dürbün reads `PATH` and tool settings (`ANDROID_HOME`, `JAVA_HOME`, fvm, `DEVELOPER_DIR`) from your login
  shell, so `adb`, `flutter` and `idevicesyslog` are found as in Terminal. If the shell does not answer
  within 3 seconds, the menu bar icon says so.
- Closing the window does not stop capturing; Dürbün keeps running in the menu bar. Quit with ⌘Q or the
  menu bar icon → **Quit**, which stops the server cleanly.
- If the server cannot start, the window explains why and offers **Try Again**, **Show Diagnostic Log** and
  **Quit**. Help → **Report an Issue…** opens a new GitHub issue; Help → **Licenses** lists third-party
  licenses.

</details>

## Command line

```bash
npm install
npm run build
npm start
```

The interface opens at http://localhost:9750, in a chromeless app window when Chrome, Brave, Edge, Arc or
Chromium is installed.

```
node dist/durbun.mjs [--port 9750] [--sdk-port 9751] [--demo] [--no-open] [--lan]
                     [--data-dir ~/.durbun] [--ui-dir PATH] [--verbose]
```

Settings and mock rules live in `~/.durbun`.

## Build the Mac app

```bash
npm install
npm run app:dist
```

This builds `Durbun-<version>-arm64.dmg` and `mac-arm64/Dürbün.app` in `apps/desktop/release/`, ad-hoc
signed for this Mac. `npm run app:release` builds the Apple silicon and Intel DMG and ZIP. With a
"Developer ID Application" certificate in `CSC_NAME` (or `CSC_LINK` + `CSC_KEY_PASSWORD`) the app is signed
with the hardened runtime, and with `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (or
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`) it is also notarized.

`npm run app` runs the app against the repository's `dist/`. For a second copy or tests, set
`DURBUN_PORT`, `DURBUN_SDK_PORT`, `DURBUN_DATA_DIR` (default `~/.durbun`), `DURBUN_USER_DATA_DIR` (window
state, single-instance lock and logs), `DURBUN_DEMO=1` or `DURBUN_DEBUG=1`.

## Uninstall

1. Quit Dürbün (⌘Q) and move it from Applications to the Trash.
2. To remove its data as well, delete:
   - `~/.durbun`: settings (`settings.json`), mock rules (`mocks.json`) and temporary files.
   - `~/Library/Application Support/Dürbün`: window state, interface preferences, the diagnostic log and
     crash dumps.
3. Remove the SDK packages from your apps.

## Development

```bash
npm run dev          # server from source (restarts on change) + Vite on http://localhost:5173
npm run typecheck
npm test
npm run app:test     # the Mac app
```

| Folder | Contents |
|---|---|
| `packages/protocol` | Data types and commands shared by the server, the interface and the SDKs |
| `packages/server` | Device drivers (adb, simctl, devicectl, idevicesyslog), SDK connections, the Dart VM Service bridge, HTTP/WebSocket API, demo, CLI |
| `packages/ui` | The React interface: Logs, Network, Mocks, Performance, Device ([structure](packages/ui/src/README-ui.md)) |
| `apps/desktop` | The Mac app (Electron) |
| `sdks/*` | The Flutter, Android, iOS and React Native SDKs |
| `SPEC.md` | Product and engineering specification |

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) to
report a vulnerability.

## Versioning

Dürbün follows [Semantic Versioning](https://semver.org). The Mac app, the server and every SDK share one
version and are released together from a `vX.Y.Z` tag on `main`; changes are listed in
[CHANGELOG.md](CHANGELOG.md). While the version is `0.x`, minor releases may include breaking changes.

## License

[MIT](LICENSE) © 2026 Muhammed Yusuf Kaynak
