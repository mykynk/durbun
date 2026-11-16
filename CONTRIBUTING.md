# Contributing to Dürbün

Thanks for helping. Bug reports, fixes, device log samples and documentation improvements are all welcome.
For a larger change, open an issue first so the approach can be agreed before you write the code.

By contributing you agree that your work is released under the [MIT License](LICENSE), and that you follow
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

| Folder | Contents |
|---|---|
| `packages/protocol` | Wire and data types shared by the server, the interface and the SDKs, and the reference mock matcher. The source of truth. |
| `packages/server` | Server, CLI, device drivers (`platform/android`, `platform/ios`, `platform/flutterVm`), SDK wire protocol, HTTP and WebSocket API, demo data |
| `packages/ui` | React interface; read [`packages/ui/src/README-ui.md`](packages/ui/src/README-ui.md) before changing it |
| `apps/desktop` | Electron Mac app (its own `package.json` and `node_modules`) |
| `sdks/flutter/durbun`, `sdks/flutter/durbun_dio` | Flutter plugin and Dio interceptor |
| `sdks/android`, `sdks/ios`, `sdks/js` | Android, iOS and React Native / JavaScript SDKs |
| `SPEC.md` | Product and engineering specification |

## Setup

You need Node.js 20 or later. For the SDKs: Flutter 3.27 or later, JDK 17, and Xcode for iOS.

```bash
npm install
npm --prefix apps/desktop install
```

## Running and testing

| What | Command |
|---|---|
| Server + interface with hot reload | `npm run dev` (add `-- --demo` for demo devices) |
| Interface only, with a mock server | `npm run mock -w @durbun/ui` and `npm run dev:mock -w @durbun/ui` |
| Type checks | `npm run typecheck` |
| Server, interface and JS SDK tests | `npm test` (one area: `npm test -w @durbun/server -- test/hub`) |
| Mac app | `npm --prefix apps/desktop run typecheck` and `npm run app:test` |
| Flutter | in `sdks/flutter/durbun`: `flutter analyze`, `flutter test`, `dart run tool/sync_native.dart --check` |
| Android | in `sdks/android`: `./gradlew :durbun:testDebugUnitTest :durbun:assembleDebug :durbun-noop:assembleRelease`, then `python3 tools/check-binary-compat.py` |
| iOS | in `sdks/ios`: `swift build`, `swift test` |
| Versions | `node scripts/check-versions.mjs` |

A real server (even with `--demo`) starts device drivers for any phone that is plugged in. For interface
work, the mock server is the safer choice.

Run the checks for every part you changed before you open a pull request, and say in it which ones you ran.

## Building the Mac app

```bash
npm run app:dist
```

This builds `Durbun-<version>-arm64.dmg` and `mac-arm64/Dürbün.app` in `apps/desktop/release/`, ad-hoc signed
for this Mac. It overwrites an earlier build in that folder, so quit a copy that runs from there first.
`npm run app:release` builds the Apple silicon and Intel DMG and ZIP (see [Releasing](#releasing-maintainers)).
With a "Developer ID Application" certificate in `CSC_NAME` (or `CSC_LINK` + `CSC_KEY_PASSWORD`) the app is
signed with the hardened runtime, and with `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (or
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`) it is also notarized.

`npm run app` runs the app against the repository's `dist/`, and builds `dist/` only when it is missing: run
`npm run build` after changing the server or the interface.

To run a second copy next to an installed Dürbün, or for tests, set these variables:

| Variable | Effect |
|---|---|
| `DURBUN_PORT`, `DURBUN_SDK_PORT` | Interface and SDK ports (default 9750 and 9751) |
| `DURBUN_DATA_DIR` | Data folder (default `~/.durbun`) |
| `DURBUN_USER_DATA_DIR` | Window state, single-instance lock and logs (default `~/Library/Application Support/Dürbün`) |
| `DURBUN_DEMO=1` | Start with demo devices |
| `DURBUN_DEBUG=1` | More detail in the diagnostic log |

## Rules that keep the parts in sync

- **Protocol.** Never change an existing type in `packages/protocol/src/index.ts` or
  `packages/server/src/types.ts`; add optional members. Every SDK keeps its own copy of the wire types, so a
  protocol change touches all four SDKs (the JS copy is checked by `sdks/js/test/protocol-compat.test.ts`).
- **Mock matching.** After changing `mockRuleMatches`, regenerate the shared test vectors:
  `node --import tsx sdks/android/tools/gen-mock-parity.mjs` and
  `node sdks/ios/scripts/generate-mock-vectors.mjs`. The Dart test is written by hand.
- **Native cores in the Flutter plugin.** `sdks/flutter/durbun/android/src/core` and
  `sdks/flutter/durbun/ios/durbun/Sources/durbun/Core` are copies of `sdks/android/durbun` and
  `sdks/ios/Sources/Durbun`. Edit the originals, then run `dart run tool/sync_native.dart`.
- **Android public API.** Mirror every public API change in `:durbun-noop`; `check-binary-compat.py`
  enforces it.
- **SDKs never hurt the host app.** No I/O on the main thread, bounded queues, internal errors are
  swallowed, bodies are teed rather than consumed.
- **Flutter core.** `lib/src/core` never imports `package:flutter`; `types.dart` and `options.dart` do not
  import `dart:io` either (web).
- **Interface text.** Every string has English and Turkish text; every server code needs both texts in
  `packages/ui/src/i18n/codes.ts`. Colors come only from the variables in `tokens.css`.
- **Device output parsers** get unit tests built from real device lines (`packages/server/test/platform/fixtures`).
  Replace personal data, device names, serial numbers and company identifiers before you commit a sample.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org) in English, with the area as the scope:
  `feat(ui): …`, `fix(android): …`, `docs(flutter): …`. Scopes in use: `protocol`, `server`, `ui`, `desktop`,
  `flutter`, `dio`, `android`, `ios`, `js`, `ci`.
