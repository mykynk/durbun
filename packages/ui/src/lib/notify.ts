import { getPrefs } from '../data/stores/prefs';

/** Whether desktop notifications can be shown right now. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Ask for permission (call from a user gesture, e.g. enabling the setting). */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Show a desktop notification when the user enabled `notifyOnCrash` and granted permission.
 * By default only when the window is not focused (the in-app banner covers the focused case).
 */
export function notifyDesktop(title: string, opts: { body?: string; tag?: string; force?: boolean; onClick?: () => void } = {}): boolean {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  if (!getPrefs().notifyOnCrash && !opts.force) return false;
  if (!opts.force && typeof document !== 'undefined' && document.hasFocus()) return false;
  try {
    const n = new Notification(title, { body: opts.body, tag: opts.tag, icon: '/icon.svg' });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
