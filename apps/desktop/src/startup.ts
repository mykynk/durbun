/**
 * Start or attach (no Electron import, so it is unit-tested): plan the HTTP port, open a Dürbün that
 * already answers there, or start the embedded server. When the server's own listen() fails with
 * EADDRINUSE (ServerStartError.code) although the port looked free (a race, or a bind the check cannot
 * see), that port is avoided on the next attempt, so the plan moves on to 9760 / 9770 / 9780 / an
 * OS-assigned port instead of planning the same busy port again.
 *
 * The server also refuses to start on a data folder another Dürbün holds (code 'server.dataDirInUse', with
 * the holder's port when it listens): the app then opens that Dürbün, as it would one found on the port,
 * once it proves to be one. A holder that does not answer (or is still starting) is a failure that says so.
 */
import { originFor, planHttpPort, type DurbunPage, type PortDeps } from './ports';

/** `origin`: what the window loads, on the host the probe checked (ports.ts APP_HOST). */
export type StartOutcome<S> =
  /** `dataDirInUse`: found through the data folder lock, not on the planned port. */
  | { kind: 'attached'; port: number; version: string; page?: DurbunPage; origin: string; dataDirInUse?: boolean }
  | { kind: 'started'; server: S; port: number; fallback: boolean }
  | { kind: 'cancelled' }
  /** `holderPort`: with code 'server.dataDirInUse', the port of the Dürbün holding the data folder. */
  | { kind: 'failed'; error: string; code?: string; holderPort?: number };

/** packages/server/src/dataDirLock.ts DATA_DIR_IN_USE_CODE */
export const DATA_DIR_IN_USE = 'server.dataDirInUse';

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
    if (plan.kind === 'attach') return { kind: 'attached', port: plan.port, version: plan.version, page: plan.page, origin: originFor(plan.port) };
    try {
      return { kind: 'started', server: await deps.start(plan.port), port: plan.port, fallback: plan.fallback };
    } catch (err) {
      const e = err as (Error & { code?: unknown; port?: unknown }) | undefined;
      const code = typeof e?.code === 'string' ? e.code : undefined;
      const message = e?.message ?? String(err);
      if (code === DATA_DIR_IN_USE) {
        const holder = typeof e?.port === 'number' && Number.isInteger(e.port) && e.port > 0 && e.port <= 65_535 ? e.port : undefined;
        const proof = holder && !deps.cancelled() ? await deps.probe(holder).catch(() => undefined) : undefined;
        if (deps.cancelled()) return { kind: 'cancelled' };
        if (holder && proof) return { kind: 'attached', port: holder, version: proof.version, page: proof.page, origin: originFor(holder), dataDirInUse: true };
        return { kind: 'failed', error: message, code, holderPort: holder };
      }
      if (code !== 'EADDRINUSE') return { kind: 'failed', error: message, code };
      lastError = message;
      avoid.add(plan.port);
      deps.onBusy?.(plan.port);
    }
  }
  return { kind: 'failed', error: lastError || 'no free port', code: 'EADDRINUSE' };
}

/** The parts of the embedded server that tell where it listens (packages/server/src/server.ts). */
export interface ListeningServer {
  url: string;
  info?: { ports?: { http?: number } };
}

/**
 * Where the window finds the server this app started: its bound port (the real one when port 0 was
 * asked for) on APP_HOST, whatever host the server's own `url` names ("localhost").
 */
export function startedOrigin(server: ListeningServer, plannedPort: number): { port: number; origin: string } {
  let fromUrl = 0;
  try {
    fromUrl = Number(new URL(server.url).port) || 0;
  } catch {
    /* no usable url */
  }
  const port = server.info?.ports?.http || fromUrl || plannedPort;
  return { port, origin: originFor(port) };
}
