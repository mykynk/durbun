/**
 * Cross-tab navigation into the Device view ("Dart VM Service bağla" from the Performance empty state).
 * The Device view scrolls the section into view and focuses its first field.
 */
import { create } from 'zustand';
import { ui } from '../../data';

export type DeviceSection = 'vm' | 'apps' | 'processes' | 'screenshot' | 'open-url';

export interface DeviceSectionRequest {
  section: DeviceSection;
  seq: number;
}

export const useDeviceRequest = create<{ req: DeviceSectionRequest | null }>()(() => ({ req: null }));

let seq = 0;

export function requestDeviceSection(section: DeviceSection): void {
  useDeviceRequest.setState({ req: { section, seq: ++seq } });
  ui.setTab('device');
}

export function consumeDeviceRequest(reqSeq: number): void {
  if (useDeviceRequest.getState().req?.seq === reqSeq) useDeviceRequest.setState({ req: null });
}
