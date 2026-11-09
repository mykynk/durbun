# Dürbün Android SDK

> **Flutter app?** Do not add this SDK separately. The Flutter package
> [`package:durbun`](../flutter/durbun/README.md) already carries this Android core and starts it from Dart
> (there is no `Durbun.start` call; in a Flutter app it does nothing). If your native code uses OkHttp, one line
> is enough: `.addInterceptor(DurbunInterceptor())`. This page is for native-only Android apps.

The Dürbün Android SDK streams your app's **logs, OkHttp traffic (headers, bodies, timings), crashes, custom
events and performance metrics** (CPU, memory, FPS, janky frames) to the Dürbün desktop app on your Mac, live.
From the desktop you can define mocks (fake responses, latency, timeouts, DNS / TLS / connection failures) and
trigger buttons that run code inside the app.

**No log is left behind:**

| Source | How it arrives |
|---|---|
| Device logs (logcat, all processes) | Read by the desktop over USB or wireless adb; no SDK needed |
| `Durbun.log(...)`, Timber | Sent by the SDK as structured entries: tag, level, JSON data and full stack trace |
| The app's own logcat over Wi-Fi (no adb) | Read and forwarded by the SDK (multi-line messages are merged back) |
| Network (OkHttp) | `DurbunInterceptor` |
| Crashes | Uncaught exceptions; a crash that cannot reach the desktop is sent on the next launch |

The desktop renders every line legibly: level colors, tag colors, collapsible stack traces, a JSON tree, and
`→ GET /api/users 200 · 123 ms` lines inside the log stream.

## 1. Add the dependency

The SDK is on Maven Central as `io.github.mykynk:durbun` (the real SDK) and `io.github.mykynk:durbun-noop` (the
same API with empty bodies, for release builds). `mavenCentral()` is declared by default in Android projects.

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation("io.github.mykynk:durbun:0.1.0")        // the real SDK, debug builds only
    releaseImplementation("io.github.mykynk:durbun-noop:0.1.0") // same API with empty bodies in release
    // Flutter host apps also have a "profile" build type:
    // "profileImplementation"("io.github.mykynk:durbun-noop:0.1.0")
}
```

The published AARs are compiled with Kotlin 1.9 API and metadata and depend on `kotlin-stdlib` 1.9.24, so they
work in apps on Kotlin 1.9 and newer.

To try changes that are not released yet, build the SDK from a clone of the Dürbün repository with one of the
two options below.

### Option A: from a local path

Include the modules from a clone of the Dürbün repository. `settings.gradle.kts` (adjust the path to where the
repository is cloned):

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

### Option B: from your local Maven repository

Publish the artifacts from a clone of the repository (see [Development](#development)):

```bash
cd sdks/android
./gradlew publishToMavenLocal   # into ~/.m2
```

Then add `mavenLocal()` to your repositories (before `mavenCentral()`) and use the same coordinates as above.

### Requirements

- minSdk 21 or higher.
- OkHttp is optional and your own version is used (tested with 4.x, binary compatibility with 3.14 checked; 5.x
  keeps the same API).
- No other dependencies, not even AndroidX.

## 2. Start it in your Application

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Durbun.start(this)   // nothing else needed for USB and emulators
    }
}
```

`start()` never blocks the main thread; all networking and disk work happens on Dürbün's low-priority
background threads. The SDK never crashes your app: internal errors are swallowed and every queue is bounded.

## 3. OkHttp

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(DurbunInterceptor())   // hand the same client to Retrofit
    .build()
