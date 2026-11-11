# Changelog

All notable changes to Dürbün are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org). The Mac app, the server and every SDK share one version.

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
