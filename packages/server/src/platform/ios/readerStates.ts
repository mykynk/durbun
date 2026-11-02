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
  detail: 'Xcode 15 or newer (xcrun devicectl) is needed to read crash reports from iOS devices.',
} as const;

/** A devicectl listing failed while the device reports Developer Mode off (the likely cause). */
export const DEVELOPER_MODE_OFF_CODE = 'reader.crashReports.developerModeOff';
export const READ_FAILED_CODE = 'reader.crashReports.failed';