```

- Add it as the **last** application interceptor to see headers your own interceptors add (for example
  `Authorization`).
- Use `addNetworkInterceptor(DurbunInterceptor())` to see every redirect and retry separately (gzip and deflate
  bodies are decoded automatically, and the remote IP address is shown). OkHttp does not let network
  interceptors short-circuit a request, so `respond` mocks are skipped there (delay and failure mocks still
  work).
- Bodies are captured without touching the app's streams. A request body is copied while OkHttp writes it to
  the server (no body is ever written twice, so `InputStream` and file streams, progress-reporting bodies and
  one-shot bodies are safe). A response body is copied as the app reads it: Dürbün never reads ahead, and
  `execute()` returns as soon as the headers arrive.
- Reporting order: the request is reported first with its size, then again (same id) with its body once
  written. The response is reported at the end of the body, when the capture limit is reached, or when the app
  closes the body. A body closed unread shows its size only; a response that is never closed (leaked) stays
  pending on the desktop. SSE (`text/event-stream`), NDJSON, WebSocket, gRPC and audio/video streams are
  reported with their size only.
- To observe bodies, the interceptor hands request bodies (except `FormBody`) and captured response bodies
  down the chain in a thin wrapper (content type, length, and one-shot / duplex flags are forwarded). If your
  own interceptors check body classes (for example `body is MultipartBody`), add `DurbunInterceptor` after
  them.
- Mask secrets with `DurbunInterceptor(redactHeaders = setOf("Authorization", "Cookie"))`; values show as
  `••••`.
- Desktop mock rules apply here. `respond` synthesizes the response without touching the network (the request
  body is then written once, to a side buffer), `delay` waits and then performs the real call, and `fail`
  throws the platform's real exception (`SocketTimeoutException`, `UnknownHostException`, `ConnectException`,
  `SSLHandshakeException`).

**Not captured:** only `OkHttpClient`s that have `DurbunInterceptor` are seen, and every client needs it.
Add it to the clients that Retrofit, Coil, Glide's OkHttp integration (`okhttp3-integration`) and Ktor's
OkHttp engine build for themselves. Traffic over `HttpURLConnection` is not seen: Volley (`HurlStack`),
ExoPlayer / Media3 `DefaultHttpDataSource`, Glide's default loader, Ktor's CIO and Android engines, Cronet,
WebView and native (C/C++) code.

## 4. Logs and events

```kotlin
Durbun.i("auth", "User logged in", data = mapOf("userId" to 42, "plan" to "premium"))
Durbun.w("sync", "Sync is slow", data = mapOf("ms" to 2300))
Durbun.e("payment", "Payment failed", throwable = e)
Durbun.log(Level.DEBUG, "cache", "Cache cleared")
Durbun.event("purchase", mapOf("amount" to 49.9, "currency" to "USD"))
```

`data` can be a Map, List, number, enum, `JSONObject`, or a Gson / kotlinx.serialization JSON object; the
desktop shows it as a collapsible JSON tree.

### Timber

```kotlin
class DurbunTree : Timber.Tree() {
    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        Durbun.log(Level.fromPriority(priority), tag ?: "app", message, throwable = t)
    }
}

