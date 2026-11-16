import { describe, expect, it } from 'vitest';
import type { AppSession } from '@durbun/protocol';
import { guideSession } from './SdkGuide';

const app = (id: string, platform: AppSession['sdk']['platform'], connectedAt: number, extra: Partial<AppSession> = {}): AppSession =>
  ({
    id,
    sessionKey: id,
    deviceId: 'pixel',
    sdk: { platform, version: '0.3.0' },
    app: { id: `com.example.${id}`, name: id, version: '1.0' },
    transport: 'adb-reverse',
    connected: true,
    connectedAt,
    capabilities: [],
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
    ...extra,
  }) as AppSession;

describe('SDK guide connection watch', () => {
  it('finds the newest app of the tab’s platform and says whether it came after the guide opened', () => {
    const apps = { a: app('a', 'flutter', 100), b: app('b', 'flutter', 300), c: app('c', 'android', 400) };
    expect(guideSession(apps, 'flutter', 200)).toMatchObject({ session: { id: 'b' }, fresh: true });
    expect(guideSession(apps, 'flutter', 500)).toMatchObject({ session: { id: 'b' }, fresh: false });
    expect(guideSession(apps, 'ios', 0)).toBeNull();
  });
  it('ignores disconnected, demo, imported and VM Service sessions; React Native counts the JS SDK', () => {
    const apps = {
      a: app('a', 'android', 100, { connected: false }),
      b: app('b', 'android', 100, { transport: 'demo' }),
      c: app('c', 'android', 100, { transport: 'vm-service' }),
      d: app('d', 'js', 100),
    };
    expect(guideSession(apps, 'android', 0)).toBeNull();
    expect(guideSession(apps, 'react-native', 0)?.session.id).toBe('d');
  });
});
