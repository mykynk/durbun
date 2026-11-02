import { afterEach, describe, expect, it } from 'vitest';
import type { ServerToSdk } from '@durbun/protocol';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import type { Hub, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { device, hello, makeHub, makeSettings, sleep, waitFor } from './helpers';

let hub: Hub;
let sdk: SdkLayer;

function setup() {
  hub = makeHub();
  sdk = createSdkLayerWithTimings(
    { hub, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.1.0' },
    { helloTimeoutMs: 50, idleTimeoutMs: 80, pingIntervalMs: 20 },
  );
}

afterEach(async () => {
  await sdk?.close();
  hub?.dispose();
});

describe('virtual SDK sessions', () => {
  it('handshake resolves appId; messages flow through the same handling path', async () => {
    setup();
    hub.upsertDevice(device('demo:1', { kind: 'virtual', name: 'Pixel 8 · Demo' }));
    const session = sdk.openVirtual({ transport: 'demo', deviceId: 'demo:1' });
    const received: ServerToSdk[] = [];
    session.onMessage((m) => received.push(m));
    session.send({ type: 'log', ts: 1, level: 'info', message: 'before hello is ignored' });
    session.send(hello({ sdk: { name: 'durbun-demo', version: '0.1.0', platform: 'flutter' }, session: 'demo-1' }));
    const appId = await session.appId;
    await waitFor(() => received.find((m) => m.type === 'welcome'));
    expect(hub.getApp(appId)).toMatchObject({ deviceId: 'demo:1', transport: 'demo' });
    session.send({ type: 'metric', ts: 2, cpu: 10, fps: 60 });
    session.send({ type: 'log', ts: 3, level: 'debug', message: 'after hello' });
    expect(hub.getMetrics()[0]).toMatchObject({ source: 'demo', appId });
    expect(hub.getLogs().filter((l) => l.source === 'app').map((l) => l.message)).toEqual(['after hello']);
    // garbage is ignored without throwing
    expect(() => session.send({ type: 'net.request' } as never)).not.toThrow();
    // virtual sessions are never closed by hello/idle timers
    await sleep(150);
    expect(session.closed).toBe(false);
    expect(received.some((m) => m.type === 'ping')).toBe(false);
  });

  it('answers commands and closes cleanly', async () => {
    setup();
    const session = sdk.openVirtual({ transport: 'vm-service', deviceId: 'ios-sim:ABCD-1234' });
    session.onMessage((m) => {
      if (m.type === 'command') session.send({ type: 'command.result', id: m.id, ok: true, data: { echoed: m.name } });
    });
    session.send(hello({ device: { platform: 'ios', model: 'iPhone17,1', isPhysical: false }, sdk: { name: 'durbun-vm', version: '0.1.0', platform: 'dart-vm' } }));
    const appId = await session.appId;
    expect(hub.getDevice('ios-sim:ABCD-1234')).toMatchObject({ platform: 'ios', kind: 'simulator' });
    await expect(sdk.sendCommand(appId, 'flutter.dumpWidgetTree')).resolves.toEqual({ ok: true, data: { echoed: 'flutter.dumpWidgetTree' } });
    session.send({ type: 'metric', ts: 1, heapMB: 40 });
    expect(hub.getMetrics()[0]!.source).toBe('vm-service');
    session.close();
    expect(session.closed).toBe(true);
    expect(hub.getApp(appId)!.connected).toBe(false);
    session.send({ type: 'log', ts: 2, level: 'info', message: 'after close' });
    expect(hub.getLogs().some((l) => l.message === 'after close')).toBe(false);
  });

  it('rejects appId when closed before the handshake, without unhandled rejections', async () => {
    setup();
    const s1 = sdk.openVirtual({ transport: 'demo' });
    s1.close('gave up');
    await expect(s1.appId).rejects.toThrow(/before welcome/);
    const s2 = sdk.openVirtual({ transport: 'demo' });
    s2.close(); // nobody awaits s2.appId: must not surface as an unhandled rejection
    const s3 = sdk.openVirtual({ transport: 'demo' });
    s3.send({ type: 'hello' } as never); // invalid hello (no app) is ignored
    expect(s3.closed).toBe(false);
    s3.close();
  });

  it('resolves devices by simulator UDID and by unambiguous model match', async () => {
    setup();
    hub.upsertDevice(device('android:emulator-5554', { kind: 'emulator', model: 'sdk_gphone64_arm64', name: 'Pixel 8 API 35' }));
    hub.upsertDevice(device('android:R5CT', { model: 'SM-S921B', name: 'Galaxy S24' }));
    const a = sdk.openVirtual({ transport: 'tcp' });
    a.send(hello({ device: { platform: 'android', model: 'sdk_gphone64_arm64', isPhysical: false }, session: 'emu' }));
    expect(hub.getApp(await a.appId)!.deviceId).toBe('android:emulator-5554');
    const b = sdk.openVirtual({ transport: 'tcp' });
    b.send(hello({ device: { platform: 'android', model: 'Pixel 7', name: 'Yusuf’un Pixel’i', isPhysical: true }, session: 'lan' }));
    expect(hub.getApp(await b.appId)!.deviceId).toBe('net:android-pixel-7-yusuf-un-pixel-i');
    const c = sdk.openVirtual({ transport: 'tcp' });
    c.send(hello({ device: { platform: 'ios', simulatorUdid: '7F1E2D3C-AAAA-BBBB-CCCC-000011112222', model: 'iPhone17,1' }, session: 'sim' }));
    expect(hub.getApp(await c.appId)!.deviceId).toBe('ios-sim:7F1E2D3C-AAAA-BBBB-CCCC-000011112222');
  });
});
