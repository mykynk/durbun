/**
 * App actions shown as buttons / toggles / selects in the desktop's Device tab (`hello.actions`) and run
 * through `command` messages. Apps register their own with `Durbun.addAction`; a few built-ins exist
 * for React Native dev builds and web pages.
 */
import type { AppActionDescriptor } from './protocol.js';
import type { Runtime } from './env.js';
import { loadReactNative, isDevBuild } from './env.js';
import { sharedState } from './shared.js';
import { g, type AnyRecord } from './util.js';

export type ActionHandler = (params: Record<string, unknown>) => unknown;

export interface DurbunAction {
  /** Unique id, e.g. 'app.clearCache'. */
  id: string;
  /** Text on the button (English or Turkish — shown as-is). */
  label: string;
  /** 'button' (default), 'toggle' (params.value: boolean) or 'select' (params.value: string). */
  kind?: AppActionDescriptor['kind'];
  group?: string;
  options?: { value: string; label: string }[];
  /** Current toggle/select state. */
  value?: boolean | string;
}

export interface ActionHandle {
  /** Change the label/state shown on the desktop. */
  update(patch: Partial<Omit<DurbunAction, 'id'>>): void;
  remove(): void;
}

interface Entry {
  descriptor: AppActionDescriptor;
  handler: ActionHandler;
}

export class ActionRegistry {
  private entries = new Map<string, Entry>();
  private listeners: Array<() => void> = [];

  add(action: DurbunAction, handler: ActionHandler): ActionHandle {
    const descriptor: AppActionDescriptor = {
      id: String(action.id),
      kind: action.kind === 'toggle' || action.kind === 'select' ? action.kind : 'button',
      label: String(action.label || action.id),
    };
    if (action.group) descriptor.group = String(action.group);
    if (Array.isArray(action.options)) descriptor.options = action.options.map((o) => ({ value: String(o.value), label: String(o.label) }));
    if (action.value !== undefined) descriptor.value = action.value;
    this.entries.set(descriptor.id, { descriptor, handler });
    this.changed();
    return {
      update: (patch) => this.update(descriptor.id, patch),
      remove: () => this.remove(descriptor.id, handler),
    };
  }

  update(id: string, patch: Partial<Omit<DurbunAction, 'id'>>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const d = entry.descriptor;
    if (patch.label !== undefined) d.label = String(patch.label);
    if (patch.kind !== undefined) d.kind = patch.kind;
    if (patch.group !== undefined) d.group = patch.group;
    if (patch.options !== undefined) d.options = patch.options;
    if (patch.value !== undefined) d.value = patch.value;
    this.changed();
  }

  remove(id: string, handler?: ActionHandler): void {
    const entry = this.entries.get(id);
    if (!entry || (handler && entry.handler !== handler)) return;
    this.entries.delete(id);
    this.changed();
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  descriptors(): AppActionDescriptor[] {
    const out: AppActionDescriptor[] = [];
    this.entries.forEach((e) => out.push({ ...e.descriptor }));
    return out;
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private changed(): void {
    for (const l of this.listeners.slice()) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }
}

/** Shared by `Durbun.addAction` (callable before `start`) and the running client. */
export const appActions: ActionRegistry = (() => {
  const state = sharedState();
  if (!state.actions || typeof (state.actions as ActionRegistry).add !== 'function') state.actions = new ActionRegistry();
  return state.actions as ActionRegistry;
})();

/** Built-in actions available in this runtime (never shown when the underlying API is missing). */
export function builtInActions(runtime: Runtime): Array<{ descriptor: AppActionDescriptor; handler: ActionHandler }> {
  const out: Array<{ descriptor: AppActionDescriptor; handler: ActionHandler }> = [];
  if (runtime === 'react-native' && isDevBuild() !== false) {
    const rn = loadReactNative();
    const devSettings = rn && (rn.DevSettings as AnyRecord | undefined);
    if (devSettings && typeof devSettings.reload === 'function') {
      out.push({
        descriptor: { id: 'rn.reload', kind: 'button', label: 'Reload JS', group: 'react-native' },
        handler: () => {
          // Reply first: the JS context (and this socket) goes away during the reload.
          g.setTimeout(() => devSettings.reload('Dürbün'), 50);
          return null;
        },
      });
    }
    const devMenu = rn && rn.NativeModules && (rn.NativeModules.DevMenu as AnyRecord | undefined);
    if (devMenu && typeof devMenu.show === 'function') {
      out.push({
        descriptor: { id: 'rn.devMenu', kind: 'button', label: 'Open dev menu', group: 'react-native' },
        handler: () => {
          devMenu.show();
          return null;
        },
      });
    }
  } else if (runtime === 'web') {
    const loc = g.location;
    if (loc && typeof loc.reload === 'function') {
      out.push({
        descriptor: { id: 'web.reload', kind: 'button', label: 'Reload page', group: 'web' },
        handler: () => {
          g.setTimeout(() => loc.reload(), 50);
          return null;
        },
      });
    }
  }
  return out;
}
