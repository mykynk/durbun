import { describe, expect, it, vi } from 'vitest';
import { STRINGS } from '../src/i18n';
import { DATA_DIR_IN_USE, startedOrigin, startOrAttachServer, type StartDeps } from '../src/startup';

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
    expect(await startOrAttachServer(9750, 9751, deps({ running: { 9750: '0.1.0' } }).d)).toEqual({
      kind: 'attached',
      port: 9750,
      version: '0.1.0',
      origin: 'http://127.0.0.1:9750',
    });
    // listen() lost the race against a Dürbün CLI starting on 9750 at the same moment
    const running: Record<number, string> = {};
    const { d } = deps({ failAt: [9750], running });
    const start = d.start;
    d.start = async (port) => {
      running[9750] = '0.1.0';
      return start(port);
    };
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'attached', port: 9750, version: '0.1.0', origin: 'http://127.0.0.1:9750' });
  });

  it('keeps what the proof found out about the page', async () => {
    const d: StartDeps<never> = {
      probe: async () => ({ version: '0.1.0', page: 'placeholder' }),
      isFree: async () => false,
      start: async () => {
        throw new Error('must not start');
      },
      cancelled: () => false,
    };
    expect(await startOrAttachServer(9750, 9751, d)).toMatchObject({ kind: 'attached', page: 'placeholder', origin: 'http://127.0.0.1:9750' });
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

describe('startedOrigin', () => {
  it('loads the bound port on 127.0.0.1, although the server names itself "localhost"', () => {
    expect(startedOrigin({ url: 'http://localhost:9760', info: { ports: { http: 9760 } } }, 9760)).toEqual({ port: 9760, origin: 'http://127.0.0.1:9760' });
    // port 0 was asked for: the real port comes from the server
    expect(startedOrigin({ url: 'http://localhost:53122', info: { ports: { http: 53122 } } }, 0)).toEqual({ port: 53122, origin: 'http://127.0.0.1:53122' });
    expect(startedOrigin({ url: 'http://localhost:53123' }, 0)).toEqual({ port: 53123, origin: 'http://127.0.0.1:53123' });
    expect(startedOrigin({ url: 'not a url' }, 9750)).toEqual({ port: 9750, origin: 'http://127.0.0.1:9750' });
  });
});

describe('data folder in use by another Dürbün', () => {
  const inUse = (port?: number) => Object.assign(new Error(`The data folder /x is in use by Dürbün on port ${port}`), { name: 'ServerStartError', code: DATA_DIR_IN_USE, port });
  it('opens the Dürbün that holds the folder when it answers there', async () => {
    const { d, start } = deps({ error: inUse(9850), running: { 9850: '0.3.0' } });
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'attached', port: 9850, version: '0.3.0', page: undefined, origin: 'http://127.0.0.1:9850', dataDirInUse: true });
    expect(start).toHaveBeenCalledOnce(); // no second start, no port fallback
  });
  it('fails with the holder named when it does not answer or has no port yet', async () => {
    expect(await startOrAttachServer(9750, 9751, deps({ error: inUse(9850) }).d)).toMatchObject({ kind: 'failed', code: DATA_DIR_IN_USE, holderPort: 9850 });
    const starting = await startOrAttachServer(9750, 9751, deps({ error: inUse(undefined) }).d);
    expect(starting).toMatchObject({ kind: 'failed', code: DATA_DIR_IN_USE });
    expect((starting as { holderPort?: number }).holderPort).toBeUndefined();
  });
  it('a quit during the check stops there', async () => {
    let quitting = false;
    const { d } = deps({ error: inUse(9850), running: { 9850: '0.3.0' }, cancelled: () => quitting });
    d.probe = async () => {
      quitting = true;
      return { version: '0.3.0' };
    };
    expect(await startOrAttachServer(9750, 9751, d)).toEqual({ kind: 'cancelled' });
  });
  it('the message says what happened and what to do, in both languages', () => {
    expect(STRINGS.en.dataDirInUse('~/.durbun', 9850)).toMatch(/Another Dürbün \(port 9850\) uses the data folder ~\/\.durbun.*Quit the other Dürbün.*Try Again.*DURBUN_DATA_DIR/);
    expect(STRINGS.en.dataDirInUse('~/.durbun')).toMatch(/^Another Dürbün is starting with the data folder ~\/\.durbun\./);
    expect(STRINGS.tr.dataDirInUse('~/.durbun', 9850)).toMatch(/Başka bir Dürbün \(port 9850\) ~\/\.durbun veri klasörünü kullanıyor.*Tekrar Dene.*DURBUN_DATA_DIR/);
    expect(STRINGS.tr.dataDirInUse('~/.durbun')).toContain('veri klasörüyle başlatılıyor');
  });
});
