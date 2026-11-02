import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installFileLog } from '../src/log';

describe('installFileLog', () => {
  it('gives the embedded server a scoped logger whose debug lines need verbose mode', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-log-')), 'logs', 'main.log');
    const log = installFileLog(file);
    const quiet = log.scoped('durbun');
    quiet.child('hub').info('store ready');
    quiet.child('hub').debug('not written');
    log.scoped('durbun', { debug: true }).child('sdk').debug('verbose line %d', 7);
    log.warn('desktop line');
    await new Promise((r) => setTimeout(r, 50)); // the write stream flushes asynchronously
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('INFO  [durbun:hub] store ready');
    expect(text).toContain('DEBUG [durbun:sdk] verbose line 7');
    expect(text).toContain('WARN  [desktop] desktop line');
    expect(text).not.toContain('not written');
  });
});
