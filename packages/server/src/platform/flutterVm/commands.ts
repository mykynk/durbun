/**
 * Flutter app actions of one VM session: advertises the available actions with their current values
 * (`hello.actions` / `{type:'actions'}`), keeps them in sync with changes made elsewhere (DevTools, IDE)
 * and executes `command` messages through the matching `ext.flutter.*` service extension.
 */
import type { AppActionDescriptor, SdkToServer } from '@durbun/protocol';
import type { Logger } from '../../types';
import {
  ACTIONS_BY_ID,
  availableActions,
  buildActionDescriptors,
  resolveRequestedValue,
  valueFromResponse,
  valueFromStateChange,
  writeParams,
  type ActionValue,
  type ValueContext,
} from './actions';
import type { AppLog } from './logRecord';

/** Below the SDK layer's 10 s command timeout so the UI gets our error instead of a generic timeout. */
export const COMMAND_TIMEOUT_MS = 9_000;
const MAX_DUMP_CHARS = 256 * 1024;
/** State-change events within this time after our own command are its echo. */
const OWN_CHANGE_ECHO_MS = 3000;

export interface ActionIsolate {
  id: string;
  extensions: ReadonlySet<string>;
  paused: boolean;
}

export interface ActionHost {
  mainIsolate(): ActionIsolate | undefined;
  /** Rejects when not connected or when the extension fails. */
  callExtension<T>(method: string, isolateId: string, params: Record<string, string>, timeoutMs: number): Promise<T>;
  connected(): boolean;
  /** True once the server accepted the app session (actions can be sent). */
  ready(): boolean;
  send(message: SdkToServer): void;
  log(log: AppLog): void;
  deviceNow(): number;
  valueContext(): ValueContext;
  logger: Logger;
}

export interface CommandMessage {
  id: string;
  name: string;
  params?: Record<string, unknown>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ActionController {
  private readonly values = new Map<string, ActionValue>();
  private readonly ownChanges = new Map<string, number>();
  private lastJson = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly host: ActionHost) {}

  /** Descriptors for the current main isolate (only actions whose extension is registered). */
  descriptors(): AppActionDescriptor[] {
    const main = this.host.mainIsolate();
    return main ? buildActionDescriptors(main.extensions, this.values) : [];
  }

  /** Remember what the hello already advertised. */
  markAdvertised(actions: AppActionDescriptor[] | undefined): void {
    this.lastJson = JSON.stringify(actions ?? []);
  }

  /** Hot restart: the framework's debug flags are back to their defaults; re-read and re-advertise. */
  reset(): void {
    this.values.clear();
    this.lastJson = '';
  }

  /** Send `{type:'actions'}` when the descriptors changed. */
  publish(): void {
    if (this.disposed || !this.host.ready()) return;
    const actions = this.descriptors();
    const json = JSON.stringify(actions);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.host.send({ type: 'actions', actions });
  }

  /** Debounced publish: extensions register one by one at startup / after a hot restart. */
  schedule(refreshValues: boolean): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void (async () => {
        if (refreshValues) await this.refreshValues();
        this.publish();
      })();
    }, 300);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** `Flutter.ServiceExtensionStateChanged` (DevTools, the IDE or the app changed a flag). */
  onStateChanged(extension: string, value: unknown): void {
    const change = valueFromStateChange(extension, value, this.host.valueContext());
    if (!change) return;
    const own = this.ownChanges.get(change.id);
    if (own && Date.now() - own < OWN_CHANGE_ECHO_MS) return;
    if (this.values.get(change.id) === change.value) return;
    this.values.set(change.id, change.value);
    this.schedule(false);
  }

  /** Read the current value of every stateful action we do not know yet. */
  async refreshValues(): Promise<void> {
    const main = this.host.mainIsolate();
    if (!main || main.paused || !this.host.connected()) return;
    const specs = availableActions(main.extensions).filter((s) => s.kind !== 'button' && !this.values.has(s.id));
    await Promise.all(
      specs.map(async (spec) => {
        try {
          const r = await this.host.callExtension<Record<string, unknown>>(spec.extension, main.id, {}, 5000);
          const value = valueFromResponse(spec, r, this.host.valueContext());
          if (value !== undefined && !this.values.has(spec.id)) this.values.set(spec.id, value);
        } catch (err) {
          this.host.logger.debug(`reading ${spec.extension} failed: ${errorText(err)}`);
        }
      }),
    );
  }

  /** Execute a `command` and always answer with `command.result`. */
  async handle(msg: CommandMessage): Promise<void> {
    const reply = (ok: boolean, data?: unknown, error?: string) =>
      this.host.send({ type: 'command.result', id: msg.id, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
    try {
      const spec = ACTIONS_BY_ID.get(msg.name);
      if (!spec) return reply(false, undefined, `Unknown command: ${msg.name}`);
      const main = this.host.mainIsolate();
      if (!main || !this.host.connected()) return reply(false, undefined, 'The app is not ready yet (no main isolate)');
      if (!main.extensions.has(spec.extension)) {
        return reply(false, undefined, `${spec.label} is not available in this build (debug mode only)`);
      }
      if (main.paused) return reply(false, undefined, 'The app is paused in the debugger');
      const requested = resolveRequestedValue(spec, msg.params, this.values.get(spec.id));
      if (!requested.ok) return reply(false, undefined, requested.error);
      if (spec.kind === 'button') {
        // debugDumpApp / debugDumpRenderTree return the dump instead of printing it.
        const result = await this.host.callExtension<{ data?: unknown }>(spec.extension, main.id, {}, COMMAND_TIMEOUT_MS);
        const dump = typeof result?.data === 'string' ? result.data : JSON.stringify(result ?? {}, null, 2);
        const text = dump.length > MAX_DUMP_CHARS ? `${dump.slice(0, MAX_DUMP_CHARS)}\n… (truncated)` : dump;
        const lines = text.split('\n').length;
        const title = spec.id === 'flutter.dumpWidgetTree' ? 'Widget tree' : 'Render tree';
        this.host.log({ ts: this.host.deviceNow(), level: 'info', tag: 'flutter', message: `${title} (${lines} lines)\n${text}`, kind: 'text' });
        return reply(true, { text, lines });
      }
      this.ownChanges.set(spec.id, Date.now());
      const result = await this.host.callExtension<Record<string, unknown>>(
        spec.extension,
        main.id,
        writeParams(spec, requested.value),
        COMMAND_TIMEOUT_MS,
      );
      const value = valueFromResponse(spec, result, this.host.valueContext(), requested.value) ?? requested.value;
      if (value !== undefined) this.values.set(spec.id, value);
      this.publish();
      return reply(true, { value });
    } catch (err) {
      return reply(false, undefined, errorText(err));
    }
  }
}
