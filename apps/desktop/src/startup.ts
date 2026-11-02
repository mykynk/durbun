/**
 * Start or attach (no Electron import, so it is unit-tested): plan the HTTP port, open a Dürbün that
 * already answers there, or start the embedded server. When the server's own listen() fails with
 * EADDRINUSE (ServerStartError.code) although the port looked free (a race, or a bind the check cannot
 * see), that port is avoided on the next attempt, so the plan moves on to 9760 / 9770 / 9780 / an
 * OS-assigned port instead of planning the same busy port again.
 */
import { planHttpPort, type PortDeps } from './ports';

export type StartOutcome<S> =
  | { kind: 'attached'; port: number; version: string }
  | { kind: 'started'; server: S; port: number; fallback: boolean }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string; code?: string };

export interface StartDeps<S> extends PortDeps {
  /** Start the server on this port (0 = OS-assigned); rejects with `code` 'EADDRINUSE' when it is taken. */
  start(port: number): Promise<S>;
  /** True once quit was requested: no further attempt is made. */
  cancelled(): boolean;
  onBusy?(port: number): void;
}

/** The preferred port, the three fixed fallbacks, the OS-assigned one, and one more for a race. */
export const MAX_START_ATTEMPTS = 6;

export async function startOrAttachServer<S>(preferred: number, sdkPort: number, deps: StartDeps<S>): Promise<StartOutcome<S>> {
  const avoid = new Set<number>();
  let lastError = '';
  for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
    const plan = await planHttpPort(preferred, sdkPort, deps, avoid);
    if (deps.cancelled()) return { kind: 'cancelled' };
    if (plan.kind === 'attach') return { kind: 'attached', port: plan.port, version: plan.version };
    try {
      return { kind: 'started', server: await deps.start(plan.port), port: plan.port, fallback: plan.fallback };
    } catch (err) {
      const e = err as (Error & { code?: unknown }) | undefined;
      const code = typeof e?.code === 'string' ? e.code : undefined;
      const message = e?.message ?? String(err);
      if (code !== 'EADDRINUSE') return { kind: 'failed', error: message, code };
      lastError = message;
      avoid.add(plan.port);
      deps.onBusy?.(plan.port);
    }
  }
  return { kind: 'failed', error: lastError || 'no free port', code: 'EADDRINUSE' };
}
