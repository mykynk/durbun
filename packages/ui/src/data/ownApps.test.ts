import { describe, expect, it } from 'vitest';
import type { AppSession, DeviceApp } from '@durbun/protocol';
import { bundlePrefix, isDeveloperInstall, isOwnApp, ownAppIndex } from './ownApps';

/* A tester's iPhone and Pixel as the drivers report them: the team's builds next to everyday store apps. */
const da = (id: string, source: DeviceApp['install']['source'], installer?: string): Pick<DeviceApp, 'id' | 'install'> => ({ id, install: { source, installer } });
const session = (id: string): Pick<AppSession, 'app'> => ({ app: { name: id, id } });

describe('own apps (build advice only for the team’s apps)', () => {
  it('reverse-domain prefix: the first two labels, lower case', () => {
    expect(bundlePrefix('com.mykynk.kumbara')).toBe('com.mykynk');
    expect(bundlePrefix('net.whatsapp.WhatsApp')).toBe('net.whatsapp');
    expect(bundlePrefix('com.Mykynk.pati.qa')).toBe('com.mykynk');
    expect(bundlePrefix('Runner')).toBeUndefined();
    expect(bundlePrefix('.weird')).toBeUndefined();
  });

  it('developer / internal installs count, store installs do not', () => {
    expect(isDeveloperInstall(da('a', 'xcode'))).toBe(true);
    expect(isDeveloperInstall(da('a', 'adb'))).toBe(true);
    expect(isDeveloperInstall(da('a', 'simulator'))).toBe(true);
    expect(isDeveloperInstall(da('a', 'firebase', 'dev.firebase.appdistribution'))).toBe(true);
    expect(isDeveloperInstall(da('a', 'other-store', 'com.google.android.packageinstaller'))).toBe(true); // APK by hand
    expect(isDeveloperInstall(da('a', 'play', 'com.android.vending'))).toBe(false);
    expect(isDeveloperInstall(da('a', 'store-or-testflight'))).toBe(false);
    expect(isDeveloperInstall(da('a', 'other-store', 'com.sec.android.app.samsungapps'))).toBe(false);
    expect(isDeveloperInstall(da('a', 'unknown'))).toBe(false);
  });

  it('a TestFlight build shares the prefix of a debug build; WhatsApp and Instagram stay "other"', () => {
    const index = ownAppIndex(
      [session('com.mykynk.mahalle')],
      [
        da('com.mykynk.pati', 'xcode'),
        da('com.mykynk.kumbara', 'store-or-testflight'),
        da('net.whatsapp.WhatsApp', 'store-or-testflight'),
        da('com.burbn.instagram', 'store-or-testflight'),
        da('com.example.tasarruf', 'play', 'com.android.vending'),
      ],
    );
    expect(isOwnApp('com.mykynk.kumbara', index)).toBe(true); // prefix of Pati (Xcode)
    expect(isOwnApp('com.mykynk.mahalle', index)).toBe(true); // had an SDK session
    expect(isOwnApp('com.mykynk.pati', index)).toBe(true); // developer install
    expect(isOwnApp('net.whatsapp.WhatsApp', index)).toBe(false);
    expect(isOwnApp('com.burbn.instagram', index)).toBe(false);
    expect(isOwnApp('com.example.tasarruf', index)).toBe(false); // a Play install alone proves nothing
    // …until a debug build of the same project shows up on any device.
    const later = ownAppIndex([session('com.example.tasarruf.dev')], []);
    expect(isOwnApp('com.example.tasarruf', later)).toBe(true);
  });
});
