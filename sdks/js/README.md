# Dürbün: React Native / JavaScript SDK

`@durbun/react-native` streams **all logs** (console, your own logs, errors and crashes), **all network traffic**
(fetch, axios, XMLHttpRequest) and JS performance samples of your app to the Dürbün desktop app, live. It also
applies Dürbün's mock rules (fake responses, latency, failures) inside the app.

- **Zero runtime dependencies**; works in React Native (Hermes/JSC), browsers and Node.
- **No-op in release builds** (`enabled` defaults to `__DEV__`).
- Never changes app behavior: the original `console` methods are called, request and response bodies are never
  consumed, the React Native red box and LogBox keep working, and SDK failures never reach the app.

## Install

```sh
npm install @durbun/react-native
# or: yarn add @durbun/react-native
```

There is no native code: no `pod install` and no Gradle changes, so it also works in Expo projects (dev client
and Expo Go).

### Unreleased changes from a clone

To try changes that are not released yet, install from a clone of the Dürbün repository using the **packed `.tgz`,
not the folder** (Metro cannot resolve `react-native` through a symlinked folder outside the app):

```sh
# 1) In your clone of the Dürbün repository: build the package (prepack builds it automatically)
cd /path/to/durbun/sdks/js
npm pack                      # → durbun-react-native-0.2.0.tgz

# 2) In your app
npm install /path/to/durbun/sdks/js/durbun-react-native-0.2.0.tgz
# or: yarn add file:/path/to/durbun/sdks/js/durbun-react-native-0.2.0.tgz
```

## Start it in `index.js`

```js
import { AppRegistry } from 'react-native';
import { Durbun } from '@durbun/react-native';
import App from './App';
import { name as appName } from './app.json';

Durbun.start(); // does nothing unless __DEV__

AppRegistry.registerComponent(appName, () => App);
```

> Imports run before `Durbun.start()`. If any of your modules make requests while loading, move the call into
> its own file and import it first: `durbun.js` contains `Durbun.start();` and `index.js` starts with
> `import './durbun';`.

## Connecting a device

| Target | What to do |
|---|---|
| **Android device (USB)** | Nothing. For every connected device Dürbün points the phone's port 9750 (with `adb reverse`) at a separate device gateway on the Mac that serves only the SDK connection, so `localhost:9750` on the phone reaches Dürbün **automatically**. Do not create this mapping by hand: pointed at Dürbün's own port 9750, it would give every app on the phone Dürbün's full interface and API. To check it, `adb reverse --list` should show a `tcp:9750` line that points at a different port (the gateway's). |
| **Android emulator** | Nothing (the same automatic mapping; the emulator alias `10.0.2.2` is also tried). |
| **Android device over Wi-Fi (no USB)** | Like an iPhone: turn on **Settings → Allow local network (Wi-Fi) connections** in Dürbün and pass the Mac's LAN IP address: `Durbun.start({ host: '192.168.1.20' })`. |
| **iOS simulator** | Nothing. The simulator shares the Mac's network, so `localhost` works. |
| **iOS physical device** | The phone cannot reach the Mac through `localhost`. In the Mac app, turn on **Settings → Allow local network (Wi-Fi) connections** (from a source checkout: `node dist/durbun.mjs --lan`), keep the phone and the Mac on the same Wi-Fi network, and pass the **Mac's LAN IP address** (System Settings → Network): `Durbun.start({ host: '192.168.1.20' })`. Without `host`, the SDK also tries the Metro dev-server host (usually the same Mac). iOS asks for the Local Network permission on the first connection. |
| Browser / Node | `Durbun.start()` is enough. For Node < 22: `Durbun.start({ WebSocket: require('ws') })`. |

If no Dürbün has accepted the app 10 seconds after `Durbun.start()`, the SDK prints one `console.info` note
(in the Metro terminal): the addresses it tried and what to do for this device. It keeps retrying, and prints
one more line when the connection works.

While disconnected, the SDK keeps the last 5 000 messages (about 8 MB at most), reconnects with backoff
(0.5 s → 3 s) and sends them all in order once connected. So that an app that keeps `Durbun.start()` costs
almost nothing while Dürbün is closed:

