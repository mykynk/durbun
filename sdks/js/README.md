# Dürbün: React Native / JavaScript SDK

[What you get](#what-you-get) · [Install](#install) · [Start](#start) · [Connect to the Mac](#connect-to-the-mac) ·
[What is captured](#what-is-captured) · [Mocks](#mocks) · [Tools](#tools) ·
[Release builds and safety](#release-builds-and-safety) · [Options](#options) ·
[Troubleshooting](#troubleshooting) · [Development](#development)

## What you get

`@durbun/react-native` streams **all logs** (console, your own logs, errors and crashes), **all network traffic**
(fetch, axios, XMLHttpRequest, WebSocket messages, server-sent events) and JS performance samples of your app to
the Dürbün Mac app, live. It also applies Dürbün's mock rules (fake responses, latency, failures) inside the app.

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

Upgrading: [Versions and upgrades](../../docs/guides/versions.md). To try changes that are not released yet, see
[Unreleased changes from a clone](#unreleased-changes-from-a-clone).

## Start

In `index.js`:

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

`Durbun.stop()` restores every patched API; `Durbun.isStarted` and `Durbun.isConnected` tell the state.

### Expo

With Expo Router, create `durbun.js` as above and import it on the first line of `app/_layout.tsx`
(`import '../durbun';`). Without Expo Router, import it at the top of the file your `main` entry points to.

- **Expo Go**: the app shows in the Mac app under your project's own bundle id (`ios.bundleIdentifier` /
  `android.package` from the app config), name and version, not as "Expo Go". If the app config cannot be read,
  the SDK prints one note in the Metro terminal; pass `Durbun.start({ appId: 'com.example.app' })` then, so mock
  rules scoped to your app match.
- **Dev client and bare Expo**: install `expo-application` (`npx expo install expo-application`) and the real
  native id is used; without it the id comes from the app config.
- `expo-device`, when installed, gives the device's name, which keeps several phones on Wi-Fi apart in the Mac
  app.

## Connect to the Mac

| Target | What to do |
|---|---|
| **Android device (USB)** | Nothing. For every connected device the Mac app points the phone's port 9750 (with `adb reverse`) at a separate device gateway on the Mac that serves only the SDK connection, so `localhost:9750` on the phone reaches the Mac app **automatically**. Do not create this mapping by hand: pointed at Dürbün's own port 9750, it would give every app on the phone Dürbün's full interface and API. To check it, `adb reverse --list` should show a `tcp:9750` line that points at a different port (the gateway's). |
| **Android emulator** | Nothing (the same automatic mapping; the emulator alias `10.0.2.2` is also tried). |
| **iOS simulator** | Nothing. The simulator shares the Mac's network, so `localhost` works. |
| **Android device over Wi-Fi (no USB)** | Like an iPhone: turn on **Settings → Connection → Allow local network (Wi-Fi) connections** in the Mac app and pass the Mac's LAN IP address: `Durbun.start({ host: '192.168.1.20' })`. |
| **iOS physical device** | The phone cannot reach the Mac through `localhost`. In the Mac app, turn on **Settings → Connection → Allow local network (Wi-Fi) connections** (from a source checkout: `node dist/durbun.mjs --lan`), keep the phone and the Mac on the same Wi-Fi network, and pass the **Mac's LAN IP address** (System Settings → Network): `Durbun.start({ host: '192.168.1.20' })`. Without `host`, the SDK also tries the Metro dev-server host (usually the same Mac). iOS asks for the Local Network permission on the first connection. |
| Browser / Node | `Durbun.start()` is enough. For Node < 22: `Durbun.start({ WebSocket: require('ws') })`. |

This SDK connects to the Mac app's HTTP port (9750), not to the SDK port the other SDKs use. That port takes
the Wi-Fi setting only when the Mac app starts: after you turn on **Allow local network (Wi-Fi) connections**,
quit and reopen the Mac app before a phone connects over Wi-Fi.

While disconnected, the SDK keeps the last 5 000 messages (about 8 MB at most), reconnects with backoff
(0.5 s → 3 s) and sends them all in order once connected. So that an app that keeps `Durbun.start()` costs
almost nothing while the Mac app is closed:

- Bodies are read while the Mac app is connected, during the first 30 seconds after start (while it may still
  be connecting) and for 30 seconds after it went away. Requests made outside these windows arrive with their
  method, URL, headers, status and timings, and only the body's size.
- Past about 8 MB, the oldest waiting bodies are dropped first (the request stays, its body shows as
  truncated); only then the oldest messages. If any message had to be dropped, a warning line says how many.

If the app does not show up, see [Not connecting?](#not-connecting).

### Giving the app the Mac's address

Pass it as `host` (`'192.168.1.20'` or `'192.168.1.20:9750'`), or a full `url`
(`Durbun.start({ host: '192.168.1.20' })`). Without `host`, the SDK tries `localhost` and the Metro dev-server
host (all at once; the first to answer wins).

## What is captured

### Network

Everything that goes through `XMLHttpRequest`: React Native `fetch`, axios and others. Method, URL, headers,
request and response bodies (text/JSON as text, binary as base64, FormData field summary, Blobs), status code,
timings (wait / receive), errors, timeouts and cancellations. In browsers and Node, native `fetch` is captured
too; each request is reported **once**. Body limits come from the Mac app's settings (default 1 MB). Responses
that stay open (NDJSON, media streams) are shown as soon as their headers arrive, with the size only; server-sent
events are shown event by event (see below). In React Native, text responses that arrive as a `Blob` (what
`fetch` uses) are decoded by the platform (`FileReader.readAsText`), not on the JS thread. Metro's and Dürbün's
own traffic is ignored.

`redactHeaders` masks header values as `••••`; `ignoreUrls` leaves URLs out.

**What a JS SDK cannot see:** React Native `<Image>` downloads and requests made by native modules (Firebase and
similar) never pass through the JS layer, so they are not captured (report your own clients with
`Durbun.network.begin`, see below). Requests that were opened (`open()` called)
before `Durbun.start()` are not captured either. The app's stdout and system logs still show up in device logs
without the SDK.

#### WebSocket messages and server-sent events

Each WebSocket connection and each server-sent events (SSE) response is one entry: its handshake (`101` for a
WebSocket, the response headers for SSE), then every message or event in the order the app saw it, with its size
and payload (text as text, binary as base64, cut at the Mac app's limit; sizes only when body capture is off). A
connection that fails before it opens is a failed request; one that breaks later shows as failed, one the app
closes as closed. They are sent only while the Mac app asks for them: an older Mac app gets none, and turning
the setting on or off takes effect at once (a socket that was already open shows up from then on).

| Runtime | WebSocket | Server-sent events |
|---|---|---|
| React Native (iOS, Android; Hermes or JSC) | The global `WebSocket`: messages both ways (text, `ArrayBuffer`, `Blob`), close frames with code and reason, the protocols and `headers` you pass | Libraries built on `XMLHttpRequest` (`react-native-sse` and others): each event (`event`, `id`, `retry`, data), the end, a close by the app |
| Browsers | The global `WebSocket`, as above | `fetch` responses and the browser's own `EventSource` |
| Node 18+ | The global `WebSocket` (Node 22+) | `fetch` responses (libraries on the global `fetch` included) |

Messages and events are read as they pass, never consumed: the app receives exactly what it did before. An SSE
`fetch` response is handed to the app as a `Response` over the same body (`body`, `text()`, `clone()` and
cancelling work as usual).

**Not shown:** ping / pong frames the runtime handles without telling JavaScript (all of them in browsers; in
React Native only the app's own `ws.ping()` shows); sockets from a WebSocket class imported from a package
instead of the global one (Node's `ws`, for example); with the browser's own `EventSource`, `retry:` fields and
named events the app does not listen to (the browser never hands them to JavaScript), and a reconnect starts
when the previous connection dropped. Mock rules do not apply to WebSocket connections. The SDK's own connection
to the Mac app, Metro's and React DevTools' are never captured.

#### Reporting other clients yourself

`react-native-blob-util`, Expo FileSystem downloads, gRPC-web and native modules do not go through `fetch` or
`XMLHttpRequest`. Report them yourself; while the SDK is off these calls do nothing:

```js
const call = Durbun.network.begin({ method: 'GET', url, headers, source: 'blob-util' });
try {
  const res = await ReactNativeBlobUtil.config({ fileCache: true }).fetch('GET', url, headers);
  const info = res.info();
  call.response({ status: info.status, headers: info.headers, bodySize: Number(info.headers['Content-Length']) || undefined });
} catch (e) {
  call.error(e);
}
```

`body` may be a string, bytes, a Blob or a plain object (shown as JSON); for a download written to a file,
pass `bodySize` instead. To apply Dürbün's mock rules in your own client, `Durbun.network.findMock(method, url)`
returns the matching rule; answer with `rule.action` and report it with `call.response({ …, mockRuleId: rule.id })`.
Pass the request body for rules limited to a GraphQL operation:
`findMock('POST', url, { body: jsonText, contentType: 'application/json' })`; without a body such rules do not match.

### Logs and events

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

// Screen changes as "navigation" events, so rows show which screen they came from (route params are not sent).
// React Navigation: the ref passed to <NavigationContainer ref={…}>; Expo Router: useNavigationContainerRef().
Durbun.trackNavigation(navigationRef);

Durbun.stop();             // restores every patched API
Durbun.isStarted; Durbun.isConnected;
```

- `data` may be any value: cycles, BigInt, Date, Map/Set and Error are snapshotted safely and shown in the Mac
  app as a collapsible JSON tree.
- A leading `[Tag]` in a console message, as in `console.log('[Auth] token refreshed')`, becomes the row's tag
  chip (`Auth`). Objects appear as single-line JSON in the message and as a tree in the details.
- **console.\***: `log/info/debug/warn/error/trace/assert/dir/table`; `%s %d %o %c` formatting, objects → JSON
  data, Errors → stack traces. `captureConsole: 'auto'` (default): when the Mac app already reads device logs
  (Android logcat, iOS simulator), console lines are **not sent again**, so rows are not duplicated.
- **SDK logs**: `Durbun.log/debug/info/warn/error`, `Durbun.event`.

### Crashes

Uncaught errors via `ErrorUtils` (the previous handler chain is kept): fatal ones appear as **crash** rows. A
fatal error that ends the app before it reaches the Mac app is sent on the next launch as "Previous launch
crashed — …" (see [Crashes on the next launch](#crashes-on-the-next-launch)). In React Native, unhandled promise
rejections in dev builds, read from React Native's own rejection tracker (LogBox in 0.71–0.81, the "Uncaught
(in promise)" error in 0.82 and later, the console warning before 0.71); LogBox still shows them. React Native
does not track rejections in release builds, so none are reported there. On the web, `error` and
`unhandledrejection`; in Node, `uncaughtExceptionMonitor`.

Native crashes (Java / Kotlin / Objective-C / Swift) are not JS errors: the Mac app shows them from the device's
own crash records while the phone is connected to the Mac.

#### Crashes on the next launch

In a release build (`enabled: true`), a fatal JS error ends the app right after the error handlers run, often
before the report has left the device. The SDK therefore writes the last three fatal errors to a small store and
sends them on the next launch, marked `previousLaunch`; once the Mac app has them they are removed. Dev builds
keep running behind the red box, so there a crash that already reached the Mac app is not stored.

On iOS the SDK uses React Native's `Settings` (the app's user defaults) when no store is given. React Native has no
built-in store on Android, so pass one there. A synchronous store (MMKV) is the most reliable, because the write
must finish before the app ends; an asynchronous one (AsyncStorage) usually does too:

```js
import { MMKV } from 'react-native-mmkv';
const storage = new MMKV({ id: 'durbun' });

Durbun.start({
  crashStorage: { getItem: (k) => storage.getString(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
});
// or: crashStorage: AsyncStorage (from @react-native-async-storage/async-storage)
```

### Performance

JS heap (Hermes), JS-thread FPS and janky frame count (the "JS FPS" of the RN perf monitor). FPS measurement
stops while the app is in the background. `captureMetrics: false` turns them off.

## Mocks

Rules from the Mac app's Mocks tab ([writing mock rules](../../docs/guides/mocks.md)):

| Action | What the app sees |
|---|---|
| `respond` | A fake response; the network is never hit |
| `delay` | The real request, after waiting the given time; the app's own timeout still applies |
| `fail` | The platform's natural error, `Network request failed` in React Native |

- In React Native, a binary (base64) mock body cannot be delivered intact to a `blob` response (what `fetch`
  uses) unless it is valid UTF-8, because React Native's `Blob` only holds text: such a request goes to the
  network instead and the Mac app shows a warning line saying why. Text, JSON and `arraybuffer` responses are
  mocked as usual.
- Requests to URLs in `ignoreUrls` are never mocked.
- Rules limited to a GraphQL operation read the operation from a request body that is already text (a string,
  or bytes up to 192 KB): JSON `operationName`, else the first named operation in `query`; a batch matches when
  any of its operations does. A `Request` object's body, a `Blob`, `FormData` or a stream is never read for this:
  such a request goes to the network.
- Launch requests (remote config, login) can wait for the rules with `waitForDesktop` (see [Options](#options)).

## Tools

In development mode, where the app's React Native version has them: "Reload JS", "Open dev menu", "Toggle element
inspector", "Open debugger" (React Native DevTools, 0.76 and later) and Appearance (system / light / dark). They
appear under App tools in the Mac app's Device tab. Add your own with `Durbun.addAction`:

```js
// A button / toggle for this app in Dürbün's Device tab
Durbun.addAction({ id: 'app.clearCache', label: 'Clear cache' }, async () => {
  await cache.clear();
  return { ok: true };
});
Durbun.addAction({ id: 'app.mockLocation', label: 'Mock location', kind: 'toggle', value: false }, ({ value }) => setMockLocation(!!value));
```

An AsyncStorage (or MMKV) dump as a tool; the returned value shows as JSON in the Mac app:

```js
import AsyncStorage from '@react-native-async-storage/async-storage';

Durbun.addAction({ id: 'app.dumpStorage', label: 'Dump AsyncStorage', group: 'storage' }, async () => {
  const keys = await AsyncStorage.getAllKeys();
  return Object.fromEntries(await AsyncStorage.multiGet(keys));
});
```

<a id="release-safety"></a>

## Release builds and safety

### Which builds run Dürbün

When `__DEV__` is `false`, `Durbun.start()` installs no patches and opens no connection; every other call is a
no-op. `enabled: true` turns it on in release builds too.

### Test builds

If you deliberately enable it in release builds (`enabled: true`), Android needs cleartext permission for
`ws://` and iOS needs the ATS `NSAllowsLocalNetworking` exception (already enabled in the RN debug templates).
[Dürbün in test builds](../../docs/guides/qa-builds.md) has the steps for builds you hand to testers.

### Size with Dürbün off

The SDK's code is still in the release bundle (about 240 KB before minification) when it is imported
statically. To leave it out, import it through one file and pick the no-op entry when `__DEV__` is false;
Metro folds the condition in release builds, so only the branch that is used ends up in the bundle:

```js
// durbun.js: import { Durbun } from './durbun' everywhere else
export const Durbun = __DEV__ ? require('@durbun/react-native').Durbun : require('@durbun/react-native/noop').Durbun;
Durbun.start();
```

`@durbun/react-native/noop` has the same API with empty bodies (`Durbun.network.begin` returns a call that does
nothing). Builds you hand to testers with `enabled: true` need the first branch instead.

### Safety and security

- The SDK never changes app behavior: the original `console` methods are called, request and response bodies
  are never consumed, the React Native red box and LogBox keep working, and SDK failures never reach the app.
- When the connection drops, the mock rules are dropped too; requests made while disconnected go to the real
  server ([what happens inside the app](../../docs/guides/mocks.md#what-happens-inside-the-app)).
- The connection has no pairing yet; see [Security](../../README.md#security) before deciding which builds run
  Dürbün.

## Options

`Durbun.start({ … })`:

| Option | Default | Description |
|---|---|---|
| `host` | `'localhost'` | The machine running the Mac app. May be `'192.168.1.20'` or `'192.168.1.20:9750'`. |
| `port` / `path` / `url` | `9750` / `'/sdk'` / none | `url` is a full WebSocket URL (`ws://…/sdk`) and overrides the others. |
| `enabled` | `__DEV__` (RN), otherwise `NODE_ENV !== 'production'` | Set `true` to force it on in release builds. |
| `captureConsole` | `'auto'` | `true` always, `false` never. |
| `captureNetwork` / `captureErrors` / `captureMetrics` | `true` | |
| `waitForDesktop` | `0` | Milliseconds (at most 10 000). Requests made this soon after `start()` wait for the Mac app's mock rules, so mocks apply to launch requests (remote config, login). They stop waiting as soon as the rules arrive or no Mac app answers. Even at `0`, a request made while the Mac app is answering waits for it (up to 0.8 s). |
| `maxBufferedMessages` | `5000` | Number of messages kept while disconnected. |
| `crashStorage` | iOS: React Native `Settings`; elsewhere none | Where a fatal JS error is kept until the Mac app has it, so a crash that ends the app first shows on the next launch. Any store with `getItem` / `setItem` (and optionally `removeItem`), sync or async. `false` turns it off. See [Crashes on the next launch](#crashes-on-the-next-launch). |
| `appId` / `appName` / `appVersion` | auto | Package id / display name. In React Native they are read from Metro's bundle URL and `AppRegistry`; in Expo, from `expo-application` or the app config (see [Expo](#expo)). Mock rules are scoped by app id. |
| `device` | auto | For example `{ name: "Jane's iPhone" }`. |
| `ignoreUrls` | `[]` | URLs that are never captured or mocked (substring or RegExp). |
| `redactHeaders` | `[]` | Header names (case-insensitive) whose values are masked as `••••` in the Mac app, for example `['Authorization', 'Cookie']`. The request sent to the server is unchanged. |
| `WebSocket` | global | Implementation for runtimes without a global WebSocket. |
| `debug` | `false` | Print SDK diagnostics to the console. |

### Same option, other names

The SDKs share their options; where a name differs, this table maps it:

| What | Flutter | Android | iOS | React Native / JS |
|---|---|---|---|---|
| Run in release builds | `--dart-define=DURBUN=true` or `enabled: true` | `forceInRelease` | `allowInReleaseBuilds` (or the `DurbunEnabled` Info.plist key) | `enabled: true` |
| Performance metrics | `metrics` | `captureMetrics` | `collectMetrics` | `captureMetrics` |
| Crashes | `captureErrors` | `captureCrashes` | `captureCrashes` | `captureErrors` |
| `print` / stdout / console | `capturePrint` | none | `captureStdout` | `captureConsole` |
| The app's own logcat / `os_log` lines when the Mac app cannot read device logs | `capturePrint` (`never` turns them off) | `captureLogcat` | `captureOSLog` | none |
| Hosts never captured | none | `ignoredHosts` | `ignoredHosts` | `ignoreUrls` |
| Is the SDK running? | `Durbun.isEnabled` | `Durbun.isStarted` | `Durbun.isRunning` | `Durbun.isStarted` |
| Add your own tool | `Durbun.addAction(...)` | `Durbun.addAction(...)` | `Durbun.registerAction(...)` | `Durbun.addAction(...)` |
| Set the Mac's address without a rebuild | In-app panel: Tools → Mac connection | `Durbun.setDesktopHost(context, ...)` | `Durbun.setDesktopHost(...)` | none |
| Wait for mock rules at launch | `waitForDesktop` (a `Duration`) | none | none | `waitForDesktop` (milliseconds) |

## Troubleshooting

### Not connecting?

If no Mac app has accepted the app 10 seconds after `Durbun.start()`, the SDK prints one `console.info` note
(in the Metro terminal): the addresses it tried and what to do for this device. It keeps retrying, and prints
one more line when the connection works.

- **No connection**: read the note the SDK prints 10 seconds after start. Is the Mac app running
  (`http://localhost:9750`)? On Android, does `adb reverse --list` show `tcp:9750`? If not, check that the Mac
  app lists the phone (System check shows a missing `adb`); the Mac app adds the mapping itself, never add it by
  hand. `Durbun.start({ debug: true })` prints the addresses the SDK tries.
- **Wi-Fi only**: after turning on **Allow local network (Wi-Fi) connections**, quit and reopen the Mac app
  (see [Connect to the Mac](#connect-to-the-mac)).

### More help

- **Metro: `Unable to resolve module react-native`**: the package was installed from a folder (symlink). Install
  the `.tgz` instead, or add `watchFolders: ['/path/to/durbun/sdks/js']` and
  `resolver.nodeModulesPaths: [path.resolve(__dirname, 'node_modules')]` to `metro.config.js`.
- **Jest**: the package also ships a CommonJS build, so no `transformIgnorePatterns` change is needed. In tests
  the SDK does nothing unless `Durbun.start()` is called.

More symptoms and fixes, for every platform: [Troubleshooting](../../docs/guides/troubleshooting.md). Writing mock
rules: [Mock rules](../../docs/guides/mocks.md).

## Development

```sh
npm run build -w @durbun/react-native     # ESM → dist/, CommonJS → dist/cjs/, .d.ts
npm run smoke -w @durbun/react-native     # plain-Node check of the built package
cd sdks/js && npx vitest run              # unit + integration tests (fake desktop, local HTTP server)
npx tsc -p sdks/js/tsconfig.json          # typecheck sources and tests
```

### Unreleased changes from a clone

To try changes that are not released yet, install from a clone of the Dürbün repository using the **packed `.tgz`,
not the folder** (Metro cannot resolve `react-native` through a symlinked folder outside the app):

```sh
# 1) In your clone of the Dürbün repository: build the package (prepack builds it automatically)
cd /path/to/durbun/sdks/js
npm pack                      # → durbun-react-native-0.3.1.tgz

# 2) In your app
npm install /path/to/durbun/sdks/js/durbun-react-native-0.3.1.tgz
# or: yarn add file:/path/to/durbun/sdks/js/durbun-react-native-0.3.1.tgz
```
