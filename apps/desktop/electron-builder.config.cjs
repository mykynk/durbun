/**
 * electron-builder: Dürbün.app + .dmg (+ .zip for releases).
 *
 * Signing follows the environment:
 *   - No identity (the default, and `npm run app:dist` on the owner's Mac): identity null, ad-hoc signature.
 *     The fuses step re-applies it (resetAdHocDarwinSignature), so the bundle's signature is valid and a
 *     downloaded copy asks "open anyway?" instead of reporting the app as damaged.
 *   - CSC_NAME / CSC_LINK set (a "Developer ID Application" certificate): signed with the hardened runtime
 *     and build/entitlements.mac.plist. Notarized too when APPLE_API_KEY + APPLE_API_KEY_ID +
 *     APPLE_API_ISSUER (or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID) are set.
 * The embedded server (dist/server.mjs) and the UI (dist/ui) go into app.asar (server/…), next to the
 * main process, so the asar integrity fuse covers the code that actually runs: a changed server.mjs or
 * UI file no longer loads. Electron's main process imports ESM and reads files from inside the asar;
 * the server only spawns external tools (adb, xcrun), nothing from the archive.
 * @type {import('electron-builder').Configuration}
 */
const signed = Boolean(process.env.CSC_NAME || process.env.CSC_LINK);
const notarize =
  signed &&
  Boolean(
    (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
      (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
  );

module.exports = {
  appId: 'dev.durbun.desktop',
  // NFD on purpose: electron-builder names the helper apps (Dürbün Helper (GPU).app …) in NFD, and
  // Electron finds them through CFBundleName. An NFC CFBundleName (the plain 'Dürbün' literal) does
  // not match, the helpers cannot be launched and the app dies at start with SIGTRAP (Electron 45,
  // electron-builder 26.18). Both forms render identically.
  productName: 'Dürbün'.normalize('NFD'),
  copyright: 'Copyright © 2026 Muhammed Yusuf Kaynak',
  directories: { output: 'release', buildResources: 'build' },
  // paths.ts finds the server at <app.asar>/server/server.mjs; scripts/dist.mjs checks it is there.
  files: ['out/**', 'package.json', { from: '../../dist', to: 'server', filter: ['server.mjs', 'server.mjs.map', 'ui/**/*'] }],
  // Help → Licenses opens these (Contents/Resources/legal).
  extraResources: [
    { from: '../../LICENSE', to: 'legal/LICENSE' },
    { from: 'out/THIRD_PARTY_NOTICES.txt', to: 'legal/THIRD_PARTY_NOTICES.txt' },
  ],
  asar: true,
  npmRebuild: false,
  electronLanguages: ['en', 'tr'],
  mac: {
    // scripts/dist.mjs picks the architectures (arm64 for the local app, arm64 + x64 for a release).
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: '../../packages/ui/public/icon-512.png',
    identity: signed ? undefined : null,
    hardenedRuntime: signed,
    entitlements: signed ? 'build/entitlements.mac.plist' : undefined,
    entitlementsInherit: signed ? 'build/entitlements.mac.plist' : undefined,
    gatekeeperAssess: false,
    notarize,
    darkModeSupport: true,
    // Electron 45's framework is built for macOS 13 (LC_BUILD_VERSION minos 13.0): on 12 the app would
    // pass Finder and then die in dyld. With 13 macOS itself says the app needs a newer system.
    minimumSystemVersion: '13.0',
    // Electron's own Info.plist asks for camera, microphone and Bluetooth; Dürbün uses none of them.
    extendInfo: {
      NSCameraUsageDescription: null,
      NSMicrophoneUsageDescription: null,
      NSAudioCaptureUsageDescription: null,
      NSBluetoothAlwaysUsageDescription: null,
      NSBluetoothPeripheralUsageDescription: null,
    },
  },
  dmg: {
    title: 'Dürbün ${version}',
    artifactName: 'Durbun-${version}-${arch}.${ext}',
  },
  zip: {
    artifactName: 'Durbun-${version}-${arch}-mac.${ext}',
  },
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: !signed,
  },
  publish: null,
};
