/**
 * DeviceInfo.readers (SDK-less readers: crash reports, frame stats): the hub merges them per reader id on
 * upsertDevice and patchDevice, so a driver that reports one reader never erases another one's state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceInfo, SessionExport } from '@durbun/protocol';
import type { Hub } from '../../src/types';
import { collectChanges, device, makeHub, sleep } from './helpers';

const PIXEL = 'android:R5CT1234';
let hub: Hub | undefined;

afterEach(() => {
  hub?.dispose();
  hub = undefined;
});

const readers = (h: Hub, id = PIXEL) => h.getDevice(id)?.readers;

describe('DeviceInfo.readers merge', () => {
  it('a patch that sets crashReports keeps frameStats; upsertDevice merges the same way', () => {
    const h = (hub = makeHub());
    h.upsertDevice(device(PIXEL, { readers: { crashReports: { status: 'ok', lastOk: 1000 }, frameStats: { status: 'ok', lastOk: 1000 } } }));
    h.patchDevice(PIXEL, { readers: { crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'dumpsys dropbox: Permission Denial' } } });
    expect(readers(h)).toEqual({
      // lastOk is the last successful read: it stays until a newer one is reported
      crashReports: { status: 'unavailable', code: 'reader.crashReports.dropboxRefused', detail: 'dumpsys dropbox: Permission Denial', lastOk: 1000 },
      frameStats: { status: 'ok', lastOk: 1000 },
    });

    // a full re-report without readers (the driver's periodic device refresh) keeps them
    h.upsertDevice(device(PIXEL, { battery: { level: 80, charging: false } }));
    expect(readers(h)?.frameStats).toEqual({ status: 'ok', lastOk: 1000 });

    // upsertDevice with one reader: that reader is replaced, code / detail of the old state do not stick
    h.upsertDevice(device(PIXEL, { readers: { crashReports: { status: 'ok', lastOk: 5000 } } }));
    expect(readers(h)).toEqual({ crashReports: { status: 'ok', lastOk: 5000 }, frameStats: { status: 'ok', lastOk: 1000 } });

    // explicitly undefined / null removes one reader; an empty object or readers: undefined changes nothing
    h.patchDevice(PIXEL, { readers: { frameStats: undefined } });
    expect(readers(h)).toEqual({ crashReports: { status: 'ok', lastOk: 5000 } });
    h.patchDevice(PIXEL, { readers: {} });
    h.patchDevice(PIXEL, { readers: undefined });
    h.patchDevice(PIXEL, { battery: { level: 79, charging: false } });
    expect(readers(h)).toEqual({ crashReports: { status: 'ok', lastOk: 5000 } });
    h.patchDevice(PIXEL, { readers: { crashReports: null } } as unknown as Partial<DeviceInfo>);
    expect(h.getDevice(PIXEL)).not.toHaveProperty('readers');
  });

  it('ignores invalid states and reader ids, keeps the previous state, and copies what it stores', () => {
    const h = (hub = makeHub());
    const frame = { status: 'unsupported' as const, code: 'reader.frameStats.unsupported' };
    h.upsertDevice(device(PIXEL, { readers: { frameStats: frame } }));
    frame.status = 'ok' as never; // the driver mutating its own object later changes nothing in the hub
    // (JSON.parse, like an imported file, makes "__proto__" an own key)
    const patch = JSON.parse('{"frameStats":{"status":"broken","code":"x"},"crashReports":"ok","__proto__":{"status":"ok"},"bad id":{"status":"ok"}}');
    h.patchDevice(PIXEL, { readers: patch as DeviceInfo['readers'] });
    expect(readers(h)).toEqual({ frameStats: { status: 'unsupported', code: 'reader.frameStats.unsupported' } });
    expect(Object.getPrototypeOf(readers(h))).toBe(Object.prototype);
  });

  it('a readers patch goes out as a device change; imports keep what could be read when the session was recorded', async () => {
    const h = (hub = makeHub());
    h.upsertDevice(device(PIXEL));
    await sleep(120);
    const c = collectChanges(h);
    h.patchDevice(PIXEL, { readers: { frameStats: { status: 'unavailable', code: 'reader.frameStats.noData', detail: 'No frames for com.mykynk.kumbara' } } });
    await sleep(120);
    expect(c.all().devices.at(-1)?.readers).toEqual({ frameStats: { status: 'unavailable', code: 'reader.frameStats.noData', detail: 'No frames for com.mykynk.kumbara' } });
    c.stop();

    const file: SessionExport = h.exportSession();
    expect(file.devices.find((d) => d.id === PIXEL)?.readers?.frameStats?.status).toBe('unavailable');
    const { deviceIds } = h.importSession(
      { ...file, devices: file.devices.map((d) => ({ ...d, readers: { ...d.readers, crashReports: { status: 'nope' } } })) } as unknown as SessionExport,
      'pixel',
    );
    const imported = h.getDevice(deviceIds[0]!);
    expect(imported?.readers).toEqual({ frameStats: { status: 'unavailable', code: 'reader.frameStats.noData', detail: 'No frames for com.mykynk.kumbara' } });
  });
});
