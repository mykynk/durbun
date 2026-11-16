# Dürbün Android SDK

> **Flutter app?** Do not add this SDK separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this Android core and starts it from Dart
> (there is no `Durbun.start` call; in a Flutter app it does nothing). If your native code uses OkHttp, one line
> is enough: `.addInterceptor(DurbunInterceptor())`. This page is for native-only Android apps.

[What you get](#what-you-get) · [Install](#install) · [Start](#start) · [Connect to the Mac](#connect-to-the-mac) ·
[What is captured](#what-is-captured) · [Mocks](#mocks) · [Tools](#tools) ·
[Release builds and safety](#release-builds-and-safety) · [Options](#options) ·
[Troubleshooting](#troubleshooting) · [Development](#development)

## What you get

The Dürbün Android SDK streams your app's **logs, OkHttp traffic (headers, bodies, timings), crashes, custom
events and performance metrics** (CPU, memory, FPS, janky frames, launch time) to the Dürbün Mac app, live. From the Mac app
you can define mock rules (fake responses, latency, timeouts, DNS / TLS / connection failures) and use tools that
run code inside the app.

**No log is left behind:**

| Source | How it arrives |
|---|---|
| Device logs (logcat, all processes) | Read by the Mac app over USB or wireless adb; no SDK needed |
| `Durbun.log(...)`, Timber | Sent by the SDK as structured entries: tag, level, JSON data and full stack trace |
| The app's own logcat over Wi-Fi (no adb) | Read and forwarded by the SDK (multi-line messages are merged back) |
| Network (OkHttp) | `DurbunInterceptor`; DNS / connect / TLS times with `DurbunEventListenerFactory`; WebSocket messages with `DurbunWebSocketFactory` |
| Web views | `DurbunWebView.attach(webView)`: the page's `fetch` / `XMLHttpRequest` calls and `console` lines (see [Web views](#web-views)) |
| Crashes | Uncaught exceptions; a crash that cannot reach the Mac app is sent on the next launch |
| How earlier launches ended | ANRs, native crashes and kills by the system, on the next launch (Android 11+, see [Earlier launches](#earlier-launches-anrs-native-crashes-system-kills)) |

The Mac app renders every line legibly: level colors, tag colors, collapsible stack traces, a JSON tree, and
`→ GET /api/users 200 · 123 ms` lines inside the log stream.

## Install

The SDK is on Maven Central as `io.github.mykynk:durbun` (the real SDK) and `io.github.mykynk:durbun-noop` (the
same API with empty bodies, for release builds). `mavenCentral()` is declared by default in Android projects.

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation("io.github.mykynk:durbun:0.2.0")        // the real SDK, debug builds only
    releaseImplementation("io.github.mykynk:durbun-noop:0.2.0") // same API with empty bodies in release
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"("io.github.mykynk:durbun-noop:0.2.0")
}
```

The published AARs are compiled with Kotlin 1.9 API and metadata and depend on `kotlin-stdlib` 1.9.24, so they
work in apps on Kotlin 1.9 and newer. Upgrading: raise `durbun` and `durbun-noop` together and keep both on the
same version ([Versions and upgrades](../../docs/guides/versions.md)).

To try changes that are not released yet, see [Unreleased changes from a clone](#unreleased-changes-from-a-clone).

### Requirements

- minSdk 21 or higher.
- OkHttp is optional and your own version is used (tested with 4.x, binary compatibility with 3.14 checked; 5.x
  keeps the same API).
- No other dependencies, not even AndroidX.

## Start

Adding the dependency is the whole setup: in a debuggable build, Dürbün starts by itself right after
`Application.onCreate`, with the default options (USB and emulators need nothing else). Builds that are not
debuggable stay off.

`start()` never blocks the main thread; all networking and disk work happens on Dürbün's low-priority
background threads. The SDK never crashes your app: internal errors are swallowed and every queue is bounded.

### Starting from code

Call `Durbun.start` in your `Application` to pass options (a Wi-Fi address, redacted headers, a release build with
`forceInRelease`):

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Durbun.start(this, DurbunOptions(host = "192.168.1.20"))
    }
}
```

- A `Durbun.start(...)` or `Durbun.stop()` in `Application.onCreate` always decides: the automatic start then does
  nothing (never a second session). A later `Durbun.start` with options (for example from the first `Activity`)
  restarts the session with them; one without options keeps it.
- Without options, Wi-Fi addresses come from the
  [`dev.durbun.host` manifest entry](#giving-the-app-the-macs-address) or `Durbun.setDesktopHost`.

### Turning the automatic start off

One line inside `<application>` in the app's `AndroidManifest.xml`:

```xml
<meta-data android:name="dev.durbun.autoStart" android:value="false" />
```

- With `"false"`, Dürbün starts only when the app calls `Durbun.start`. With `"true"` (or without the entry) it
  starts by itself; a build that is not debuggable still needs `Durbun.start` with `forceInRelease = true`.
- The entry is read on Dürbün's own thread, like `dev.durbun.host`. The automatic start is part of `durbun` only:
  with `durbun-noop`, nothing starts. It runs in the app's main process; other processes
  (`android:process=":sync"`) start Dürbün only with `Durbun.start`.
- Until 0.2, nothing started without `Durbun.start` or `android:value="true"`.

## Connect to the Mac

- **USB (cable or wireless adb):** when a device appears, the Mac app runs `adb reverse tcp:9751 …`
  automatically, and the SDK connects to `127.0.0.1:9751` on the device. There is nothing to configure. To
  check, run `adb reverse --list`.
- **Emulator:** the same, plus `10.0.2.2:9751` (the Mac itself) is tried as a fallback.
- **Wi-Fi only (no adb):** in the Mac app, turn on Settings → Connection → "Allow local network (Wi-Fi)
  connections" (when you run the server from the repository instead, start it with `node dist/durbun.mjs --lan`),
  and give the app the Mac's IP address (Dürbün → Settings lists it) in one of the
  [ways below](#giving-the-app-the-macs-address). In this mode the Mac app cannot read device logs, so the SDK
  forwards the app's **own logcat**.
- If the connection drops, the SDK reconnects indefinitely with a 0.5 s → 3 s backoff. Meanwhile the last 5 000
  messages are kept in memory and sent on reconnect (a warning line reports how many were dropped, if any).

If the app does not show up, see [Not connecting?](#not-connecting).

### Giving the app the Mac's address

The Mac's address changes with the network, so it does not have to be built into the app. From the first that
is set to the last:

| Way | Who uses it | Rebuild? |
|---|---|---|
| `Durbun.setDesktopHost(context, "192.168.1.20")` | The app's own debug menu, or a link the app opens | No |
| Launch extra `durbun.host` (debuggable builds only) | `adb shell am start -n <app id>/<activity> --es durbun.host 192.168.1.20`, Android Studio's run configuration (Launch Flags), test runners that pass launch arguments | No |
| `DurbunOptions(host = "192.168.1.20")` | Code, for example `BuildConfig.DURBUN_HOST` | Yes |
| `<meta-data android:name="dev.durbun.host" android:value="${durbunHost}"/>` in the app's manifest | CI or a Gradle property through `manifestPlaceholders` | Yes |

- For the manifest entry, fill the placeholder in `app/build.gradle.kts`, for example
  `defaultConfig { manifestPlaceholders["durbunHost"] = providers.gradleProperty("durbunHost").getOrElse("") }`
  and build with `-PdurbunHost=192.168.1.20`; an empty value is ignored.
- The first two are **kept for the next launches** (in the app's no-backup files), so a tester sets the address
  once and then opens the app from the launcher as usual. `Durbun.setDesktopHost(context, null)` (or an empty
  `durbun.host` extra) goes back to the address built into the app.
- A new address is tried at once; a connection through the old Wi-Fi address is closed, a USB connection stays.
- `host:port` is accepted (`192.168.1.20:9751`); `setDesktopHost` returns `false` for anything that is not a host
  name or IP address. The launch extra is ignored when the activity was opened from a browser or a deep link.
- The launch extra is read in debuggable builds only, because another app on the phone can start the activity
  with extras. Tester builds without the debuggable flag (for example a `staging` build with `forceInRelease`)
  take the address from `Durbun.setDesktopHost` (a debug menu) or the manifest entry; there, the SDK logs one
  line when it ignores the extra.
- In the app's debug menu, a text field and two lines are enough:

  ```kotlin
  saveButton.setOnClickListener {
      if (!Durbun.setDesktopHost(context, addressField.text.toString())) addressField.error = "Not an IP address"
  }
  statusText.text = Durbun.connectionStatus.toString()
  ```

  An app that already handles links can pass a value on, for example
  `Durbun.setDesktopHost(context, uri.getQueryParameter("durbunHost"))` for `myapp://debug?durbunHost=192.168.1.20`.

## What is captured

### Network

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())                    // hand the same client to Retrofit
    .eventListenerFactory(DurbunEventListenerFactory())     // optional: DNS, connect, TLS, send and wait times
    .build()
```

- Without the listener factory, a call shows `connect` (everything before the request was sent), `wait` and
  `receive`. With it, the same phases as on iOS: `dns`, `connect`, `tls`, `send`, `wait`, `receive` of the last
  attempt (after a redirect or retry, its own phases; a reused connection has no DNS, connect or TLS time).
- OkHttp takes one listener factory per client. If the app has its own, pass it in:
  `DurbunEventListenerFactory(myFactory)` (or `DurbunEventListenerFactory(myListener)` for `eventListener(...)`).
  Your listener still gets every callback first, in the same order, on the same threads. Callbacks newer than
  OkHttp 4.12 are not passed on to it. In `durbun-noop` the factory returns your own listener untouched.
- Add it as the **last** application interceptor to see headers your own interceptors add (for example
  `Authorization`).
- Use `addNetworkInterceptor(DurbunInterceptor())` to see every redirect and retry separately (gzip and deflate
  bodies are decoded automatically, and the remote IP address is shown). OkHttp does not let network
  interceptors short-circuit a request, so `respond` mocks are skipped there (delay and failure mocks still
  work); the Mac app gets one warning line per skipped rule, with the call's id.
- Bodies are captured without touching the app's streams. A request body is copied while OkHttp writes it to
  the server (no body is ever written twice, so `InputStream` and file streams, progress-reporting bodies and
  one-shot bodies are safe). A response body is copied as the app reads it: Dürbün never reads ahead, and
  `execute()` returns as soon as the headers arrive.
- Reporting order: the request is reported first with its size, then again (same id) with its body once
  written. The response is reported at the end of the body, when the capture limit is reached, or when the app
  closes the body. A body closed unread shows its size only; a response that is never closed (leaked) stays
  pending in the Mac app. NDJSON, gRPC and audio/video streams are reported with their size only; for SSE and
  WebSockets see [WebSockets and Server-Sent Events](#websockets-and-server-sent-events).
- To observe bodies, the interceptor hands request bodies (except `FormBody`) and captured response bodies
  down the chain in a thin wrapper (content type, length, and one-shot / duplex flags are forwarded). If your
  own interceptors check body classes (for example `body is MultipartBody`), add `DurbunInterceptor` after
  them.
- Mask secrets for every client at once with `DurbunOptions(redactHeaders = setOf("Authorization", "Cookie"))`,
  or per client with `DurbunInterceptor(redactHeaders = setOf(...))`; values show as `••••` and the real request
  is unchanged. `DurbunOptions(ignoredHosts = listOf("analytics.example.com"))` leaves hosts (and their
  subdomains) out: their calls pass the interceptor untouched and mock rules do not apply to them.

**Not captured:** only `OkHttpClient`s that have `DurbunInterceptor` are seen, and every client needs it.
Add it to the clients that Retrofit, Coil, Glide's OkHttp integration (`okhttp3-integration`) and Ktor's
OkHttp engine build for themselves. Traffic over `HttpURLConnection` is not seen: Volley (`HurlStack`),
ExoPlayer / Media3 `DefaultHttpDataSource`, Glide's default loader, Ktor's CIO and Android engines, Cronet,
and native (C/C++) code. A `WebView` is not seen either, unless the page's calls are reported with
[`DurbunWebView`](#web-views). When OkHttp is in the app but no `DurbunInterceptor` was created 30 seconds
after start, the Mac app shows one line saying so, so an empty network list has a reason.

#### WebSockets and Server-Sent Events

A long-lived connection is one entry in the network list, with its messages in the order the app saw them.

- **Server-Sent Events** need nothing more than `DurbunInterceptor`: okhttp-sse `EventSources`, Retrofit
  `@Streaming` calls and plain calls that read a `text/event-stream` response. The entry is reported as soon as
  the headers arrive, then each event (`event`, `id`, `retry` and the data), and the end of the stream. Events
  are read from a copy of what the app reads: nothing is read ahead or held back. Closing the response early
  shows as cancelled; a stream that breaks shows the error.
- **WebSockets:** OkHttp gives the messages to no interceptor, so open the socket through
  `DurbunWebSocketFactory` instead of `client.newWebSocket(...)`:

  ```kotlin
  val webSockets = DurbunWebSocketFactory(client)
  val socket = webSockets.newWebSocket(request, listener)   // was: client.newWebSocket(request, listener)
  ```

  Text, binary and close frames in both directions are shown (OkHttp does not expose pings). Your listener
  gets every callback as before, with the socket the factory returned. It is a `WebSocket.Factory`, so it also
  goes where a library takes one, for example Ktor's OkHttp engine:
  `engine { webSocketFactory = DurbunWebSocketFactory(client) }`. With `DurbunInterceptor` on the client its
  entry is the handshake (mocks apply to it); without it, the factory reports the handshake itself.
- A socket opened with `client.newWebSocket(...)` on a client with `DurbunInterceptor` shows only its handshake,
  and the Mac app gets one line saying how to see its messages.
- Messages are sent while the Mac app asks for them (Settings → "Capture WebSocket and SSE messages", on by
  default); an older Mac app, or the setting off, gets the plain request entries as before. Payloads follow
  body capture and are cut at the Mac app's per-message limit (64 KB by default); sizes are always shown. A
  busy socket never pushes out logs or requests: when the SDK's buffer is full, the oldest stream messages are
  dropped first.
- `durbun-noop` has the same factory: it opens the socket exactly as `client.newWebSocket(...)` would.

#### Web views

A `WebView` loads pages with its own network stack, so `DurbunInterceptor` never sees them. `DurbunWebView`
adds a small script to the page instead: its `fetch` and `XMLHttpRequest` calls (method, URL, status, headers,
bodies, timings) appear in the network list as client `webview:fetch` / `webview:xhr`, and its `console.*`
lines and uncaught errors in the log stream with the tag `webview`.

```kotlin
webView.settings.javaScriptEnabled = true
DurbunWebView.attach(webView)                 // before the first loadUrl
webView.webViewClient = object : WebViewClient() {
    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        DurbunWebView.onPageStarted(view)     // needed when the app does not have androidx.webkit
    }
}
```

- When the app has androidx.webkit (most apps do, through AppCompat or Compose) and the device's WebView
  supports document-start scripts, the script runs in every frame before the page's own scripts. Otherwise
  `onPageStarted` adds it to the main frame when a page starts loading, and requests made before that are
  missed. Dürbün does not add androidx.webkit to your app.
- The page sees no difference: the originals run with the same arguments and return the same results, bodies
  are read from copies, and the script's own errors are swallowed. Bodies are cut at 64 KB in the page and
  then follow the SDK's capture settings; `ignoredHosts` and `redactHeaders` apply.
- The script reports through one JavaScript interface with a single method, which the page can call as well:
  an entry from a web view is whatever the page claims. Messages are limited in size and rate; when a page
  sends too many, the Mac app shows one line saying how many were dropped.
- Not captured: the page's WebSocket and EventSource connections, `navigator.sendBeacon`, and what the page
  loads itself (documents, images, scripts, styles).
- Nothing happens while Dürbün is not running: `attach` returns false and the web view is not touched.
  `durbun-noop` has the same object, doing nothing.

### Logs and events

```kotlin
Durbun.i("auth", "User logged in", data = mapOf("userId" to 42, "plan" to "premium"))
Durbun.w("sync", "Sync is slow", data = mapOf("ms" to 2300))
Durbun.e("payment", "Payment failed", throwable = e)
Durbun.log(Level.DEBUG, "cache", "Cache cleared")
Durbun.event("purchase", mapOf("amount" to 49.9, "currency" to "USD"))
```

`data` can be a Map, List, number, enum, `JSONObject`, or a Gson / kotlinx.serialization JSON object; the
Mac app shows it as a collapsible JSON tree.

Over USB the Mac app reads device logs (logcat) itself. Over Wi-Fi it cannot, so the SDK forwards the app's own
logcat (`captureLogcat`).

#### Timber

```kotlin
class DurbunTree : Timber.Tree() {
    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        Durbun.log(Level.fromPriority(priority), tag ?: "app", message, throwable = t)
    }
}

// In Application.onCreate
Timber.plant(Timber.DebugTree(), DurbunTree())
```

Timber appends the stack trace to the message as well; the SDK removes that copy so the Mac app shows the
message once and the (folded) stack trace once. `DebugTree` also writes the same line to logcat: over Wi-Fi
the SDK removes that duplicate, and over USB the Mac app de-duplicates identical lines.

### Crashes

Uncaught exceptions are reported by the SDK's crash handler (the previous handler always runs). A crash that
cannot reach the Mac app is sent on the next launch. `captureCrashes = false` turns this off.

#### Earlier launches: ANRs, native crashes, system kills

Some endings leave the app no chance to report: an ANR, a crash in native (C/C++) code, or Android ending the
process to free memory. On Android 11 (API 30) and newer, the SDK reads how earlier launches ended
(`ApplicationExitInfo`) on its own background thread at start and sends them once the Mac app is connected:

| Ending | Line in the Mac app |
|---|---|
| ANR | Crash row "Previous launch ended: App Not Responding (ANR)" with the main thread's stack and the threads holding the locks it waited for |
| Native crash | Crash row with the signal (`SIGSEGV`, `SIGABRT` …) |
| Low memory kill | Info line (a warning when the app was in the foreground) with its memory use |
| Too many resources, killed by a signal, start-up failure, a revoked permission | One line each |

- Exits the app or the person caused (the app called `exit`, swiped away, force stop, an update) are not
  reported; uncaught Java/Kotlin exceptions come from the crash handler as before.
- Each exit is reported once. On the first launch with Dürbün, only the last 24 hours are read. When the Mac app
  does not connect during a launch, the next launch tries again.
- Over USB the Mac app already reads ANRs and native crashes from the device, so the SDK leaves those two out and
  sends only the others.
- `captureCrashes = false` turns this off too. Out of reach: anything before Android 11, an ANR that the person
  waited out (the app kept running), and the native backtrace itself (it stays in the device's tombstone, which
  the Mac app reads over USB).

### Performance

CPU, PSS memory, Java heap, thread count, frames and the launch time. `captureMetrics = false` turns them off.
Samples are taken while the Mac app is connected; frames only while the app is in the foreground.

| Number | What it means |
|---|---|
| `cpu` | Process CPU time over wall time since the previous sample, in percent of one core (can pass 100 on several cores) |
| `memoryMB` | PSS (`Debug.getPss`); read less often on devices where it is slow |
| `heapMB` / `threads` | Java heap in use / threads of the process |
| `fps` | Android 7+: frames the app's activities actually drew per second. No value while nothing is drawn (an idle screen is not a drop) |
| `jankyFrames` | Frames that missed their deadline (Android 12+ reports it per frame); before Android 12, frames longer than two refresh intervals. The first frame of a screen is not counted |
| `frameBuildMs` / `frameRasterMs` | Average time per frame on the UI thread (input, animation, measure/layout, draw) / on the RenderThread (sync, GPU commands, buffer swap) |
| Event `durbun.launch` | Cold start, once per process: `ms` from the process start (Android 13+: from the moment the system was asked to start it, `from: "launchRequest"`) to the first frame of the first activity that resumes (`screen`), with `kind: "cold"` |

Limits:

- Frames come from `Window.addOnFrameMetricsAvailableListener` for activity windows; dialogs, popups and
  `SurfaceView` / game surfaces are not measured. With two visible activities (multi-window) their frames add up.
- Before Android 7, and on Android 7+ until Dürbün sees an activity start (when it was started after the first
  screen), `fps` / `jankyFrames` come from a Choreographer callback: `fps` then follows the display's refresh rate
  even when nothing changes on screen, and a janky frame is a gap of more than 1.5 refresh intervals.
- The launch time needs Android 7+ and Dürbün started from `Application.onCreate` or the first activity's
  `onCreate` (the automatic start counts). Nothing is sent when the process was started for something else (a
  receiver, a service, a job) and the screen came later, when Dürbün started more than 10 s after the process, or
  when the first frame took more than 30 s. Warm and hot starts (the process was already running) are not reported.
  The time includes everything before `Application.onCreate` (content providers, static initializers). Debug
  builds launch slower than release builds: compare launches of the same build with each other.

## Mocks

Mock rules are defined in the Mac app's Mocks tab ([how to write them](../../docs/guides/mocks.md)) and apply
to every `OkHttpClient` that has `DurbunInterceptor`:

| Action | What the app sees |
|---|---|
| `respond` | A synthesized response that never touches the network (the request body is then written once, to a side buffer) |
| `delay` | The real call, after waiting the given time |
| `fail` | The platform's real exception: `timeout` → `SocketTimeoutException`, `connection` → `ConnectException`, `dns` → `UnknownHostException`, `tls` → `SSLHandshakeException`; a custom message gives an `IOException` |

- With `addNetworkInterceptor`, `respond` rules are skipped (see [Network](#network)); delay and failure rules
  still work.
- A rule can be limited to one GraphQL operation (name, and optionally query / mutation / subscription). The
  operation is read from a JSON body (`operationName`, else the first operation of `query`; batched arrays too),
  an `application/graphql` body, or the URL of a GET request. To read a body before deciding, the SDK writes it
  once into memory and the call then sends that copy, so your body is still written once. That is done only for a
  body OkHttp may write more than once and whose length is known and at most 192 KB: a one-shot or duplex body, a
  streamed body of unknown length, a multipart body or a larger one cannot be read, and such a rule then does not
  match (the call goes to the network, or to the next rule).
- Hosts in `ignoredHosts` are never mocked.
- When the connection drops, the mock rules that connection pushed are removed at once; the Mac app sends them
  again when it reconnects.

## Tools

Your own tools appear in the Mac app's Device tab, under App tools:

```kotlin
Durbun.addAction(DurbunAction.button("app.logout", "Log out") { session.logout() })
Durbun.addAction(DurbunAction.toggle("app.staging", "Staging API", initial = false) { useStaging = it })
Durbun.addAction(
    DurbunAction.select(
        "app.locale", "Language",
        listOf(DurbunAction.Option("en", "English"), DurbunAction.Option("de", "Deutsch")),
        initial = "en",
    ) { locale -> changeLocale(locale) },
)
```

Handlers run on the main thread. Built in:

| Tool | What it does |
|---|---|
| Dump threads | Every thread's stack, written as a log entry |
| Run garbage collection | Java heap before and after |
| Appearance | System / Light / Dark for this app (Android 12+; Android keeps the choice for the app until it is set back to System) |
| Dump view hierarchy | The view tree of the visible activities (class, frame, visibility, id, text), at most 5,000 views; dialogs and popups are separate windows and not included |
| Dump SharedPreferences | Every preferences file of the app with its keys and values (read off the main thread) |

## Release builds and safety

### Which builds run Dürbün

- A build with `durbun-noop` contains no Dürbün code, threads or sockets.
- In a non-debuggable build with `durbun`, `Durbun.start()` and the automatic start do nothing; with
  `Durbun.start(this, DurbunOptions(forceInRelease = true))` it runs,
  wherever the app was installed from (Firebase, Google Play, other stores, adb). Each project decides which
  builds run Dürbün.

### Test builds (staging, QA, Firebase App Distribution)

Testers often install a non-debuggable build, for example a `staging` build type shared through Firebase App
Distribution. To run Dürbün in such a build, give it the real SDK and turn `forceInRelease` on for it:

`app/build.gradle.kts`:

```kotlin
android {
    buildFeatures { buildConfig = true }
    defaultConfig { buildConfigField("boolean", "DURBUN", "false") }
    buildTypes {
        getByName("debug") { buildConfigField("boolean", "DURBUN", "true") }
        create("staging") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            buildConfigField("boolean", "DURBUN", "true")
        }
    }
}

dependencies {
    // debugImplementation and releaseImplementation as in "Install", plus the real SDK for
    // staging, with the same version:
    "stagingImplementation"("io.github.mykynk:durbun:<version>")
}
```

`Application.onCreate`:

```kotlin
Durbun.start(this, DurbunOptions(forceInRelease = BuildConfig.DURBUN))
```

- `durbun-noop` has the same API, so this line compiles in every build type; in `release` it does nothing.
- With product flavors instead of a build type, use variant configurations so that each variant gets exactly
  one of the two artifacts, for example `"qaReleaseImplementation"` for `durbun` and
  `"prodReleaseImplementation"` for `durbun-noop`, and set `DURBUN` per flavor.
- The `durbun` module adds the `INTERNET` permission to the builds it is part of. No R8 rules and no cleartext
  settings are needed.
- Without `forceInRelease`, a non-debuggable build with `durbun` stays off. A `Durbun.start` call there logs
  `Dürbün is off: this build is not debuggable (set forceInRelease = true to override).` under the `Durbun`
  tag; the automatic start stays off without a log line.
- A build with Dürbün on behaves as described in [Connect to the Mac](#connect-to-the-mac), wherever it is
  installed from: over USB the phone needs USB debugging, over Wi-Fi the app needs the Mac's address
  ([without a rebuild](#giving-the-app-the-macs-address) too).

The [test builds guide](../../docs/guides/qa-builds.md) covers Flutter, iOS and React Native as well.

### Safety and security

- The `durbun` module's manifest adds the `INTERNET` permission and a small start-up provider
  (`exported="false"`; it starts Dürbün in debuggable builds unless `dev.durbun.autoStart` is `false`); with `debugImplementation`
  both are merged into debug builds only.
- Dürbün uses a **plain TCP socket, not HTTP**: no `usesCleartextTraffic` or network security config changes
  are needed.
- No R8/ProGuard rules are needed. For apps without OkHttp, the modules ship `-dontwarn` lines for exactly the
  OkHttp and Okio classes the SDK references (missing OkHttp classes that your own code needs are still
  reported by R8).
- When the connection drops, the mock rules that connection pushed are removed at once; the Mac app sends them
  again when it reconnects.
- Security note: the connection has no pairing yet. A build with Dürbün enabled connects to `127.0.0.1:9751` on
  the device and talks to whatever answers there: the Mac app (through adb reverse) or another app listening on
  that port. Logs and network traffic go to that peer, and the mock rules it pushes apply while it stays
  connected. See [Security](../../README.md#security).

## Options

`DurbunOptions`:

| Option | Default | Description |
|---|---|---|
| `host` | `null` | The Mac's IP address for Wi-Fi (not needed over USB or on an emulator; see [Giving the app the Mac's address](#giving-the-app-the-macs-address)) |
| `port` | `9751` | The Mac app's SDK port |
| `enabled` | `true` | `false` makes every call a no-op |
| `forceInRelease` | `false` | Also run in non-debuggable builds |
| `captureBodies` | `null` | Overrides the Mac app's setting (`false` records sizes only) |
| `maxBodyBytes` | `null` | Capture limit per body, at most 8 MB (the Mac app's default is 1 MB) |
| `maxBufferedMessages` | `5000` | Messages kept in memory while disconnected |
| `captureCrashes` | `true` | Report uncaught exceptions (the previous handler always runs) and how earlier launches ended |
| `captureMetrics` | `true` | CPU, PSS memory, Java heap, thread count, frames (FPS, janky frames, frame times), launch time |
| `captureLogcat` | `true` | Forward the app's own logcat when the Mac app cannot read device logs |
| `appName` | `null` | Name shown in the Mac app (default: the app label) |
| `captureNetwork` | `true` | OkHttp capture and mocks through `DurbunInterceptor` (`false` makes the interceptor a pass-through: no capture, no mocks) |
| `redactHeaders` | `emptySet()` | Header names (case-insensitive) masked as `••••` in every client's captured calls; the real request is unchanged |
| `ignoredHosts` | `emptyList()` | Hosts never captured (subdomains included); mock rules do not apply to them |

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

About 10 seconds after start, when the Mac app has not connected yet, the SDK writes **one** warning under the
`Durbun` logcat tag: what it tried, the likely reason and the next step. The same is available in code:

```kotlin
val status = Durbun.connectionStatus      // isConnected, via, desktopHost, issue, hint, failedAttempts
Durbun.addConnectionListener { status -> Log.i("App", status.toString()) }   // on a background thread
```

| `issue` | Likely reason | Next step |
|---|---|---|
| `usbNotSetUp` | No `adb reverse` on the cable | Connect with USB debugging on and open the Dürbün Mac app, or set a Wi-Fi address |
| `usbDesktopClosed` | `adb reverse` is there, nothing answers on the Mac | Open the Dürbün Mac app |
| `desktopNotRunning` | Emulator: nothing listens on the Mac's port | Open the Dürbün Mac app (or check its SDK port) |
| `lanRefused` | The Mac does not accept Wi-Fi connections | Settings → Connection → "Allow local network (Wi-Fi) connections" |
| `lanTimeout` | No answer from the address | Check the address, the Wi-Fi network and the Mac's firewall |
| `lanUnreachable` | The phone is on another network | Join the Mac's Wi-Fi |
| `lanBadAddress` | The address cannot be resolved | Use the Mac's IP address |
| `permissionDenied` | No `INTERNET` permission, a firewall or data saver app | Add the permission / allow the app |
| `notDurbun` | Another program answered on the port | Check the port and the Dürbün version |

The other Dürbün SDKs use the same table and words.

### More help

More symptoms and fixes, for every platform: [Troubleshooting](../../docs/guides/troubleshooting.md). Which SDK
version works with which Mac app: [Versions and upgrades](../../docs/guides/versions.md).

## Development

```bash
cd sdks/android
./gradlew :durbun:testDebugUnitTest :durbun:assembleDebug :durbun-noop:assembleRelease
```

End-to-end test against a running Dürbün Mac app. Its SDK port is 9751 and its HTTP port defaults to the SDK
port minus 1 (override with `DURBUN_E2E_HTTP_PORT`). The test is skipped unless `DURBUN_E2E_PORT` is set:

```bash
DURBUN_E2E_PORT=9751 ./gradlew :durbun:testDebugUnitTest --tests '*E2E*'
```

The mock-matching test uses `durbun/src/test/resources/mock-parity.json`, generated from the protocol's
reference `mockRuleMatches` function. To regenerate it, run this from the repository root:
`node --import tsx sdks/android/tools/gen-mock-parity.mjs`.

After a build, run `python3 -I tools/check-binary-compat.py`. It checks `durbun` / `durbun-noop` API parity,
binary compatibility with OkHttp 3.14 + Okio 1.x, and that the consumer R8 rules cover every referenced
OkHttp/Okio class.

The web view script is written once, in `sdks/js/webview/bridge.ts`, with its tests in `sdks/js`.
`DurbunWebView` embeds a generated copy (`durbun/src/main/kotlin/dev/durbun/internal/WebViewBridgeScript.kt`);
after changing the script, run `npm run webview:generate -w @durbun/react-native` from the repository root
(`webview:check` fails when a copy is out of date).

### Sample app

`sample/` is a small app that shows each part of the SDK: OkHttp calls through `DurbunInterceptor` (success,
404, slow, failing), a WebSocket through `DurbunWebSocketFactory`, a Server-Sent Events stream, a log line at
each level, an event, a crash and app tools (`Durbun.addAction`), plus a web view page with `DurbunWebView`. It talks
to a tiny server it runs itself on 127.0.0.1, so it needs no network. Its debug build uses `durbun`, its release
build `durbun-noop`. The sample depends on `androidx.webkit` (the SDK does not), so its web view page shows the
document-start path: the bridge runs before the page's own scripts, in every frame, on WebViews that support it.

```bash
cd sdks/android
./gradlew :sample:installDebug      # or :sample:assembleDebug
```

The sample is only part of the build when a `:sample:` task is asked for (or Android Studio syncs the project),
so the commands above that build the SDK do not build it.

### Unreleased changes from a clone

To try changes that are not released yet, build the SDK from a clone of the Dürbün repository with one of the
two options below.

**Option A: from a local path.** Include the modules from a clone of the Dürbün repository.
`settings.gradle.kts` (adjust the path to where the repository is cloned):

```kotlin
include(":durbun", ":durbun-noop")
project(":durbun").projectDir = file("../durbun/sdks/android/durbun")
project(":durbun-noop").projectDir = file("../durbun/sdks/android/durbun-noop")
```

Groovy (`settings.gradle`):

```groovy
include ':durbun', ':durbun-noop'
project(':durbun').projectDir = new File(rootDir, '../durbun/sdks/android/durbun')
project(':durbun-noop').projectDir = new File(rootDir, '../durbun/sdks/android/durbun-noop')
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation(project(":durbun"))        // the real SDK, debug builds only
    releaseImplementation(project(":durbun-noop")) // same API with empty bodies in release
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"(project(":durbun-noop"))
}
```

Included from a local path, the modules apply `com.android.library` and `org.jetbrains.kotlin.android`
**without versions**, so your root build must declare the Android Gradle Plugin and the Kotlin plugin (standard
in Android Studio projects).

**Option B: from your local Maven repository.** Publish the artifacts from your clone:

```bash
cd sdks/android
./gradlew publishToMavenLocal   # into ~/.m2
```

Then add `mavenLocal()` to your repositories (before `mavenCentral()`) and use the same coordinates as in
[Install](#install).

### Publishing

The version lives in one place: `Durbun.VERSION` in `durbun/src/main/kotlin/dev/durbun/Durbun.kt`.

```bash
./gradlew publishToMavenLocal                         # into ~/.m2
./gradlew publishReleasePublicationToStagingRepository # into build/staging-deploy
```

Zip `build/staging-deploy` and upload it to the Maven Central Portal. Artifacts are signed only when a key is
configured: the `signingInMemoryKey` Gradle property (plus `signingInMemoryKeyPassword` and, optionally,
`signingInMemoryKeyId`), the same names as `ORG_GRADLE_PROJECT_*` environment variables, or the classic
`signing.keyId` settings.