// In Application.onCreate
Timber.plant(Timber.DebugTree(), DurbunTree())
```

Timber appends the stack trace to the message as well; the SDK removes that copy so the desktop shows the
message once and the (folded) stack trace once. `DebugTree` also writes the same line to logcat: over Wi-Fi
the SDK removes that duplicate, and over USB the desktop de-duplicates identical lines.

## 5. Desktop buttons for your app (optional)

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

Handlers run on the main thread. Two buttons are built in: **Dump threads** (every thread's stack, written as
a log entry) and **Run garbage collection**.

## How the connection works

- **USB (cable or wireless adb):** when a device appears, the desktop runs `adb reverse tcp:9751 …`
  automatically, and the SDK connects to `127.0.0.1:9751` on the device. There is nothing to configure. To
  check, run `adb reverse --list`.
- **Emulator:** the same, plus `10.0.2.2:9751` (the Mac itself) is tried as a fallback.
- **Wi-Fi only (no adb):** enable LAN mode on the desktop (`durbun --lan`, or Settings → "Allow local network
  (Wi-Fi) connections") and pass the Mac's IP address:

  ```kotlin
  Durbun.start(this, DurbunOptions(host = "192.168.1.20"))
  // or: DurbunOptions(host = BuildConfig.DURBUN_HOST)
  ```

  In this mode the desktop cannot read device logs, so the SDK forwards the app's **own logcat**.
- If the connection drops, the SDK reconnects indefinitely with a 0.5 s → 3 s backoff. Meanwhile the last 5 000
  messages are kept in memory and sent on reconnect (a warning line reports how many were dropped, if any).
- Troubleshooting: filter logcat by the `Durbun` tag
  (`Waiting for the Dürbün desktop on 127.0.0.1:9751 …`, `Connected to the Dürbün desktop via …`).

## Permissions, cleartext and release safety

- The `durbun` module's manifest adds the `INTERNET` permission (it is merged into debug builds only).
- Dürbün uses a **plain TCP socket, not HTTP**: no `usesCleartextTraffic` or network security config changes
  are needed.
- A build with `durbun-noop` contains no Dürbün code, threads or sockets. In a non-debuggable build with
  `durbun`, `Durbun.start()` does nothing; with `forceInRelease = true` it runs, wherever the app was installed
  from (Firebase, Google Play, other stores, adb). Each project decides which builds run Dürbün.
- When the connection drops, the mock rules that connection pushed are removed at once; the desktop sends them
  again when it reconnects.
- Security note: the connection has no pairing yet. A build with Dürbün enabled connects to `127.0.0.1:9751` on
  the device and talks to whatever answers there: the desktop (through adb reverse) or another app listening on
  that port. Logs and network traffic go to that peer, and the mock rules it pushes apply while it stays
  connected.
- No R8/ProGuard rules are needed. For apps without OkHttp, the modules ship `-dontwarn` lines for exactly the
  OkHttp and Okio classes the SDK references (missing OkHttp classes that your own code needs are still
  reported by R8).

## Options (`DurbunOptions`)

| Option | Default | Description |
|---|---|---|
| `host` | `null` | The Mac's IP address for Wi-Fi (not needed over USB or on an emulator) |
| `port` | `9751` | Desktop SDK port |
| `enabled` | `true` | `false` makes every call a no-op |
| `forceInRelease` | `false` | Also run in non-debuggable builds |
| `captureBodies` | `null` | Overrides the desktop setting (`false` records sizes only) |
| `maxBodyBytes` | `null` | Capture limit per body (the desktop default is 1 MB) |
| `maxBufferedMessages` | `5000` | Messages kept in memory while disconnected |
| `captureCrashes` | `true` | Report uncaught exceptions (the previous handler always runs) |
| `captureMetrics` | `true` | CPU, PSS memory, Java heap, thread count, FPS, janky frames |
| `captureLogcat` | `true` | Forward the app's own logcat when the desktop cannot read device logs |
| `appName` | `null` | Name shown on the desktop (default: the app label) |
| `captureNetwork` | `true` | OkHttp capture and mocks through `DurbunInterceptor` (`false` makes the interceptor a pass-through: no capture, no mocks) |

## Development

```bash
cd sdks/android
./gradlew :durbun:testDebugUnitTest :durbun:assembleDebug :durbun-noop:assembleRelease
```

End-to-end test against a real Dürbün desktop. The desktop's SDK port is 9751 and its HTTP port defaults to the
SDK port minus 1 (override with `DURBUN_E2E_HTTP_PORT`). The test is skipped unless `DURBUN_E2E_PORT` is set:

```bash
DURBUN_E2E_PORT=9751 ./gradlew :durbun:testDebugUnitTest --tests '*E2E*'
```

The mock-matching test uses `durbun/src/test/resources/mock-parity.json`, generated from the protocol's
reference `mockRuleMatches` function. To regenerate it, run this from the repository root:
`node --import tsx sdks/android/tools/gen-mock-parity.mjs`.

After a build, run `python3 -I tools/check-binary-compat.py`. It checks `durbun` / `durbun-noop` API parity,
binary compatibility with OkHttp 3.14 + Okio 1.x, and that the consumer R8 rules cover every referenced
OkHttp/Okio class.

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
