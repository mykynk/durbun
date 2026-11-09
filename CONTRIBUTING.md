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

CI runs all of the above on every pull request.

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

All parts share one version and are released together.

1. Update the version everywhere `node scripts/check-versions.mjs` lists, and move the changelog entries
   under a new `## [X.Y.Z] - YYYY-MM-DD` heading (and `## X.Y.Z` in the Flutter changelogs).
2. Merge to `main`, then tag and push: `git tag -a vX.Y.Z -m "Dürbün X.Y.Z"` and `git push origin vX.Y.Z`.
3. The release workflow checks the versions, builds the Mac app (Apple silicon and Intel) and drafts a
   GitHub release with the DMG and ZIP files. Review the notes and publish it.
4. Publish the packages: `dart pub publish` in `sdks/flutter/durbun`, then in `sdks/flutter/durbun_dio`;
   Maven Central from `sdks/android` (see `gradle/publish.gradle.kts`); `pod trunk push Durbun.podspec`;
   `npm publish` in `sdks/js`.
