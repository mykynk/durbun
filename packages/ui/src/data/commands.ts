import type { LogEntry, MockRule, NetworkEntry, ServerSettings, ServerToUi, ToolCheck, UiCommand, UiToServer } from '@durbun/protocol';

/** Reply `data` per command (SPEC / protocol `UiCommand` docs). */
export interface CommandReplyMap {
  clear: null;
  'marker.add': LogEntry;
  'device.action': unknown;
  'app.action': unknown;
  'mocks.set': MockRule[];
  'settings.update': ServerSettings;
  'vm.attach': { appId: string };
  'vm.detach': null;
  'metrics.watch': null;
  'net.replay': NetworkEntry;
  'demo.set': { enabled: boolean };
  'doctor.run': ToolCheck[];
}

export type CommandName = UiCommand['name'];
export type CommandReply<C extends UiCommand> = CommandReplyMap[C['name']];

/** Rejection of `sendCommand`: server error (`code` from the reply), timeout or disconnect. */
export class CommandError extends Error {
  readonly code?: string;
  readonly command: CommandName;
  readonly data?: unknown;
  constructor(command: CommandName, message: string, code?: string, data?: unknown) {
    super(message);
    this.name = 'CommandError';
    this.command = command;
    this.code = code;
    this.data = data;
  }
}

/** Codes produced locally (not by the server). */
export const LOCAL_ERROR_CODES = {
  timeout: 'command.timeout',
  disconnected: 'command.disconnected',
  aborted: 'command.aborted',
} as const;

export interface CommandTransport {
  isOpen(): boolean;
  send(message: UiToServer): boolean;
}

export interface SendCommandOptions {
  /** Overrides the per-command default timeout (ms). Includes time spent waiting for a connection. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  command: UiCommand;
  resolve: (data: unknown, code?: string) => void;
  reject: (err: CommandError) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  cleanup: () => void;
}

let transport: CommandTransport | null = null;
const pending = new Map<string, Pending>();
let seq = 0;

export function setCommandTransport(t: CommandTransport | null): void {
  transport = t;
}

export function defaultCommandTimeout(cmd: UiCommand): number {
  switch (cmd.name) {
    case 'device.action': {
      if (cmd.action === 'app-install') return 300_000;
      if (cmd.action === 'screen-record') return ((Number(cmd.params?.durationSec) || 30) + 60) * 1000;
      if (cmd.action === 'list-apps' || cmd.action === 'screenshot' || cmd.action === 'app-uninstall') return 60_000;
      return 30_000;
    }
    case 'net.replay':
      return 40_000;
    case 'vm.attach':
    case 'doctor.run':
      return 30_000;
    default:
      return 15_000;
  }
}

function newRequestId(): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `r${Date.now().toString(36)}${seq.toString(36)}`;
}

function trySend(requestId: string, p: Pending): void {
  if (p.sent || !transport || !transport.isOpen()) return;
  const ok = transport.send({ type: 'command', requestId, command: p.command });
  if (ok) p.sent = true;
}

/**
 * Send a command over WS /ui and resolve with the reply's `data`. Rejects with `CommandError`
 * (`code` = server code, or `command.timeout` / `command.disconnected` / `command.aborted`).
 * When the socket is not connected yet, the command waits (within its timeout) and is sent on connect.
 */
export function sendCommand<C extends UiCommand>(command: C, opts: SendCommandOptions = {}): Promise<CommandReply<C>> {
  return sendCommandDetailed(command, opts).then((r) => r.data);
}

/** Successful reply of `sendCommandDetailed`: the data plus the reply's i18n `code`, when the server sent one. */
export interface DetailedReply<D> {
  data: D;
  /** e.g. `device.action` → `DeviceActionResult.code` ('action.screenshot.saved', 'action.done', …). */
  code?: string;
}

/**
 * Like `sendCommand`, but also resolves with the reply's `code` (a successful `device.action` forwards
 * `DeviceActionResult.code`, useful for a localized success toast via `tCode(code, data, fallback)`).
 */
export function sendCommandDetailed<C extends UiCommand>(command: C, opts: SendCommandOptions = {}): Promise<DetailedReply<CommandReply<C>>> {
  return new Promise<DetailedReply<CommandReply<C>>>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CommandError(command.name, 'Aborted', LOCAL_ERROR_CODES.aborted));
      return;
    }
    const requestId = newRequestId();
    const timeoutMs = opts.timeoutMs ?? defaultCommandTimeout(command);
    const onAbort = () => finish(new CommandError(command.name, 'Aborted', LOCAL_ERROR_CODES.aborted));
    const finish = (err: CommandError | null, data?: unknown) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      p.cleanup();
      if (err) p.reject(err);
      else p.resolve(data);
    };
    const p: Pending = {
      command,
      resolve: (data, code) => resolve(code ? { data: data as CommandReply<C>, code } : { data: data as CommandReply<C> }),
      reject,
      sent: false,
      timer: setTimeout(
        () => finish(new CommandError(command.name, `No reply within ${Math.round(timeoutMs / 1000)} s`, LOCAL_ERROR_CODES.timeout)),
        timeoutMs,
      ),
      cleanup: () => {
        clearTimeout(p.timer);
        opts.signal?.removeEventListener('abort', onAbort);
      },
    };
    opts.signal?.addEventListener('abort', onAbort);
    pending.set(requestId, p);
    trySend(requestId, p);
  });
}

/** Called by the WS client once the connection is usable: sends queued commands. */
export function flushPendingCommands(): void {
  for (const [id, p] of pending) trySend(id, p);
}

/** Called by the WS client when the socket closes: in-flight commands can no longer get a reply. */
export function failInFlightCommands(): void {
  for (const [id, p] of [...pending]) {
    if (!p.sent) continue; // still queued → will be sent after reconnect
    pending.delete(id);
    p.cleanup();
    p.reject(new CommandError(p.command.name, 'Connection to Dürbün was lost', LOCAL_ERROR_CODES.disconnected));
  }
}

/** Route a `reply` message to its pending promise. Returns false when the request is unknown. */
export function handleReply(msg: Extract<ServerToUi, { type: 'reply' }>): boolean {
  const p = pending.get(msg.requestId);
  if (!p) return false;
  pending.delete(msg.requestId);
  p.cleanup();
  if (msg.ok) p.resolve(msg.data ?? null, typeof msg.code === 'string' && msg.code ? msg.code : undefined);
  else p.reject(new CommandError(p.command.name, msg.error || 'Command failed', msg.code, msg.data));
  return true;
}

export function pendingCommandCount(): number {
  return pending.size;
}

/** Test helper. */
export function __resetCommandsForTests(): void {
  for (const p of pending.values()) p.cleanup();
  pending.clear();
  transport = null;
}
