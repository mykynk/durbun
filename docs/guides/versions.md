# Versions and upgrades

The Mac app, the server and every SDK carry one version number and are released together from a `vX.Y.Z`
tag. They do not have to be upgraded together: a team can update the Mac app on one Mac and leave the SDK in
the app as it is, or the other way round.

## The compatibility rule

Apps talk to the Mac over Dürbün's wire protocol. Its version number is `1`, and it has not changed since
0.1.0. Both sides follow the same rules:

- **Neither side refuses the other because of its version.** The SDK sends its name, its version and the
  protocol number when it connects; the Mac app accepts every SDK and the SDK accepts every Mac app.
- **New things are added, not changed.** New fields are optional and new message types are new. A side that
  does not know a field or a message ignores it. An SDK that does not know a command answers that it cannot
  run it; a mock rule it cannot read is skipped.
- **Features are announced, not assumed.** Each SDK says what it can do (logs, network, mocks, metrics,
  events, crashes, commands). Where an older SDK lacks something, the Mac app says so ("The connected Dürbün
  SDK does not send this (an older version or a disabled feature)") instead of failing.

So any 0.1.x or 0.2.x SDK works with any 0.1.x or 0.2.x Mac app. A new feature works when both sides have
it: for example the Flutter in-app panel's **Send to Slack** needs the 0.2.0 Flutter SDK, and Flows need the
0.2.0 Mac app with whatever SDK the app already has.

Contributors keep this rule: existing protocol types are never changed, only optional members are added (see
[CONTRIBUTING.md](../../CONTRIBUTING.md)). While the version is `0.x`, minor releases may still include
breaking changes, so read [CHANGELOG.md](../../CHANGELOG.md) before upgrading.

## Files between Mac apps

| File | Rule |
|---|---|
| Session recording (`.durbun.json`) | Recordings use format version 1. Releases after 0.2.0 also open a recording with a higher format version and import what they understand; 0.2.0 and earlier refuse it |
| Package (`.durbun`: shared setup or backup) | Package format version 1, read by Dürbün 0.2.0 and later. A Dürbün that reads another package version says so and asks you to update |
| Flow file (`.json`) | Flow format version 1, read by Dürbün 0.2.0 and later. Another version is refused with a request to update Dürbün |
| Mock rules export (`durbun-mocks-….json`) | Rules are checked one by one on import; a rule Dürbün cannot read is listed and skipped |

## Finding the versions in use

- **Mac app:** Settings → **About** shows the version and the protocol number. **Dürbün → Check for
  Updates…** tells you whether a newer release exists.
- **SDK in an app:** click any log line of the app; the detail panel's **SDK** field shows the SDK's name and
  version, for example `durbun-flutter 0.2.0`.

## Upgrading

### The Mac app

1. **Dürbün → Check for Updates…** opens the download page when a newer release exists. Dürbün never checks
   on its own.
2. Quit Dürbün (⌘Q), download the DMG for your Mac and drag the new Dürbün over the old one in Applications.

Settings, mock rules, flows, environments and run history stay in `~/.durbun` and carry over.

### The SDKs

Each SDK guide has the install lines. In short:

| SDK | Upgrade |
|---|---|
| Flutter | Raise `durbun` (and `durbun_dio`, if you use it) in `pubspec.yaml`, run `flutter pub get`, then `cd ios && pod install` once |
| Android | Raise `io.github.mykynk:durbun` and `io.github.mykynk:durbun-noop` together; keep both on the same version |
| iOS | Swift Package Manager: File → Packages → Update to Latest Package Versions in Xcode (a `from: "0.2.0"` requirement accepts later 0.x versions). CocoaPods: raise the version in the Podfile and run `pod update Durbun` |
| React Native | `npm install @durbun/react-native@<version>` |

What changed in each version, and anything you need to do when upgrading, is in
[CHANGELOG.md](../../CHANGELOG.md).

## Two Dürbüns on one Mac

The Mac app and a copy started from the command line (`npm start`) can run side by side. When another Dürbün
already holds port 9750, the app window shows that one, and the menu bar says when its version differs ("The
window shows another Dürbün (version …)"). When it stops, the app starts its own server.
