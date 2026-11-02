/**
 * Shows the UI's notifications (sent by the preload's Notification shim) as macOS notifications.
 * Clicking one brings the window to the front and fires the page's onclick. When macOS refuses
 * (Electron's notifications need a code-signed app; this build is unsigned/ad-hoc) the Dock icon
 * bounces and gets a badge instead, which clears when the window is focused.
 */
import { app, Notification, type WebContents } from 'electron';
import type { FileLog } from './log';

export interface NotifyRequest {
  id: string;
  title: string;
  body: string;
  tag: string;
  silent: boolean;
}

export type NotifyOutcome = 'shown' | 'failed' | 'unsupported' | 'fallback';

export interface Notifier {
  show(req: NotifyRequest, sender: WebContents): void;
  close(id: string): void;
  clearBadge(): void;
  /** Outcomes in order (self-test / diagnostics). */
  readonly outcomes: { id: string; outcome: NotifyOutcome; error?: string }[];
}

const MAX_LIVE = 20;

export function createNotifier(opts: { log: FileLog; onClick(): void; isFocused(): boolean }): Notifier {
  // Electron removes a notification when its object is garbage-collected: keep the recent ones.
  const live = new Map<string, Notification>();
  const outcomes: Notifier['outcomes'] = [];
  let warned = false;
  const record = (id: string, outcome: NotifyOutcome, error?: string) => {
    outcomes.push({ id, outcome, error });
    if (outcomes.length > 50) outcomes.shift();
  };

  const fallback = (id: string) => {
    record(id, 'fallback');
    if (opts.isFocused()) return;
    try {
      app.dock?.bounce('informational');
      app.dock?.setBadge('•');
    } catch {
      /* no dock */
    }
  };

  return {
    outcomes,
    show(req, sender) {
      if (!Notification.isSupported()) {
        record(req.id, 'unsupported');
        fallback(req.id);
        return;
      }
      try {
        const n = new Notification({ title: req.title || 'Dürbün', body: req.body, silent: req.silent });
        n.on('show', () => record(req.id, 'shown'));
        n.on('click', () => {
          live.delete(req.id);
          opts.onClick();
          if (!sender.isDestroyed()) sender.send('durbun:notification-click', req.id);
        });
        n.on('close', () => live.delete(req.id));
        n.on('failed', (_event, error) => {
          live.delete(req.id);
          record(req.id, 'failed', String(error));
          if (!warned) {
            warned = true;
            opts.log.warn(`macOS notification failed (${String(error)}); using the Dock badge instead`);
          }
          fallback(req.id);
        });
        live.set(req.id, n);
        while (live.size > MAX_LIVE) live.delete(live.keys().next().value!);
        n.show();
      } catch (err) {
        record(req.id, 'failed', (err as Error).message);
        fallback(req.id);
      }
    },
    close(id) {
      const n = live.get(id);
      live.delete(id);
      try {
        n?.close();
      } catch {
        /* already gone */
      }
    },
    clearBadge() {
      try {
        if (app.dock?.getBadge()) app.dock.setBadge('');
      } catch {
        /* no dock */
      }
    },
  };
}
