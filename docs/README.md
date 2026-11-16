# Dürbün documentation

Every guide in one place, by who you are and what you need. The [README](../README.md) covers installing the Mac
app, what each SDK captures, privacy and uninstalling.

## Using Dürbün

| Guide | What you find there |
|---|---|
| [Dürbün for testers](guides/testers.md) | Installing the Mac app, connecting an Android phone or an iPhone, finding your app, reading logs and requests, reporting what you found |
| [Troubleshooting](guides/troubleshooting.md) | Fixes by symptom: the phone does not appear, no iPhone logs, missing requests or crashes, the app does not connect, Wi-Fi, ports |
| [Mock rules](guides/mocks.md) | Writing rules, how they match and in which order, what happens inside the app, recipes and limits |
| [Flow files](flows/README.md) | The flow format: structure, templates, rules, automation, writing flows with an AI, editor support |
| [Sharing and backups](../README.md#sharing-and-backups) | `.durbun` packages for your team, backups for a new Mac, automatic backups and what goes in them |
| [Versions and upgrades](guides/versions.md) | Which SDK works with which Mac app, and how to upgrade each part |
| [Dürbün in test builds](guides/qa-builds.md) | Turning the SDK on in staging, Firebase App Distribution, TestFlight and ad hoc builds |

## Adding the SDK to an app

| Guide | What you find there |
|---|---|
| [Flutter: `durbun`](../sdks/flutter/durbun/README.md) | Setup, the in-app panel, release, Firebase and store builds, what is captured, options |
| [Flutter: `durbun_dio`](../sdks/flutter/durbun_dio/README.md) | Capturing Dio requests that bypass `dart:io` (`NativeAdapter`, cronet_http) |
| [Android](../sdks/android/README.md) | Gradle setup, `DurbunInterceptor` for OkHttp, the no-op artifact for release builds, test builds |
| [iOS](../sdks/ios/README.md) | Swift Package Manager and CocoaPods setup, URLSession capture, test builds |
| [React Native / JavaScript](../sdks/js/README.md) | npm setup, Expo, what is captured, connecting a real device, release safety |

## Security and contributing

| Document | What you find there |
|---|---|
| [Security policy](../SECURITY.md) | How to report a vulnerability privately, what is in and out of scope |
| [Contributing](../CONTRIBUTING.md) | Building from source, the Mac app build, tests, repository layout, rules for pull requests, releasing |
| [Code of Conduct](../CODE_OF_CONDUCT.md) | How to behave in the project and how to report a problem |
| [Changelog](../CHANGELOG.md) | What changed in each version |
