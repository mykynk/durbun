/**
 * Platform drivers (SPEC §5.5): 'android' (adb), 'ios-sim' (xcrun simctl) and 'ios-device'
 * (usbmux + idevicesyslog + devicectl), plus PlatformServices.forwardToDevice.
 */
import type { Platform, PortForward } from '../types';
import { AndroidDriver } from './android/driver';
import { IosDeviceDriver, type IosDeviceDriverOptions } from './ios/deviceDriver';
import { IosSimDriver } from './ios/simDriver';

export interface CreatePlatformOptions {
  /** Override the usbmuxd socket (tests). */
  usbmuxSocketPath?: string;
}

export function createPlatform(opts: CreatePlatformOptions = {}): Platform {
  const android = new AndroidDriver();
  const sim = new IosSimDriver();
  const deviceOpts: IosDeviceDriverOptions = opts.usbmuxSocketPath ? { socketPath: opts.usbmuxSocketPath } : {};
  const device = new IosDeviceDriver(deviceOpts);
  return {
    drivers: [android, sim, device],
    services: {
      forwardToDevice(deviceId: string, devicePort: number): Promise<PortForward> {
        if (!Number.isInteger(devicePort) || devicePort <= 0 || devicePort > 65535) {
          return Promise.reject(new Error(`Invalid device port ${devicePort}`));
        }
        if (android.owns(deviceId)) return android.forward(deviceId, devicePort);
        if (sim.owns(deviceId)) return sim.forward(deviceId, devicePort);
        if (device.owns(deviceId)) return device.forward(deviceId, devicePort);
        return Promise.reject(new Error(`Port forwarding is not supported for device ${deviceId}`));
      },
    },
  };
}

export { AndroidDriver } from './android/driver';
export { IosSimDriver } from './ios/simDriver';
export { IosDeviceDriver } from './ios/deviceDriver';