- Keep a pull request to one topic, describe what changed and how you tested it, and add an entry to
  `CHANGELOG.md` for user-visible changes.

## Releasing (maintainers)

All parts share one version and are released together, by hand from a maintainer's Mac.

1. Write the new version everywhere with `node scripts/check-versions.mjs --write X.Y.Z`, and move the
   changelog entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading (and `## X.Y.Z` in the Flutter
   changelogs). Merge to `main`.
2. Run `npm run release:check` on `main`. It runs every check a release needs, one after the other: a clean
   tree on `main`, a tag that does not exist yet, no signing keys or `.env` files in git, the versions, the
   changelog section dated today (with an empty `## [Unreleased]` kept above it), the latest Electron patch
   of its major version, type checks, tests and builds of every part, the Flutter, Android and iOS SDKs, `pub publish --dry-run`,
   `npm pack --dry-run` and `pod lib lint`. It changes nothing and stops at the first problem with what to
   do; `npm run release:check -- --from <step>` continues from there (`--list` shows the steps,
   `--rehearse` tries it on another branch without the git and date checks).
3. Build the Mac app for Apple silicon and Intel with `npm run app:release`. Set the Developer ID and
   notarization variables first (see `apps/desktop/electron-builder.config.cjs`): without them the command
   stops and lists what is missing (`DURBUN_ALLOW_UNSIGNED=1` makes an ad-hoc build that must not be
   published). It clears the files of earlier builds from `apps/desktop/release`, verifies the signature,
   Gatekeeper and the stapled ticket of both apps, and writes the in-app update feeds
   `durbun-update-mac-arm64.json` and `durbun-update-mac-x64.json` (each names its ZIP with the ZIP's
   SHA-256 and size, and carries the version's changelog section as release notes). Then it prints the
   commands that sign, notarize and staple each DMG. Run those, and write the checksums last, in
   `apps/desktop/release`: `shasum -a 256 *.dmg *.zip durbun-update-mac-*.json > SHA256SUMS.txt`.
4. Only now tag and push: `git tag -a vX.Y.Z -m "Dürbün X.Y.Z"` and `git push origin vX.Y.Z`. A pushed tag
   never moves: Swift Package Manager caches it.
5. Draft the GitHub release with the version's changelog section as notes
   (`node scripts/release-notes.mjs X.Y.Z > notes.md` adds which DMG is for which Mac, the SDK lines to
   upgrade to and how to check the checksums) and attach the DMG and ZIP files, both
   `durbun-update-mac-*.json` feeds and `SHA256SUMS.txt`:
   `gh release create vX.Y.Z --draft --verify-tag --title "Dürbün X.Y.Z" --notes-file notes.md …`.
   The Mac app looks for updates at `releases/latest/download/durbun-update-mac-<arch>.json`, so a draft or
   a pre-release is never offered; publishing the release is what offers it. A release without the feed
   files makes **Check for Updates…** answer that there is no update information for that Mac. Before
   publishing, update an installed earlier version once with **Check for Updates…** (it must be a
   Developer ID signed copy in Applications; other copies are offered the DMG).
6. Publish the packages:
   - pub.dev: `dart pub publish` in `sdks/flutter/durbun`, then in `sdks/flutter/durbun_dio`.
   - npm: `npm publish` in `sdks/js`.
   - Maven Central: in `sdks/android`, `./gradlew publishReleasePublicationToStagingRepository` with the
     signing key set (see `gradle/publish.gradle.kts`), zip `build/staging-deploy` and upload it on the
     Central Portal.
   - CocoaPods: `pod trunk push Durbun.podspec` from the repository root.
7. Update the [website](https://appnify.dev/durbun/) once the release is published: `node scripts/site-data.mjs
   --dir apps/desktop/release --date <the day it was published, UTC> --out <site>/assets/durbun/release.json`
   writes the version, the date, the minimum macOS and each DMG's address, size and SHA-256 (it checks them
   against `SHA256SUMS.txt`) into the one file the site reads.