- Bodies are read while Dürbün is connected, during the first 30 seconds after start (while it may still be
  connecting) and for 30 seconds after it went away. Requests made outside these windows arrive with their
  method, URL, headers, status and timings, and only the body's size.
- Past about 8 MB, the oldest waiting bodies are dropped first (the request stays, its body shows as
  truncated); only then the oldest messages. If any message had to be dropped, a warning line says how many.

## Usage

```js
import { Durbun } from '@durbun/react-native';

Durbun.log('User logged in', { tag: 'auth', data: { userId: 42 } });   // level via { level: 'debug' }, default info
Durbun.debug('Read from cache', { data: cacheEntry });
Durbun.info('Cart updated');
Durbun.warn('Slow response', { data: { ms: 3200 } });

try {
  await pay();
} catch (e) {
  Durbun.error('Payment failed', e);                                  // short form
  Durbun.error('Payment failed', { error: e, tag: 'payment', data: { orderId } });
}

Durbun.event('purchase', { amount: 49.9, currency: 'USD' });

// A button / toggle for this app in Dürbün's Device tab
Durbun.addAction({ id: 'app.clearCache', label: 'Clear cache' }, async () => {
  await cache.clear();
  return { ok: true };
});
Durbun.addAction({ id: 'app.mockLocation', label: 'Mock location', kind: 'toggle', value: false }, ({ value }) => setMockLocation(!!value));

Durbun.stop();             // restores every patched API
Durbun.isStarted; Durbun.isConnected;
```

- `data` may be any value: cycles, BigInt, Date, Map/Set and Error are snapshotted safely and shown in Dürbün
  as a collapsible JSON tree.
- A leading `[Tag]` in a console message, as in `console.log('[Auth] token refreshed')`, becomes the row's tag
  chip (`Auth`). Objects appear as single-line JSON in the message and as a tree in the details.

## What is captured

