import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/** Dürbün server the dev server proxies to (`DURBUN_SERVER=http://127.0.0.1:9799` for the dev mock). */
const server = process.env.DURBUN_SERVER ?? 'http://127.0.0.1:9750';

/**
 * Absolute repo path baked into the SDK guide's local-path snippets (overridable at build time; an empty
 * DURBUN_REPO_DIR, as `npm run app:release` sets it, bakes in no path and the guide defaults to the registries).
 */
const repoDir = (process.env.DURBUN_REPO_DIR ?? fileURLToPath(new URL('../..', import.meta.url))).replace(/\/+$/, '');

/** `@durbun/react-native` version → the SDK guide's `npm pack` file name (durbun-react-native-<version>.tgz). */
function rnSdkVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../sdks/js/package.json', import.meta.url)), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.2.0';
  } catch {
    return '0.2.0';
  }
}

/** SDK version for the guide's package-registry snippets (pub.dev, Maven Central, SwiftPM, CocoaPods, npm). */
function sdkVersion(): string {
  try {
    const pubspec = readFileSync(fileURLToPath(new URL('../../sdks/flutter/durbun/pubspec.yaml', import.meta.url)), 'utf8');
    return /^version:\s*([0-9][^\s#]*)/m.exec(pubspec)?.[1] ?? '0.2.0';
  } catch {
    return '0.2.0';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __DURBUN_REPO_DIR__: JSON.stringify(repoDir),
    __DURBUN_RN_VERSION__: JSON.stringify(rnSdkVersion()),
    __DURBUN_SDK_VERSION__: JSON.stringify(sdkVersion()),
  },
  build: {
    outDir: fileURLToPath(new URL('../../dist/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/ui': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    pool: 'forks',
    maxWorkers: 2,
  },
} as import('vite').UserConfig);
