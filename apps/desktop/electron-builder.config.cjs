/**
 * electron-builder: Dürbün.app + .dmg for Apple silicon, without a signing identity (identity: null).
 * The fuses step re-applies an ad-hoc signature (resetAdHocDarwinSignature), so the bundle's signature
 * is valid: a downloaded copy then asks "open anyway?" instead of reporting the app as damaged.
 * The embedded server (dist/server.mjs) and the UI (dist/ui) go to Contents/Resources/server.
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
  files: ['out/**', 'package.json'],
  extraResources: [
    { from: '../../dist/server.mjs', to: 'server/server.mjs' },
    { from: '../../dist/server.mjs.map', to: 'server/server.mjs.map' },
    { from: '../../dist/ui', to: 'server/ui', filter: ['**/*'] },
  ],
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
