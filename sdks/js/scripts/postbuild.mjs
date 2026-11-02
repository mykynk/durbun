// Marks dist/cjs as CommonJS (the package itself is "type": "module") and sanity-checks the output:
// the published files must not depend on any other package at runtime.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
writeFileSync(join(dist, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

const offenders = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(js|d\.ts)$/.test(entry.name)) {
      // Block comments hold usage examples ("import … from '@durbun/react-native'"): skip them.
      const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const specs = [
        ...text.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
        ...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
        ...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((m) => m[1]);
      for (const spec of specs) {
        // Relative imports and the optional, guarded react-native lookup are the only allowed specifiers.
        if (!spec.startsWith('.') && spec !== 'react-native') offenders.push(`${path}: ${spec}`);
      }
    }
  }
};
walk(dist);
if (offenders.length) {
  console.error('dist must not import other packages:\n' + offenders.join('\n'));
  process.exit(1);
}
console.log('dist ok: ESM (dist/) + CommonJS (dist/cjs/), no runtime dependencies');
