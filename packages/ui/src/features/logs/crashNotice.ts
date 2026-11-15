import type { LogEntry } from '@durbun/protocol';
import './i18n';
import { analyzeEntry } from './model/analyze';
import { crashTitle } from './components/Banners';

/**
 * Text of the desktop notification for a live crash (loaded on the first crash, so the shell does not carry the
 * log analysis code): "Kumbara çöktü" + "Pixel 8 · NullPointerException: …". The device is named because the
 * notification covers every connected device, not only the scoped one.
 */
export function crashNotice(e: LogEntry, appName: string | undefined, deviceName: string | undefined): { title: string; body: string } {
  const what = analyzeEntry(e).crash?.title ?? e.message.slice(0, 200);
  return { title: crashTitle(e, appName), body: deviceName ? `${deviceName} · ${what}` : what };
}
