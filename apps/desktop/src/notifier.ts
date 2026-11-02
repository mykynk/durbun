/**
 * Shows the UI's notifications (sent by the preload's Notification shim) as macOS notifications.
 * Clicking one brings the window to the front and fires the page's onclick. As with the web API, a
 * notification replaces the previous one with the same tag (the UI tags crash alerts 'durbun-crash'),
 * so a crash loop does not pile up in Notification Center. When macOS refuses
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
  const byTag = new Map<string, string>(); // tag → id of the notification showing it
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

  const forget = (id: string) => {
    live.delete(id);
    for (const [tag, owner] of byTag) if (owner === id) byTag.delete(tag);
  };
  const close = (id: string) => {
    const n = live.get(id);
    forget(id);
    try {
      n?.close();
    } catch {
      /* already gone */
    }
  };

  return {
    outcomes,
    show(req, sender) {
      if (req.tag) {
        const previous = byTag.get(req.tag);
        if (previous) close(previous);
        byTag.set(req.tag, req.id);
      }
      if (!Notification.isSupported()) {
        record(req.id, 'unsupported');
        fallback(req.id);
        return;
      }
      try {
        const n = new Notification({ title: req.title || 'Dürbün', body: req.body, silent: req.silent });
        n.on('show', () => record(req.id, 'shown'));
        n.on('click', () => {
          forget(req.id);
          opts.onClick();
          if (!sender.isDestroyed()) sender.send('durbun:notification-click', req.id);
        });
        n.on('close', () => forget(req.id));
        n.on('failed', (_event, error) => {
          forget(req.id);
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
    close,
    clearBadge() {
      try {
        if (app.dock?.getBadge()) app.dock.setBadge('');
      } catch {
        /* no dock */
      }
    },
  };
}
