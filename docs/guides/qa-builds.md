# Dürbün in test builds

Testers usually install builds that are not debug builds: a staging APK from Firebase App Distribution, a
TestFlight or ad hoc build on an iPhone. Every Dürbün SDK is off in such builds until the project turns it on.
This page shows how, per platform. Which builds run Dürbün is each team's decision; the SDKs do not look at
where a build was installed from.

## What changes when the SDK is on

| | SDK off (or no SDK) | SDK on |
|---|---|---|
| Device log lines and crash records | Yes, over USB | Yes |
| The app's own structured logs and events | No | Yes |
| Network requests | No | Yes |
| Mock rules | No | Yes |
| Performance from inside the app | Android: from outside, approximate. iPhone: no | Yes |
| In-app tools (Device tab) | No | Yes |

The sidebar shows the difference: an app with the SDK on has the **SDK** label, one without has **Device log
only**, and a second label names how it was installed (**Firebase**, **Play**, **Store / TestFlight /
ad-hoc**…).

The connection works the same as in debug builds: over USB with nothing to configure, over Wi-Fi with the
Mac's address. A build with the SDK on talks to whatever answers on its port on the device; read
[Security](../../README.md#security) before deciding which builds get it.

## Flutter

One build flag, no code change:

```bash
flutter build apk --release --dart-define=DURBUN=true
flutter build ipa --release --dart-define=DURBUN=true
# .ipa for Firebase App Distribution or ad hoc:
flutter build ipa --release --export-method ad-hoc --dart-define=DURBUN=true
```

- Builds without the flag have Dürbün off.
- Per flavor: add the flag to that flavor's build command, or write `DurbunOptions(enabled: appFlavor == 'qa')`.
- An Xcode Archive made after `flutter build ... --dart-define=DURBUN=true` keeps the flag until the next
  `flutter build` without it, because Flutter writes it into `ios/Flutter/Generated.xcconfig`.
- Android release builds with Dürbün on need the `INTERNET` permission in the main manifest.

Details: [Release, Firebase and store builds](../../sdks/flutter/durbun/README.md#release-firebase-and-store-builds).

## Android (native)

Give the build type (or flavor) the real `durbun` artifact instead of `durbun-noop`, and start it with
`forceInRelease` from a `BuildConfig` flag:

```kotlin
Durbun.start(this, DurbunOptions(forceInRelease = BuildConfig.DURBUN))
```

The Gradle setup for a `staging` build type and for flavors:
[Test builds](../../sdks/android/README.md#test-builds-staging-qa-firebase-app-distribution).

## iOS (native)

Add a build configuration (for example Staging) with `DURBUN` in its Active Compilation Conditions, and start
the SDK under that condition with `allowInReleaseBuilds`:

```swift
#if DEBUG || DURBUN
Durbun.start(options: DurbunOptions(allowInReleaseBuilds: true))
#endif
```

Archive with that configuration and distribute through TestFlight, ad hoc or Firebase App Distribution. Step
by step, CocoaPods included:
[Test builds](../../sdks/ios/README.md#test-builds-testflight-ad-hoc-firebase-app-distribution).

## React Native

The SDK follows `__DEV__`. In the builds you choose, start it with `enabled: true`, for example from a
build-time setting your project already has:

```js
Durbun.start({ enabled: true });
```

In a release build the connection is a plain `ws://` WebSocket, so Android needs cleartext traffic allowed
for it and iOS needs the ATS `NSAllowsLocalNetworking` exception. An iPhone reaches the Mac only over Wi-Fi
(`host`). Details: [React Native guide](../../sdks/js/README.md#release-safety).

## Checking a test build

1. Plug the phone in. It appears in the sidebar (if not: [Troubleshooting](troubleshooting.md)).
2. Open the app. It shows the **SDK** label and the install source.
3. If it shows **Device log only**, the SDK is off in this build. The Android SDK says so in logcat under the
   `Durbun` tag, the iOS SDK in the unified log (subsystem `dev.durbun.sdk`).

Testers can follow the [guide for testers](testers.md).
