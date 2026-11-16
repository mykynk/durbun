import { useEffect, useSyncExternalStore } from 'react';
import { STREAM_HEAD_KEPT, type StreamInfo, type StreamMessage } from '@durbun/protocol';
import { getStreamMessages } from './api';
import { networkStore } from './networkStore';
import { useNetworkVersion } from './hooks';

/**
 * Messages of stream entries (WebSocket messages, SSE events) for the Network view. The entry row carries the
 * counts (NetworkEntry.stream, live through the normal batches); the messages themselves are fetched only for
 * the entry a view shows, after the newest seq this window holds (GET /api/network/:id/messages), whenever the
 * entry's `stream.lastSeq` moves. A window that opens the entry later, or comes back after a reconnect, catches
 * up the same way.
 */
export interface StreamMessagesState {
  /** Seq order, oldest first. Gaps in `seq`: messages the server's limits dropped (streamGaps). */
  messages: readonly StreamMessage[];
  /** The entry's stream as of the last answer (the row's own NetworkEntry.stream is newer while loading). */
  stream?: StreamInfo;
  /** idle: not a stream / nothing asked yet · loading: the first page is on its way · ready · error (`error`). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: unknown;
  /** A newer page is being fetched (the list is shown meanwhile). */
  refreshing: boolean;
}

/** Messages a window keeps per entry (the first STREAM_HEAD_KEPT and the newest, like the server). */
export const MAX_CLIENT_STREAM_MESSAGES = 5_000;
/** Entries whose messages stay cached (the least recently viewed go). */
const MAX_CACHED_ENTRIES = 20;
const PAGE = 1_000;

const IDLE: StreamMessagesState = { messages: [], status: 'idle', refreshing: false };

interface Slot {
  state: StreamMessagesState;
  /** Newest seq held. */
  lastSeq: number;
  inflight: Promise<void> | null;
  again: boolean;
  listeners: Set<() => void>;
}

const slots = new Map<string, Slot>();
let generation = 0;

function slotOf(id: string): Slot {
  let s = slots.get(id);
  if (s) {
    slots.delete(id);
    slots.set(id, s);
    return s;
  }
  s = { state: IDLE, lastSeq: 0, inflight: null, again: false, listeners: new Set() };
  slots.set(id, s);
  for (const [key, old] of slots) {
    if (slots.size <= MAX_CACHED_ENTRIES) break;
    if (old.listeners.size === 0 && key !== id) slots.delete(key);
  }
  return s;
}

function set(slot: Slot, patch: Partial<StreamMessagesState>): void {
  slot.state = { ...slot.state, ...patch };
  for (const l of [...slot.listeners]) l();
}

function trim(messages: StreamMessage[]): StreamMessage[] {
  if (messages.length <= MAX_CLIENT_STREAM_MESSAGES) return messages;
  const head = messages.slice(0, STREAM_HEAD_KEPT);
  return head.concat(messages.slice(messages.length - (MAX_CLIENT_STREAM_MESSAGES - STREAM_HEAD_KEPT)));
}

/** Gaps in a seq-ordered list: `count` messages dropped after `afterSeq` (the view shows "N messages dropped"). */
export function streamGaps(messages: readonly StreamMessage[]): { afterSeq: number; count: number }[] {
  const out: { afterSeq: number; count: number }[] = [];
  let prev = 0;
  for (const m of messages) {
    if (m.seq > prev + 1) out.push({ afterSeq: prev, count: m.seq - prev - 1 });
    prev = m.seq;
  }
  return out;
}

export const streamMessages = {
  get(id: string): StreamMessagesState {
    return slots.get(id)?.state ?? IDLE;
  },

  /** Fetch what entry `id` has after the newest seq held (all pages). Concurrent calls coalesce. */
  sync(id: string): Promise<void> {
    const slot = slotOf(id);
    if (slot.inflight) {
      slot.again = true;
      return slot.inflight;
    }
    const gen = generation;
    const run = async (): Promise<void> => {
      if (slot.state.status === 'idle' || slot.state.status === 'error') set(slot, { status: slot.state.messages.length ? 'ready' : 'loading', refreshing: true });
      else set(slot, { refreshing: true });
      try {
        let more = true;
        while (more) {
          const page = await getStreamMessages(id, { after: slot.lastSeq, limit: PAGE });
          if (gen !== generation) return;
          const fresh = page.messages.filter((m) => m.seq > slot.lastSeq);
          if (fresh.length) slot.lastSeq = fresh.at(-1)!.seq;
          const patch: Partial<StreamMessagesState> = { status: 'ready', error: undefined };
          if (fresh.length) patch.messages = trim([...slot.state.messages, ...fresh]);
          if (page.stream) patch.stream = page.stream;
          set(slot, patch);
          more = page.more && fresh.length > 0;
        }
      } catch (error) {
        if (gen === generation) set(slot, { status: slot.state.messages.length ? 'ready' : 'error', error });
      } finally {
        slot.inflight = null;
        if (gen === generation) set(slot, { refreshing: false });
        if (slot.again && gen === generation) {
          slot.again = false;
          void streamMessages.sync(id);
        }
      }
    };
    slot.inflight = run();
    return slot.inflight;
  },

  subscribe(id: string, listener: () => void): () => void {
    const slot = slotOf(id);
    slot.listeners.add(listener);
    return () => {
      slot.listeners.delete(listener);
    };
  },

  /** Forget everything (a new server run, a clear): the next view fetches again. */
  reset(): void {
    generation++;
    const listeners = [...slots.values()].flatMap((s) => [...s.listeners]);
    slots.clear();
    for (const l of listeners) l();
  },
};

/**
 * Messages of the stream entry `id` for a view, kept up to date while `enabled` (default true): fetched when the
 * view mounts and whenever the entry's stream gets newer messages (throttled like the network version).
 */
export function useStreamMessages(id: string | null | undefined, opts: { enabled?: boolean; throttleMs?: number } = {}): StreamMessagesState {
  const enabled = opts.enabled !== false && !!id;
  useNetworkVersion({ enabled, throttleMs: opts.throttleMs ?? 250 });
  const lastSeq = id ? networkStore.get(id)?.stream?.lastSeq : undefined;
  const state = useSyncExternalStore(
    (l) => (id ? streamMessages.subscribe(id, l) : () => {}),
    () => (id ? streamMessages.get(id) : IDLE),
    () => (id ? streamMessages.get(id) : IDLE),
  );
  useEffect(() => {
    if (!enabled || !id || lastSeq === undefined) return;
    if (lastSeq > 0 || streamMessages.get(id).status === 'idle') void streamMessages.sync(id);
  }, [enabled, id, lastSeq]);
  return state;
}
