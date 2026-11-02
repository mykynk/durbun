import type { ComponentType } from 'react';

/**
 * Command palette registry. Features register commands while mounted (`useCommands`); the palette
 * collects them every time it opens, so titles can be localized and closures stay fresh.
 */
export interface PaletteCommand {
  /** Unique id, e.g. "logs.clear". Later registrations with the same id win. */
  id: string;
  /** Localized title. */
  title: string;
  /** Localized group heading, e.g. t('common.groups.logs'). */
  group?: string;
  /** Secondary text shown right-aligned/dimmed. */
  subtitle?: string;
  /** Extra search terms (both languages are a good idea: ["clear", "temizle"]). */
  keywords?: readonly string[];
  /** Shortcut combo shown as a hint (display only — register it with `useShortcut`). */
  shortcut?: string;
  /** lucide-react icon component. */
  icon?: ComponentType<{ size?: number | string; className?: string; strokeWidth?: number | string }>;
  run: () => void | Promise<void>;
  /** Hidden when true. */
  disabled?: boolean;
  /** Ordering with an empty query (higher first). Default 0. */
  priority?: number;
}

export type CommandProvider = () => readonly PaletteCommand[];

const providers: { get: CommandProvider; order: number }[] = [];
let seq = 0;
const listeners = new Set<() => void>();

/** Register a provider (or a static list). Returns an unregister function. */
export function registerCommands(source: CommandProvider | readonly PaletteCommand[]): () => void {
  const get: CommandProvider = typeof source === 'function' ? source : () => source;
  const entry = { get, order: ++seq };
  providers.push(entry);
  listeners.forEach((l) => l());
  return () => {
    const i = providers.indexOf(entry);
    if (i >= 0) providers.splice(i, 1);
    listeners.forEach((l) => l());
  };
}

/** All enabled commands (deduplicated by id; the most recent registration wins). */
export function getAllCommands(): PaletteCommand[] {
  const byId = new Map<string, PaletteCommand>();
  for (const p of [...providers].sort((a, b) => a.order - b.order)) {
    let list: readonly PaletteCommand[] = [];
    try {
      list = p.get();
    } catch (err) {
      console.error('[durbun] command provider failed', err);
    }
    for (const c of list) if (!c.disabled) byId.set(c.id, c);
  }
  return [...byId.values()];
}

export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
