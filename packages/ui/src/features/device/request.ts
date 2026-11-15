/**
 * Navigation into the Device view: from another tab ("Dart VM Service bağla" in the Performance empty state,
 * "tam cihaz raporu al" in Report a bug) and from the page's own jump strip.
 * The Device view scrolls the card into view and moves focus into it.
 */
import { create } from 'zustand';
import { ui } from '../../data';
import type { DeviceSectionId } from './model';

export type DeviceSection = DeviceSectionId;
/** Where focus lands: the card's first field (falls back to its heading), or always its heading. */
export type DeviceSectionFocus = 'field' | 'heading';

export interface DeviceSectionRequest {
  section: DeviceSection;
  focus: DeviceSectionFocus;
  seq: number;
}

export const useDeviceRequest = create<{ req: DeviceSectionRequest | null; flash: DeviceSection | null }>()(() => ({ req: null, flash: null }));

let seq = 0;

export function requestDeviceSection(section: DeviceSection, focus: DeviceSectionFocus = 'field'): void {
  useDeviceRequest.setState({ req: { section, focus, seq: ++seq } });
  ui.setTab('device');
}

export function consumeDeviceRequest(reqSeq: number): void {
  if (useDeviceRequest.getState().req?.seq === reqSeq) useDeviceRequest.setState({ req: null });
}

const FLASH_MS = 1400;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** Marks the card a jump landed on for a moment (two columns: the eye needs to find which one moved). */
export function flashDeviceSection(section: DeviceSection): void {
  clearTimeout(flashTimer);
  useDeviceRequest.setState({ flash: section });
  flashTimer = setTimeout(() => {
    if (useDeviceRequest.getState().flash === section) useDeviceRequest.setState({ flash: null });
  }, FLASH_MS);
}

/** Scrolls a card into view and moves focus into it: its first field, or its heading (made focusable for this). */
export function revealDeviceCard(card: HTMLElement, focus: DeviceSectionFocus): void {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  const field = focus === 'field' ? card.querySelector<HTMLElement>('textarea, input:not([type="checkbox"]):not([type="range"])') : null;
  const heading = field ? null : card.querySelector<HTMLElement>('.card__title');
  if (heading) heading.tabIndex = -1;
  (field ?? heading)?.focus({ preventScroll: true });
}
