/**
 * Server-Sent Events of a browser's own `EventSource` (SPEC §6.1.1). A native EventSource never goes through
 * `fetch` or `XMLHttpRequest`, so it is captured here; an EventSource polyfill (React Native libraries,
 * `event-source-polyfill`, …) runs on XHR / fetch and is captured there instead, so every connection is one
 * entry. The global becomes a subclass of itself, like `WebSocket`.
 *
 * What the browser exposes is all there is: the response is the 200 `text/event-stream` the spec requires
 * before `open`; events are `message` plus the named events the app listens for (a named event nobody listens
 * to is never delivered to JavaScript); `retry:` and comments are not visible. Each reconnect the browser makes
 * is a new entry (with `Last-Event-ID`); its start time is when the previous connection dropped.
 */
import { utf8Length } from './body.js';
import type { NetworkHost } from './network.js';
import type { Patch } from './patch.js';
import type { Header } from './protocol.js';
import { patchGlobalClass, sseMessage } from './streams.js';
import { attempt, g, resolveUrl, type AnyRecord } from './util.js';

const CONNECTING = 0;
const CLOSED = 2;
const BUILT_IN_TYPES = ['open', 'error', 'message'];

interface Attempt {
  startTs: number;
  /** Set once its request was reported. */
  id?: string;
  openTs?: number;
  lastEventId: string;
}

interface Source {
  url: string;
  current: Attempt;
  /** `lastEventId` of the last event seen (a reconnect sends it as Last-Event-ID). */
  lastEventId: string;
  ended: boolean;
  /** Named event types already observed. */
  types: Set<string>;
}

/** A constructor implemented by the runtime itself (not a JavaScript polyfill). */
export function isNativeConstructor(fn: unknown): boolean {
  return typeof fn === 'function' && attempt(() => /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn)), false);
}

export function installEventSourcePatch(host: NetworkHost, options: { nativeOnly?: boolean } = {}): Patch[] {
  const ES = g.EventSource;
  if (typeof ES !== 'function') return [];
  if (options.nativeOnly !== false && !isNativeConstructor(ES)) {
    host.debug('EventSource is a polyfill here: captured through XMLHttpRequest / fetch');
    return [];
  }
  const sources = new WeakMap<object, Source>();

  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      host.debug(`EventSource ${what}`, e);
    }
  };

  const respond = (s: Source): void => {
    const a = s.current;
    const openTs = a.openTs as number;
    host.emit({
      type: 'net.response',
      id: a.id as string,
      ts: openTs,
      status: 200,
      headers: [['Content-Type', 'text/event-stream']],
      timings: { wait: Math.max(0, openTs - a.startTs) },
    });
  };

  const announce = (s: Source): boolean => {
    const a = s.current;
    if (a.id !== undefined) return true;
    if (host.streamCapture() === undefined) return false;
    a.id = host.nextRequestId();
    const headers: Header[] = [
      ['Accept', 'text/event-stream'],
      ['Cache-Control', 'no-cache'],
    ];
    if (a.lastEventId) headers.push(['Last-Event-ID', a.lastEventId]);
    host.emit({ type: 'net.request', id: a.id, ts: a.startTs, method: 'GET', url: s.url, headers, source: 'eventsource' });
    if (a.openTs !== undefined) respond(s);
    return true;
  };

  const onEvent = (s: Source, ev: AnyRecord, type: string): void => {
    if (s.ended) return;
    const cap = host.streamCapture();
    if (cap === undefined || !announce(s)) return;
    const data = attempt(() => String(ev.data ?? ''), '');
    const lastEventId = attempt(() => (typeof ev.lastEventId === 'string' ? ev.lastEventId : ''), '');
    // The browser keeps the last id on every later event: report it when it changed.
    const id = lastEventId !== s.lastEventId ? lastEventId : undefined;
    s.lastEventId = lastEventId;
    const event = { data, size: utf8Length(data), ...(type !== 'message' ? { event: type } : {}), ...(id !== undefined ? { id } : {}) };
    host.emit(sseMessage(s.current.id as string, Date.now(), event, cap));
  };

  const onError = (es: AnyRecord, s: Source): void => {
    if (s.ended) return;
    const state = attempt(() => Number(es.readyState), CLOSED);
    const a = s.current;
    const reconnecting = state === CONNECTING;
    if (a.openTs !== undefined) {
      // An open stream broke.
      if (a.id !== undefined && host.streamCapture() !== undefined) {
        host.emit({ type: 'net.error', id: a.id, ts: Date.now(), error: reconnecting ? 'Connection lost; reconnecting' : 'Connection lost' });
      }
    } else if (announce(s)) {
      host.emit({ type: 'net.error', id: a.id as string, ts: Date.now(), error: 'EventSource connection failed' });
    }
    if (reconnecting) s.current = { startTs: Date.now(), lastEventId: s.lastEventId };
    else s.ended = true;
  };

  const patch = patchGlobalClass('EventSource', (Original, isActive) => {
    const listen = (target: AnyRecord, type: string, fn: (ev: AnyRecord) => void) => Original.prototype.addEventListener.call(target, type, fn);
    return class DurbunEventSource extends Original {
      constructor(...args: any[]) {
        super(...args);
        if (!isActive()) return;
        guard('setup', () => {
          const url = resolveUrl(String(args[0]));
          if (host.isIgnored(url)) return;
          const s: Source = { url, current: { startTs: Date.now(), lastEventId: '' }, lastEventId: '', ended: false, types: new Set() };
          sources.set(this, s);
          announce(s);
          listen(this, 'open', () =>
            guard('open', () => {
              if (s.ended) return;
              s.current.openTs = Date.now();
              if (s.current.id !== undefined) respond(s);
              else announce(s);
            }),
          );
          listen(this, 'message', (ev) => guard('message', () => onEvent(s, ev, 'message')));
          listen(this, 'error', () => guard('error', () => onError(this, s)));
        });
      }

      addEventListener(...args: any[]): any {
        const result = super.addEventListener(...args);
        const s = sources.get(this);
        const type = args[0];
        if (s && typeof type === 'string' && BUILT_IN_TYPES.indexOf(type) < 0 && !s.types.has(type)) {
          s.types.add(type);
          guard('listen', () => listen(this, type, (ev) => guard('event', () => onEvent(s, ev, type))));
        }
        return result;
      }

      close(...args: any[]): any {
        const s = sources.get(this);
        const result = super.close(...args);
        if (s && !s.ended) {
          s.ended = true;
          guard('close', () => {
            const a = s.current;
            if (a.openTs !== undefined) {
              if (a.id !== undefined && host.streamCapture() !== undefined) {
                host.emit({ type: 'net.error', id: a.id, ts: Date.now(), error: 'Stream closed by the app', cancelled: true });
              }
            } else if (announce(s)) {
              host.emit({ type: 'net.error', id: a.id as string, ts: Date.now(), error: 'Request cancelled', cancelled: true });
            }
          });
        }
        return result;
      }
    };
  });
  return patch ? [patch] : [];
}
