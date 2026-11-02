import { describe, expect, it, vi } from 'vitest';
import { startOrAttachServer, type StartDeps } from '../src/startup';

const busy = (port: number) => Object.assign(new Error(`Port ${port} is already in use`), { name: 'ServerStartError', code: 'EADDRINUSE', port });

function deps(opts: { running?: Record<number, string>; failAt?: number[]; error?: Error; cancelled?: () => boolean } = {}) {
  const start = vi.fn(async (port: number) => {
    if (opts.error) throw opts.error;
    if (opts.failAt?.includes(port)) throw busy(port);
    return { port };
  });
  const d: StartDeps<{ port: number }> = {
    probe: async (p) => (opts.running?.[p] ? { version: opts.running[p]! } : undefined),
    // Every port looks free: the busy ones are only found by the server's own listen().
    isFree: async () => true,
    start,
    cancelled: opts.cancelled ?? (() => false),
  };
  return { d, start };
}

describe('startOrAttachServer', () => {
  it('starts on the preferred port', async () => {
    const { d, start } = deps();
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'started', server: { port: 9750 }, port: 9750, fallback: false });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('moves on when listen() fails with EADDRINUSE on a port that looked free', async () => {
    const { d, start } = deps({ failAt: [9750] });
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'started', server: { port: 9760 }, port: 9760, fallback: true });
    expect(start.mock.calls.map((c) => c[0])).toEqual([9750, 9760]);
  });

  it('reaches the OS-assigned port when every fixed port fails at listen()', async () => {
    const { d, start } = deps({ failAt: [9750, 9760, 9770, 9780] });
    const out = await startOrAttachServer(9750, 9751, d);
    expect(out).toMatchObject({ kind: 'started', port: 0, fallback: true });
    expect(start.mock.calls.map((c) => c[0])).toEqual([9750, 9760, 9770, 9780, 0]);
  });

  it('attaches to a Dürbün that answers, also after a lost race', async () => {
    expect(await startOrAttachServer(9750, 9751, deps({ running: { 9750: '0.1.0' } }).d)).toEqual({ kind: 'attached', port: 9750, version: '0.1.0' });
    // listen() lost the race against a Dürbün CLI starting on 9750 at the same moment
    const running: Record<number, string> = {};
    const { d } = deps({ failAt: [9750], running });
    const start = d.start;
    d.start = async (port) => {
      running[9750] = '0.1.0';
      return start(port);
    };
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'attached', port: 9750, version: '0.1.0' });
  });

  it('stops without starting once quit was requested', async () => {
    const { d, start } = deps({ cancelled: () => true });
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'cancelled' });
    expect(start).not.toHaveBeenCalled();
  });

  it('fails at once on other errors (EACCES, hub, config)', async () => {
    const { d, start } = deps({ error: Object.assign(new Error('No permission to listen on port 80'), { code: 'EACCES' }) });
    expect(await startOrAttachServer(80, 9751, d)).toEqual({ kind: 'failed', error: 'No permission to listen on port 80', code: 'EACCES' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(await startOrAttachServer(9750, 9751, deps({ error: new Error('settings.json: unexpected token') }).d)).toEqual({
      kind: 'failed',
      error: 'settings.json: unexpected token',
      code: undefined,
    });
  });
});
