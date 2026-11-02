import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { DeviceActionId } from '@durbun/protocol';
import { sendCommand } from '../../data';
import { Callout, Card, IconButton, toast, type IconType } from '../../components';
import { useT } from '../../i18n';
import { describeError } from './codes';

export interface ActionError {
  title: string;
  text: string;
  detail?: string;
}

export interface RunOptions {
  /** Pending key (default: the action id) — lets one card run several buttons independently. */
  key?: string;
  action: DeviceActionId;
  params?: Record<string, unknown>;
  /** Success toast (null/undefined → none). A function receives the reply data. */
  success?: string | null | ((data: unknown) => string | null);
  /** Failure toast title (+ inline error). */
  failure: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RunResult = { ok: true; data: unknown } | { ok: false; error: unknown };

/**
 * Runs `device.action` commands for one device with per-key pending state, a localized success toast and,
 * on failure, an error toast plus an inline error the card shows until the next attempt.
 */
export function useDeviceAction(deviceId: string) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<ActionError | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (opts: RunOptions): Promise<RunResult> => {
      const key = opts.key ?? opts.action;
      setPending((s) => new Set(s).add(key));
      setError(null);
      try {
        const data = await sendCommand(
          { name: 'device.action', deviceId, action: opts.action, params: opts.params ?? {} },
          { timeoutMs: opts.timeoutMs, signal: opts.signal },
        );
        const msg = typeof opts.success === 'function' ? opts.success(data) : opts.success;
        if (msg) toast.success(msg);
        return { ok: true, data };
      } catch (err) {
        const d = describeError(err);
        if (d.code !== 'command.aborted') {
          toast.error(opts.failure, { description: d.text });
          if (mounted.current) setError({ title: opts.failure, text: d.text, detail: d.detail });
        }
        return { ok: false, error: err };
      } finally {
        if (mounted.current)
          setPending((s) => {
            const next = new Set(s);
            next.delete(key);
            return next;
          });
      }
    },
    [deviceId],
  );

  return {
    run,
    pending,
    isPending: (key: string) => pending.has(key),
    busy: pending.size > 0,
    error,
    setError,
    clearError: () => setError(null),
  };
}

/** Inline error of the last failed action (dismissible). */
export function ActionErrorCallout({ error, onDismiss }: { error: ActionError | null; onDismiss: () => void }) {
  const t = useT();
  if (!error) return null;
  return (
    <Callout tone="danger" compact title={error.title} className="dv-error" actions={<IconButton icon={X} size="xs" label={t('common.close')} onClick={onDismiss} />}>
      {error.text}
      {error.detail ? <span className="dv-error__detail mono">{error.detail}</span> : null}
    </Callout>
  );
}

/** A card of the device page; `section` makes it a scroll/focus target for cross-tab requests. */
export function DeviceCard({
  section,
  title,
  icon,
  description,
  actions,
  children,
  className,
}: {
  section: string;
  title: ReactNode;
  icon: IconType;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `dv-card ${className}` : 'dv-card'} data-section={section}>
      <Card title={title} icon={icon} description={description} actions={actions}>
        {children}
      </Card>
    </div>
  );
}
