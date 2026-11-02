import type { ComponentType, SVGProps } from 'react';
import { Apple, Archive, FlaskConical, Monitor, Smartphone, Wifi } from 'lucide-react';
import type { DeviceInfo, SdkPlatform } from '@durbun/protocol';
import { clsx } from 'clsx';

/** Any lucide-react icon (or a compatible component). */
export type IconType = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number | string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

interface SvgIconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
}

/** Android robot head in lucide style (stroke icon, 24×24). */
export function AndroidIcon({ size = 16, className, strokeWidth, ...rest }: SvgIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx('lucide', className)}
      aria-hidden="true"
      {...rest}
    >
      <path d="M4 18a8 8 0 0 1 16 0Z" />
      <path d="m7.6 11.4-1.9-3.2" />
      <path d="m16.4 11.4 1.9-3.2" />
      <circle cx="9" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The Dürbün mark: minimal binoculars. `tile` renders it on a rounded brand-violet square. */
export function DurbunMark({ size = 20, tile = false, className }: { size?: number; tile?: boolean; className?: string }) {
  if (tile) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <g fill="var(--text-on-accent)">
          <rect x="8.6" y="6.2" width="4.4" height="4.6" rx="1.2" />
          <rect x="19" y="6.2" width="4.4" height="4.6" rx="1.2" />
          <path d="M7.4 12.6a2.4 2.4 0 0 1 2.4-2.4h2.4a2.4 2.4 0 0 1 2.4 2.4v4.6H7.4Z" />
          <path d="M17.4 12.6a2.4 2.4 0 0 1 2.4-2.4h2.4a2.4 2.4 0 0 1 2.4 2.4v4.6h-7.2Z" />
          <rect x="13.6" y="12.6" width="4.8" height="3.6" rx="1" />
          <circle cx="11" cy="20.4" r="5.4" />
          <circle cx="21" cy="20.4" r="5.4" />
        </g>
        <circle cx="11" cy="20.4" r="2.9" fill="var(--accent)" />
        <circle cx="21" cy="20.4" r="2.9" fill="var(--accent)" />
        <circle cx="10" cy="19.3" r="0.9" fill="var(--text-on-accent)" opacity="0.85" />
        <circle cx="20" cy="19.3" r="0.9" fill="var(--text-on-accent)" opacity="0.85" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <g fill="currentColor">
        <rect x="8.6" y="4.2" width="4.4" height="4.6" rx="1.2" />
        <rect x="19" y="4.2" width="4.4" height="4.6" rx="1.2" />
        <path d="M7.2 10.8a2.6 2.6 0 0 1 2.6-2.6h2.6a2.6 2.6 0 0 1 2.6 2.6v5.4H7.2Z" />
        <path d="M17 10.8a2.6 2.6 0 0 1 2.6-2.6h2.6a2.6 2.6 0 0 1 2.6 2.6v5.4H17Z" />
        <rect x="13.6" y="10.8" width="4.8" height="3.8" rx="1" />
        <path
          fillRule="evenodd"
          d="M11 14.2a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4Zm0 3a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4ZM21 14.2a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4Zm0 3a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z"
        />
      </g>
    </svg>
  );
}

/** Icon for a device: platform (Android robot / Apple), demo, imported or desktop. */
export function PlatformIcon({ device, size = 16, className }: { device: Pick<DeviceInfo, 'id' | 'platform' | 'connection'>; size?: number; className?: string }) {
  const id = device.id;
  if (id.startsWith('demo:')) return <FlaskConical size={size} className={className} aria-hidden />;
  if (id.startsWith('import:')) return <Archive size={size} className={className} aria-hidden />;
  if (id === 'desktop') return <Monitor size={size} className={className} aria-hidden />;
  if (device.platform === 'android') return <AndroidIcon size={size} className={className} />;
  if (device.platform === 'ios') return <Apple size={size} className={className} aria-hidden />;
  if (id.startsWith('net:')) return <Wifi size={size} className={className} aria-hidden />;
  return <Smartphone size={size} className={className} aria-hidden />;
}

const SDK_LABELS: Record<SdkPlatform, string> = {
  flutter: 'Flutter',
  android: 'Android',
  ios: 'iOS',
  'react-native': 'React Native',
  js: 'JS',
  'dart-vm': 'Dart VM',
  demo: 'Demo',
};

const SDK_SHORT: Record<SdkPlatform, string> = {
  flutter: 'Flutter',
  android: 'Kotlin',
  ios: 'Swift',
  'react-native': 'RN',
  js: 'JS',
  'dart-vm': 'VM',
  demo: 'Demo',
};

export function sdkLabel(platform: SdkPlatform): string {
  return SDK_LABELS[platform] ?? platform;
}

/** Small colored badge for an SDK platform ("Flutter", "RN", "VM"…). */
export function SdkBadge({ platform, short = true, className }: { platform: SdkPlatform; short?: boolean; className?: string }) {
  return (
    <span className={clsx('sdk-badge', `sdk-badge--${platform}`, className)} title={SDK_LABELS[platform]}>
      {short ? SDK_SHORT[platform] ?? platform : SDK_LABELS[platform] ?? platform}
    </span>
  );
}