| | |
|---|---|
| **console.\*** | `log/info/debug/warn/error/trace/assert/dir/table`; `%s %d %o %c` formatting, objects → JSON data, Errors → stack traces. `captureConsole: 'auto'` (default): when Dürbün already receives the device's own log stream (Android logcat, iOS simulator), console lines are **not sent again**, so rows are not duplicated. |
| **SDK logs** | `Durbun.log/debug/info/warn/error`, `Durbun.event`. |
| **Network** | Everything that goes through `XMLHttpRequest`: React Native `fetch`, axios and others. Method, URL, headers, request and response bodies (text/JSON as text, binary as base64, FormData field summary, Blobs), status code, timings (wait / receive), errors, timeouts and cancellations. In browsers and Node, native `fetch` is captured too; each request is reported **once**. Body limits come from Dürbün's settings (default 1 MB). Responses that stay open (server-sent events, NDJSON, media streams) are shown as soon as their headers arrive, with the size only. Metro's and Dürbün's own traffic is ignored. |
| **Mocks** | Rules from Dürbün's Mocks tab: *respond* (a fake response, the network is never hit), *delay* (then the real request; the app's own timeout still applies), *fail* (the platform's natural error, `Network request failed` in React Native). In React Native, a binary (base64) mock body cannot be delivered intact to a `blob` response (what `fetch` uses) unless it is valid UTF-8, because React Native's `Blob` only holds text: such a request goes to the network instead and Dürbün shows a warning line saying why. Text, JSON and `arraybuffer` responses are mocked as usual. |
| **Errors** | Uncaught errors via `ErrorUtils` (the previous handler chain is kept): fatal ones appear as **crash** rows. In React Native, unhandled promise rejections in dev builds, read from React Native's own rejection tracker (LogBox in 0.71–0.81, the "Uncaught (in promise)" error in 0.82 and later, the console warning before 0.71); LogBox still shows them. React Native does not track rejections in release builds, so none are reported there. On the web, `error` and `unhandledrejection`; in Node, `uncaughtExceptionMonitor`. |
| **Performance** | JS heap (Hermes), JS-thread FPS and janky frame count (the "JS FPS" of the RN perf monitor). |
| **Actions** | "Reload JS" and "Open dev menu" buttons in development mode, plus your own via `Durbun.addAction`. |

**What a JS SDK cannot see:** React Native `<Image>` downloads and requests made by native modules (Firebase and
similar) never pass through the JS layer, so they are not captured. Requests that were opened (`open()` called)
before `Durbun.start()` are not captured either. The app's stdout and system logs still show up in Dürbün's
device logs without any SDK.

## Options

| Option | Default | Description |
|---|---|---|
| `host` | `'localhost'` | The machine running Dürbün. May be `'192.168.1.20'` or `'192.168.1.20:9750'`. |
| `port` / `path` / `url` | `9750` / `'/sdk'` / none | `url` is a full WebSocket URL (`ws://…/sdk`) and overrides the others. |
| `enabled` | `__DEV__` (RN), otherwise `NODE_ENV !== 'production'` | Set `true` to force it on in release builds. |
| `captureConsole` | `'auto'` | `true` always, `false` never. |
| `captureNetwork` / `captureErrors` / `captureMetrics` | `true` | |
| `maxBufferedMessages` | `5000` | Number of messages kept while disconnected. |
| `appId` / `appName` / `appVersion` | auto | Package id / display name. In React Native they are read from Metro's bundle URL and `AppRegistry`; in Expo, from `expo-application`. Mock rules are scoped by app id. |
| `device` | auto | For example `{ name: "Jane's iPhone" }`. |
| `ignoreUrls` | `[]` | URLs that are never captured or mocked (substring or RegExp). |
| `redactHeaders` | `[]` | Header names (case-insensitive) whose values show as `••••` in Dürbün, for example `['Authorization', 'Cookie']`. The request sent to the server is unchanged. |
| `WebSocket` | global | Implementation for runtimes without a global WebSocket. |
| `debug` | `false` | Print SDK diagnostics to the console. |

## Release safety

When `__DEV__` is `false`, `Durbun.start()` installs no patches and opens no connection; every other call is a
no-op. If you deliberately enable it in release builds (`enabled: true`), Android needs cleartext permission for
`ws://` and iOS needs the ATS `NSAllowsLocalNetworking` exception (already enabled in the RN debug templates).
[Dürbün in test builds](https://github.com/mykynk/durbun/blob/main/docs/guides/qa-builds.md) has the steps for
builds you hand to testers.

## Troubleshooting

More symptoms and fixes, for every platform:
[Troubleshooting](https://github.com/mykynk/durbun/blob/main/docs/guides/troubleshooting.md). Writing mock
rules: [Mock rules](https://github.com/mykynk/durbun/blob/main/docs/guides/mocks.md).

- **No connection**: read the note the SDK prints 10 seconds after start. Is Dürbün running (`http://localhost:9750`)? On Android, does `adb reverse --list` show
  `tcp:9750`? If not, check that Dürbün lists the phone (System check shows a missing `adb`); Dürbün adds the
  mapping itself, never add it by hand. `Durbun.start({ debug: true })` prints the addresses the SDK tries.
- **Metro: `Unable to resolve module react-native`**: the package was installed from a folder (symlink). Install
  the `.tgz` instead, or add `watchFolders: ['/path/to/durbun/sdks/js']` and
  `resolver.nodeModulesPaths: [path.resolve(__dirname, 'node_modules')]` to `metro.config.js`.
- **Jest**: the package also ships a CommonJS build, so no `transformIgnorePatterns` change is needed. In tests
  the SDK does nothing unless `Durbun.start()` is called.

## Development

```sh
npm run build -w @durbun/react-native     # ESM → dist/, CommonJS → dist/cjs/, .d.ts
npm run smoke -w @durbun/react-native     # plain-Node check of the built package
cd sdks/js && npx vitest run              # unit + integration tests (fake desktop, local HTTP server)
npx tsc -p sdks/js/tsconfig.json          # typecheck sources and tests
```
