import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript build script without type declarations
import { missingFromAsar, REQUIRED_IN_ASAR } from '../scripts/asarCheck.mjs';

const asar = createRequire(import.meta.url)('@electron/asar') as { createPackage(src: string, dest: string): Promise<unknown> };

async function pack(files: string[]): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-asar-'));
  const src = path.join(dir, 'app');
  for (const f of files) {
    mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    writeFileSync(path.join(src, f), 'x');
  }
  const out = path.join(dir, 'app.asar');
  await asar.createPackage(src, out);
  return out;
}

describe('missingFromAsar (npm run app:dist)', () => {
  it('passes the packaged layout: main, preload, server and UI inside the archive', async () => {
    const archive = await pack([...REQUIRED_IN_ASAR, 'server/server.mjs.map', 'server/ui/assets/index-abc.js']);
    expect(missingFromAsar(archive)).toEqual([]);
  });
  it('names what is missing, e.g. a server left in Resources/ outside the archive', async () => {
    const archive = await pack(['package.json', 'out/main.mjs', 'out/preload.cjs']);
    expect(missingFromAsar(archive)).toEqual(['server/server.mjs', 'server/ui/index.html']);
  });
});
