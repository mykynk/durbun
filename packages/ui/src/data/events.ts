import type { ServerToUi, UiNotice } from '@durbun/protocol';

type Listener<T> = (value: T) => void;

function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    on(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value: T): void {
      for (const l of [...listeners]) {
        try {
          l(value);
        } catch (err) {
          console.error('[durbun] event listener failed', err);
        }
      }
    },
  };
}

const serverMessages = emitter<ServerToUi>();
const notices = emitter<UiNotice>();
const resyncs = emitter<void>();

/**
 * Every message from WS /ui after the stores were updated (history/batch included — keep listeners
 * cheap). Useful for reacting to `cleared`, `reply`-less events, etc.
 */
export const onServerMessage = serverMessages.on;
export const emitServerMessage = serverMessages.emit;

/** Server notices (also shown as toasts by the shell). */
export const onNotice = notices.on;
export const emitNotice = notices.emit;

/** Fired when a new connection replaced all data (snapshot after (re)connect). Reset derived caches. */
export const onResync = resyncs.on;
export const emitResync = () => resyncs.emit();
