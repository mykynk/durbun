/** SDK-less reader states shared by the iOS device and simulator drivers (`DeviceInfo.readers`, SPEC §10.8). */
import type { DeviceReaderState } from '@durbun/protocol';

/** iOS has no outside source of frame timing (Android has gfxinfo / SurfaceFlinger). */
export const IOS_FRAME_STATS_UNSUPPORTED: DeviceReaderState = {
  status: 'unsupported',
  code: 'reader.frameStats.unsupported',
  detail: 'iOS does not give the frame timing of an app to the Mac; FPS is measured inside the app (SDK or Flutter debug).',
};

export const DEVICECTL_MISSING = {
  code: 'reader.crashReports.devicectlMissing',
  detail:
    'Xcode 15 or newer (xcrun devicectl) or idevicecrashreport (brew install libimobiledevice) is needed to read crash reports from iOS devices.',
} as const;

/** Crash reports are read with libimobiledevice's idevicecrashreport because devicectl cannot (status 'ok'). */
export const VIA_LIBIMOBILEDEVICE = {
  code: 'reader.crashReports.viaLibimobiledevice',
  detail:
    'Read with idevicecrashreport (libimobiledevice) because devicectl cannot read them on this iPhone; new reports show up within about 5 minutes.',
} as const;

/** A devicectl listing failed while the device reports Developer Mode off (the likely cause). */
export const DEVELOPER_MODE_OFF_CODE = 'reader.crashReports.developerModeOff';
export const READ_FAILED_CODE = 'reader.crashReports.failed';

/** A devicectl listing failed on an iPhone older than iOS 17 (CoreDevice, which devicectl uses, starts there). */
export const OS_TOO_OLD_CODE = 'reader.crashReports.osTooOld';

/** First iOS version devicectl (CoreDevice) works with. */
export const DEVICECTL_MIN_IOS = 17;

/** Major iOS version of "16.7.10" → 16 (undefined when unknown). */
export function iosMajor(osVersion: string | undefined): number | undefined {
  const n = Number(/^(\d+)/.exec(osVersion ?? '')?.[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** An iOS version devicectl is known not to work with. */
export function beforeDevicectl(osVersion: string | undefined): boolean {
  const major = iosMajor(osVersion);
  return major !== undefined && major < DEVICECTL_MIN_IOS;
}
