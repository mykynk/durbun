import type { DeviceActionResult, DeviceRecording } from '@durbun/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { done, fail } from '../../src/platform/shared/files';
import { ScreenRecorder, type RecordingProcess } from '../../src/platform/shared/screenRecord';

/** A recording tool that writes its file once stopped, or `crash()`es on its own. */
function fakeTool() {
  let end!: (r: DeviceActionResult) => void;
  const ended = new Promise<DeviceActionResult>((resolve) => (end = resolve));
  const tool = {
    stops: 0,
    proc: {
      stop() {
        tool.stops += 1;
        end(done('Recording saved', 'action.recording.saved', { url: '/api/files/rec.mov', file: '/tmp/rec.mov' }));
      },
      result: (stopped: () => boolean) => ended.then((r) => (r.ok && !stopped() ? fail('ended on its own') : r)),
    } satisfies RecordingProcess,
    crash: (message: string) => end(fail(message)),
  };
  return tool;
}

function recorder() {
  const published: Array<DeviceRecording | undefined> = [];
  return { rec: new ScreenRecorder((r) => published.push(r)), published };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ScreenRecorder', () => {
  it('records until stopped; the stop reply is the same file', async () => {
    const { rec, published } = recorder();
    const tool = fakeTool();
    const running = rec.record({}, 600, () => tool.proc);
    await Promise.resolve();
    expect(published).toEqual([{ startedAt: expect.any(Number), limitSec: 600 }]);
    expect(rec.recording?.limitSec).toBe(600);

    const stopped = await rec.stop();
    expect(stopped).toEqual(await running);
    expect(stopped).toMatchObject({ ok: true, data: { url: '/api/files/rec.mov', file: '/tmp/rec.mov', endedBy: 'stop', durationSec: 1 } });
    expect(tool.stops).toBe(1);
    expect(published.at(-1)).toBeUndefined();
    expect(rec.recording).toBeUndefined();
  });

  it('allows one recording per device and says when none runs', async () => {
    const { rec } = recorder();
    expect(await rec.stop()).toMatchObject({ ok: false, code: 'action.recording.notRunning' });
    const running = rec.record({}, 600, () => fakeTool().proc);
    expect(await rec.record({}, 600, () => fakeTool().proc)).toMatchObject({ ok: false, code: 'action.recording.busy' });
    await rec.stop();
    await running;
    // Free again once the first one ended.
    const again = rec.record({}, 600, () => fakeTool().proc);
    await rec.stop();
    expect(await again).toMatchObject({ ok: true });
  });

  it('stops by itself at the limit or the requested duration', async () => {
    vi.useFakeTimers();
    const { rec, published } = recorder();
    const tool = fakeTool();
    const running = rec.record({ durationSec: 5 }, 180, () => tool.proc);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(tool.stops).toBe(0);
    expect(published[0]).toMatchObject({ limitSec: 5 });
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ ok: true, data: { endedBy: 'limit', durationSec: 5 } });
    expect(tool.stops).toBe(1);
  });

  it('rejects a duration beyond the platform limit', async () => {
    const { rec, published } = recorder();
    expect(await rec.record({ durationSec: 181 }, 180, () => fakeTool().proc)).toMatchObject({ ok: false, code: 'action.invalidParams' });
    expect(await rec.record({ durationSec: 0 }, 180, () => fakeTool().proc)).toMatchObject({ ok: false, code: 'action.invalidParams' });
    expect(published).toEqual([]);
  });

  it('reports a tool that fails on its own and frees the device', async () => {
    const { rec, published } = recorder();
    const tool = fakeTool();
    const running = rec.record({}, 600, () => tool.proc);
    await Promise.resolve();
    tool.crash('Screen recording failed: device locked');
    expect(await running).toMatchObject({ ok: false, error: 'Screen recording failed: device locked' });
    expect(published.at(-1)).toBeUndefined();
    expect(await rec.stop()).toMatchObject({ code: 'action.recording.notRunning' });
  });

  it('a stop pressed while the tool starts ends it as soon as it runs', async () => {
    const { rec } = recorder();
    const tool = fakeTool();
    let started!: (p: RecordingProcess) => void;
    const running = rec.record({}, 600, () => new Promise<RecordingProcess>((resolve) => (started = resolve)));
    const stopping = rec.stop();
    started(tool.proc);
    expect(await stopping).toMatchObject({ ok: true, data: { endedBy: 'stop' } });
    expect(await running).toMatchObject({ ok: true });
    expect(tool.stops).toBe(1);
  });

  it('a tool that cannot start fails the recording', async () => {
    const { rec, published } = recorder();
    const r = await rec.record({}, 600, () => {
      throw new Error('spawn xcrun ENOENT');
    });
    expect(r).toMatchObject({ ok: false, error: 'Screen recording failed: spawn xcrun ENOENT' });
    expect(published).toEqual([undefined]);
  });

  it('dispose stops a running recording without publishing', async () => {
    const { rec, published } = recorder();
    const tool = fakeTool();
    const running = rec.record({}, 600, () => tool.proc);
    await Promise.resolve();
    rec.dispose();
    expect(await running).toMatchObject({ ok: true });
    expect(published).toHaveLength(1);
    expect(await rec.record({}, 600, () => fakeTool().proc)).toMatchObject({ ok: false, code: 'action.deviceOffline' });
  });
});
