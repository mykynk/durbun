import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { deviceId: string; pid?: number; enabled: boolean }[] = [];
let resync: (() => void) | null = null;
let fail = false;

vi.mock('../../data', () => ({
  sendCommand: vi.fn((cmd: { name: string; deviceId: string; pid?: number; enabled: boolean }) => {
    sent.push({ deviceId: cmd.deviceId, pid: cmd.pid, enabled: cmd.enabled });
    return fail ? Promise.reject(Object.assign(new Error('nope'), { code: 'metrics.unsupported' })) : Promise.resolve(null);
  }),
  onResync: vi.fn((fn: () => void) => {
    resync = fn;
    return () => {};
  }),
}));

const { acquireWatch, activeWatchKeys, watchKey } = await import('./watch');

describe('metrics.watch registry', () => {
  beforeEach(() => {
    sent.length = 0;
    fail = false;
  });

  it('enables on first acquire and disables on last release (one watch per device+pid)', () => {
    const spec = { deviceId: 'demo:1', pid: 1043 };
    const r1 = acquireWatch(spec, () => {});
    const r2 = acquireWatch(spec, () => {});
    expect(sent).toEqual([{ deviceId: 'demo:1', pid: 1043, enabled: true }]);
    expect(activeWatchKeys()).toEqual([watchKey(spec)]);
    r1();
    r1(); // double release is a no-op
    expect(sent).toHaveLength(1);
    r2();
    expect(sent).toEqual([
      { deviceId: 'demo:1', pid: 1043, enabled: true },
      { deviceId: 'demo:1', pid: 1043, enabled: false },
    ]);
    expect(activeWatchKeys()).toEqual([]);
  });

  it('re-sends active watches after a resync (the server dropped them with the old connection)', () => {
    const release = acquireWatch({ deviceId: 'demo:2', pid: 231 }, () => {});
    sent.length = 0;
    resync?.();
    expect(sent).toEqual([{ deviceId: 'demo:2', pid: 231, enabled: true }]);
    release();
  });

  it('reports refusals to the caller', async () => {
    fail = true;
    const onError = vi.fn();
    const release = acquireWatch({ deviceId: 'import:1', pid: 5 }, onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as { code: string }).code).toBe('metrics.unsupported');
    release();
  });
});
