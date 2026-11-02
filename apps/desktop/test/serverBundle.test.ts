/** Contract with dist/server.mjs (built by `npm run build`): what the app imports must be there. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const bundle = path.resolve(__dirname, '..', '..', '..', 'dist', 'server.mjs');

describe.skipIf(!existsSync(bundle))('dist/server.mjs', () => {
  it('exports startServer and ServerStartError without side effects', async () => {
    const mod = await import(pathToFileURL(bundle).href);
    expect(typeof mod.startServer).toBe('function');
    expect(typeof mod.ServerStartError).toBe('function');
    expect(new mod.ServerStartError('busy', 'EADDRINUSE', 9750).code).toBe('EADDRINUSE');
  });
});
