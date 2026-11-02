/**
 * Dev-loop helper for parallel work (SPEC §9.5): the normal UI config plus two escape hatches so you can
 * build your own UI copy while another team's feature folder is mid-edit.
 *
 *   npx vite build --config dev/vite.stub.config.ts --outDir <your tmp>/ui --emptyOutDir
 *   STUB_FEATURES=logs,network npx vite build --config dev/vite.stub.config.ts …   # render those tabs empty
 *
 * - A CSS import inside src/features/** whose file does not exist yet becomes an empty stylesheet.
 * - Features listed in STUB_FEATURES are replaced by an empty view (use when their code does not build).
 * Never use it for the real build (`npm run build`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { mergeConfig, type Plugin, type UserConfig } from 'vite';
import base from '../vite.config.ts';

const STUB_FEATURES = (process.env.STUB_FEATURES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function featureStubs(): Plugin {
  return {
    name: 'durbun-feature-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      if (importer.includes('/src/features/') && source.endsWith('.css')) {
        const abs = path.resolve(path.dirname(importer), source);
        if (!fs.existsSync(abs)) return `\0stub-css:${abs}`;
      }
      const m = /^\.\.\/features\/([\w-]+)$/.exec(source);
      if (m && STUB_FEATURES.includes(m[1]!) && importer.endsWith(`${path.sep}shell${path.sep}FeatureHost.tsx`)) return `\0stub-feature:${m[1]}`;
      return null;
    },
    load(id) {
      if (id.startsWith('\0stub-css:')) return '';
      if (id.startsWith('\0stub-feature:')) return 'export default function StubbedFeature() { return null; }';
      return null;
    },
  };
}

export default mergeConfig(base as UserConfig, { plugins: [featureStubs()] });
