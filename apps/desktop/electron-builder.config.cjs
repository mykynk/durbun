/**
 * electron-builder: Dürbün.app + .dmg for Apple silicon, without a signing identity (identity: null).
 * The fuses step re-applies an ad-hoc signature (resetAdHocDarwinSignature), so the bundle's signature
 * is valid: a downloaded copy then asks "open anyway?" instead of reporting the app as damaged.
 * The embedded server (dist/server.mjs) and the UI (dist/ui) go into app.asar (server/…), next to the
 * main process, so the asar integrity fuse covers the code that actually runs: a changed server.mjs or
 * UI file no longer loads. Electron's main process imports ESM and reads files from inside the asar;
 * the server only spawns external tools (adb, xcrun), nothing from the archive.
 * hardenedRuntime stays off: it needs a signing identity (Developer ID); turn it on together with one.
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'dev.durbun.desktop',
  // NFD on purpose: electron-builder names the helper apps (Dürbün Helper (GPU).app …) in NFD, and
  // Electron finds them through CFBundleName. An NFC CFBundleName (the plain 'Dürbün' literal) does
  // not match, the helpers cannot be launched and the app dies at start with SIGTRAP (Electron 45,
  // electron-builder 26.18). Both forms render identically.
  productName: 'Dürbün'.normalize('NFD'),
  copyright: 'Dürbün',
  directories: { output: 'release', buildResources: 'build' },
  // paths.ts finds the server at <app.asar>/server/server.mjs; scripts/dist.mjs checks it is there.
  files: ['out/**', 'package.json', { from: '../../dist', to: 'server', filter: ['server.mjs', 'server.mjs.map', 'ui/**/*'] }],
  asar: true,
  npmRebuild: false,
  electronLanguages: ['en', 'tr'],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.developer-tools',
    icon: '../../packages/ui/public/icon-512.png',
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    darkModeSupport: true,
    minimumSystemVersion: '12.0',
  },
  dmg: {
    title: 'Dürbün ${version}',
    artifactName: 'Durbun-${version}-${arch}.${ext}',
  },
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  },
  publish: null,
};
