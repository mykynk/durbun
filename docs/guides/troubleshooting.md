# Troubleshooting

Each section starts from what you see, then lists what to check and how to fix it. Two screens answer most
questions on their own:

- **System check** (bottom of the sidebar, or Help **?** in the top bar): the tools Dürbün uses, the ports
  it listens on, and the command that fixes each problem (**Copy command**, then paste it into Terminal).
- **What can I see?** (the **ⓘ** button on an app's row in the sidebar): for one app, which data is
  available and why the rest is not.

Setting names below are in **Settings** (⌘,). Testers new to Dürbün can start with the
[guide for testers](testers.md).

## The Android phone does not appear

| Check | Fix |
|---|---|
| System check shows **Android Debug Bridge (adb)** as Missing | Install it with the command shown (`brew install --cask android-platform-tools`), or install Android Studio. Dürbün looks in the path set in Settings → Connection → Tool paths, then `$ANDROID_HOME`, `~/Library/Android/sdk/platform-tools` and `PATH` |
| USB debugging is off | On the phone: Settings → About phone → tap Build number seven times, then Settings → System → Developer options → **USB debugging** |
| The phone shows as **Waiting for permission** | Unlock the phone and tap **Allow** on "Allow USB debugging?". Tick "Always allow from this computer" so it is not asked again |
| The phone shows as **offline** | Unplug and replug the cable, or turn USB debugging off and on. If it stays offline, run `adb kill-server` in Terminal and replug |
| "adb has no permission to access this USB device" | Run `adb kill-server` and try another cable |
| "The device is in recovery or bootloader mode" | Restart the phone normally |
| The menu bar icon says the login shell did not answer | Dürbün could not read `PATH` from your shell, so it searches well-known folders only. Set the adb path in Settings → Connection → Tool paths |

## The iPhone does not appear, or says "Trust"

| Check | Fix |
|---|---|
| "Unlock the device and tap Trust on “Trust This Computer?”" | Unlock the iPhone, tap **Trust** and enter the passcode |
| System check shows **iOS USB connection (usbmuxd)** with a problem | Run the command it shows (`sudo killall -HUP usbmuxd`), then replug |
| The iPhone appears but says Developer Mode is off | Log lines still come in. For starting, stopping and installing apps, screenshots, recordings and crash reports: Settings → Privacy & Security → **Developer Mode**, then restart the iPhone. If the switch is missing, connect the iPhone to Xcode once |

## The iPhone shows no log lines, or too few

| Check | Fix |
|---|---|
| System check shows **iOS device logs (idevicesyslog)** as Missing | `brew install libimobiledevice`. The copy inside Flutter's cache also works; Dürbün finds it there |
| "The iPhone is connected, but its log stream has been silent…; restarting it" | Dürbün restarts the stream itself. If it keeps happening, replug the cable |
| Only app lines show, no system lines | That is the default. Settings → Logs → **iPhone log scope** → **Everything** shows every system process too (about 1000 lines a second on a busy phone) |
| "telling app lines apart needs Xcode 15 or newer (devicectl)" | Install Xcode 15 or later. Until then the system process lines are shown too |
| A release or store build logs very little | What a release build writes to the device log depends on the app's own logger; debug lines are often turned off in such builds |

## The simulator or emulator does not appear

- **iOS simulator.** System check → **Xcode command line tools** / **iOS Simulator tool (simctl)**. "Only the
  Command Line Tools are selected" or "Xcode is not installed or not selected": install Xcode, then run
  `sudo xcode-select -s /Applications/Xcode.app`. Only booted simulators appear.
- **Android emulator.** Emulators come in through `adb`, so the Android checks above apply.

## Crashes are missing

- **iPhone.** Crash reports (`.ips`) need Xcode 15 or later (`devicectl`) and Developer Mode on. Their stacks
  arrive as addresses; open the `.ips` file in Xcode or Console on a Mac that has the build's dSYM to read
  them.
- **Android.** Some manufacturers block reading Android's crash records (`dumpsys dropbox`). Live crashes still
  show up in the device log; records of earlier launches do not.
- Crash records from the last 7 days are read when a phone connects, so crashes from before Dürbün was
  running show up as "Crashed before watching".
- An empty crash list for a device whose records could not be read says so: no crash there does not
  necessarily mean nothing crashed.

## Network requests are missing

Start with the app's label in the sidebar:

| Label | Meaning | What to do |
|---|---|---|
| **Device log only** | Nothing comes from inside the app: no SDK, or the SDK is off in this build (release builds are off unless turned on) | Use a build with Dürbün turned on, see [Dürbün in test builds](qa-builds.md). Requests cannot be read from outside an app |
| **VM Service** | A Flutter debug app without the SDK. Only Dart's own HTTP is seen | Requests of the Kotlin or Swift layer need the SDK |
| **SDK** | The SDK is connected | See the next table |

With the SDK connected, a request is still missing when:

| Case | Fix |
|---|---|
| Android: the `OkHttpClient` has no `DurbunInterceptor` | Add `.addInterceptor(DurbunInterceptor())` to every client, including the ones Retrofit, Coil or Ktor build |
| Android: the library does not use OkHttp (`HttpURLConnection`, Volley, Cronet, WebView, native code) | Not captured; see the SDK guide for reporting such requests yourself |
| iOS: background `URLSession`s, WKWebView, AVPlayer | Not captured |
| Flutter: Dio's `NativeAdapter`, `cronet_http` | Add `DurbunDioInterceptor` from [`durbun_dio`](https://pub.dev/packages/durbun_dio) |
| Flutter: requests in background isolates (`compute`, `Isolate.run`), gRPC, raw sockets | Not captured; report them with `DurbunNetwork.begin` |
| React Native: `<Image>` downloads, requests made by native modules | Not captured |
| The request started before the SDK started | Start the SDK as early as possible (first line of `main`, `Application.onCreate`, `index.js`) |
| The app's own `redactHeaders` or `ignoredHosts` / `ignoreUrls` options | These hide values or whole hosts on purpose |

Bodies:

- **Settings → Network → Capture request and response bodies** off: only headers and timings are recorded.
- **Limit per body** (1 MB by default): longer bodies are cut; the real size is still shown.
- **Total body memory**: when full, the oldest bodies are dropped. **Max requests kept in memory** drops the
  oldest requests; the Network tab says when this happened.

## Log lines I expect are missing

- The sidebar scope: with one app selected, only its lines show. Click **All devices**.
- **Minimum level**, the search query and the **Log sources** filter (Device, App, System).
- **Noise**: known noisy system lines are hidden; the toolbar shows how many. Turn it off, or edit the noise
  rules.
- **Max logs kept in memory** (Settings → Logs): the oldest lines are dropped; the Logs tab says so.
- **Logcat history loaded on connect** (Settings → Logs): how many earlier lines are read when an Android
  device connects.
- iPhone: see [The iPhone shows no log lines](#the-iphone-shows-no-log-lines-or-too-few).

## The app does not connect (no SDK label)

The SDK connects by itself; there is nothing to pair. Check, in order:

1. **Is the SDK on in this build?** Release builds are off unless turned on: Flutter
   `--dart-define=DURBUN=true`, Android `forceInRelease`, iOS `allowInReleaseBuilds`, React Native
   `enabled: true`. See [Dürbün in test builds](qa-builds.md). The SDKs say so in their own logs:
   - Android logcat, tag `Durbun`: "Dürbün is off: this build is not debuggable (set forceInRelease = true to
     override).", then "Waiting for the Dürbün desktop on 127.0.0.1:9751 …" and "Connected to the Dürbün
     desktop via …".
   - iOS: the unified log, subsystem `dev.durbun.sdk` (Console.app, with Info messages shown): "Dürbün is
     disabled in non-DEBUG builds (set allowInReleaseBuilds to force it)."
   - React Native: `Durbun.start({ debug: true })` prints the addresses it tries.
2. **Is the device itself visible?** An Android phone or iPhone must appear in the sidebar first (sections
   above). Over USB the connection rides on the same cable: on Android Dürbün sets up `adb reverse` for every
   device (`adb reverse --list` shows a `tcp:9751` line), on an iPhone it connects through usbmux.
3. **Is the SDK port free?** A notice "Another program is using the SDK port (9751)" means simulators and
   Wi-Fi cannot connect; Android over USB still works. System check → **SDK port** shows the command that
   names the program (`lsof -nP -iTCP:9751 -sTCP:LISTEN`).
4. **Is another Dürbün running on this Mac?** A system line "This device's SDK connections go to another
   Dürbün running on this computer" means the other copy (for example `npm start`) keeps the phone's route.
   Apps show up there; device logs still appear in both. Quit one of them.
5. **Wi-Fi only?** See the next section.

## Wi-Fi connections

1. Settings → Connection → **Allow local network (Wi-Fi) connections**, and confirm. The section then lists
   **This Mac's addresses**. Only turn it on in networks you trust: the SDK port becomes reachable from other
   devices on the network.
2. Give the SDK the Mac's address: Flutter `DurbunOptions(host: …)` or `--dart-define=DURBUN_HOST=…`, Android
   `DurbunOptions(host = …)`, iOS `DurbunOptions(host:)` or `DURBUN_HOST` in the Xcode scheme, React Native
   `Durbun.start({ host: … })`.
3. iOS: add `NSLocalNetworkUsageDescription` to Info.plist and allow the Local Network prompt on the phone.
4. Keep the phone and the Mac on the same network.
5. React Native: its SDK uses the HTTP port (9750). After turning the setting on, quit and reopen Dürbün so
   that port is reachable from the network too.

Over Wi-Fi Dürbün cannot read the device log; the native SDKs forward the app's own log lines instead.
Device tools (screenshots, launching apps) need USB or a simulator.

## Mock rules do not apply

See [Mock rules → When a rule does not apply](mocks.md#when-a-rule-does-not-apply).

## The window says it cannot reach the server

- **"Can't reach the Dürbün server"**: quit Dürbün (⌘Q) and open it again; the page reconnects by itself.
- **"Dürbün could not start"**: the window offers **Try Again**, **Show Diagnostic Log** and **Quit**. The
  diagnostic log is also under Help → **Show Diagnostic Log** in the menu bar.
- **"Port 9750 is used by another program; Dürbün runs on port 9760."** Dürbün moved to the next free port
  (9760, 9770, 9780). Apps on Android, iPhones over USB and the native SDKs on simulators are not affected.
  React Native on a simulator or over Wi-Fi uses the HTTP port: pass the new port in its options. The SDK setup
  screen names the ports whenever they differ from the defaults.
- **"The window shows another Dürbün (version …)"**: another copy already runs on port 9750, for example
  `npm start`. The window shows that one; when it stops, the app starts its own server.
- **"Version mismatch"** in the status bar: the interface and the server speak different protocol versions,
  which happens when a source checkout's built interface is older than its server. Rebuild with
  `npm run build`.

## Flutter debug apps do not attach without the SDK

- Settings → Connection → **Auto-attach to the Flutter VM Service** must be on.
- Otherwise attach by hand: command palette (⌘K) → **Attach to a Dart VM Service…**, or SDK setup → Flutter,
  and paste the address `flutter run` prints ("A Dart VM Service … is available at: http://127.0.0.1:…") or
  its whole output.
- Debug and profile builds only; release builds have no VM Service.

## Still stuck

Help → **Report an Issue…** in the menu bar opens a new GitHub issue. Add the Dürbün version (Settings →
About), the phone and OS version, and the lines from Help → **Show Diagnostic Log** that look related.
