/**
 * hello.sdk.layers (SPEC §10.6): which layers of the app feed one session. The Flutter plugin sends
 * ['dart'] plus 'android' / 'ios' when its native core is attached; the server keeps the known values once
 * each and passes them into AppSession.sdk (absent = unknown).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionExport } from '@durbun/protocol';
import { createSdkLayerWithTimings } from '../../src/sdk/layer';
import { parseHello } from '../../src/sdk/validate';
import type { Hub, SdkLayer } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { appInput, device, hello, makeHub, makeSettings, waitFor } from './helpers';

let hub: Hub | undefined;
let sdk: SdkLayer | undefined;

afterEach(async () => {
  await sdk?.close();
  hub?.dispose();
  sdk = undefined;
  hub = undefined;
});

const rawHello = (layers: unknown) => ({ ...hello(), sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter', layers } }) as unknown as Record<string, unknown>;

describe('hello.sdk.layers', () => {
  it('keeps the three known layers once each, in order; drops anything else', () => {
    expect(parseHello(rawHello(['dart', 'android']))?.sdk).toEqual({ name: 'durbun', version: '0.2.0', platform: 'flutter', layers: ['dart', 'android'] });
    expect(parseHello(rawHello(['ios', 'dart', 'ios', 'DART', 'native', 7, null, { x: 1 }]))?.sdk.layers).toEqual(['ios', 'dart']);
    // nothing usable = unknown (older SDKs): no layers key at all
    for (const v of [undefined, [], ['kotlin'], 'dart', { 0: 'dart' }]) {
      expect(parseHello(rawHello(v))?.sdk).not.toHaveProperty('layers');
    }
  });

  it('reaches AppSession.sdk through a real SDK connection, and the hub copies them', async () => {
    hub = makeHub();
    const h = hub;
    sdk = createSdkLayerWithTimings(
      { hub: h, logger: silentLogger, settings: () => makeSettings(), mocks: () => [], serverVersion: '0.1.0' },
      { helloTimeoutMs: 200, idleTimeoutMs: 5_000, pingIntervalMs: 1_000 },
    );
    h.upsertDevice(device('demo:1', { kind: 'virtual' }));
    const session = sdk.openVirtual({ transport: 'demo', deviceId: 'demo:1' });
    session.send(rawHello(['dart', 'android', 'android', 'web']) as never);
    const appId = await session.appId;
    await waitFor(() => h.getApp(appId));
    expect(h.getApp(appId)?.sdk).toEqual({ name: 'durbun', version: '0.2.0', platform: 'flutter', layers: ['dart', 'android'] });

    // in-process callers (VM module, demo) go through the same rule; the stored array is the hub's own
    const layers = ['dart', 'ios', 'ios', 'x'] as never as ('dart' | 'ios')[];
    const app = h.registerApp(appInput('demo:1', { sessionKey: 'other', sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter', layers } }));
    layers.push('android' as never);
    expect(h.getApp(app.id)?.sdk.layers).toEqual(['dart', 'ios']);
    // a reconnect with a hello without layers (older SDK build) drops them
    h.registerApp(appInput('demo:1', { sessionKey: 'other', sdk: { name: 'durbun', version: '0.1.0', platform: 'flutter' } }));
    expect(h.getApp(app.id)?.sdk).not.toHaveProperty('layers');
  });

  it('imported sessions keep their layers (sanitized)', () => {
    hub = makeHub();
    const h = hub;
    h.upsertDevice(device('android:R5CT1234'));
    const app = h.registerApp(appInput('android:R5CT1234', { sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter', layers: ['dart', 'android'] } }));
    const file: SessionExport = h.exportSession({ appId: app.id });
    expect(file.apps[0]?.sdk.layers).toEqual(['dart', 'android']);
    const broken = { ...file, apps: file.apps.map((a) => ({ ...a, sdk: { ...a.sdk, layers: ['android', 'swift', 'android'] } })) };
    const { deviceIds } = h.importSession(broken as unknown as SessionExport, 'pati');
    const imported = h.getApps().find((a) => a.deviceId === deviceIds[0]);
    expect(imported?.sdk.layers).toEqual(['android']);
  });
});
