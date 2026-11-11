/**
 * The open flow: loads it, keeps undo/redo, validates locally and saves by itself shortly after each change
 * (drafts with errors are saved too; the run uses what is saved, so a run flushes first).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateFlow, type FlowDoc, type FlowIssue } from '@durbun/protocol';
import { toast } from '../../../components';
import { api, useFlows } from '../../../data';
import { isConnected, useConnection } from '../../../data/stores/connection';
import { t } from '../../../i18n/core';
import { flowErrorText } from './errors';
import { ensureLayout } from './graph';

const SAVE_DELAY_MS = 700;
const COALESCE_MS = 900;
const MAX_HISTORY = 200;
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;

/* ───────────── edits of flows the user left before they were saved ───────────── */

/**
 * A flow the user switched away from while its save failed (server down, network gone) keeps its document here,
 * by id, and is saved again until the server takes it. Opening the flow again picks the document up.
 */
const pendingDocs = new Map<string, FlowDoc>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;
let retrying: Promise<void> | null = null;

function keepPending(id: string, flow: FlowDoc, quiet = false): void {
  const first = !pendingDocs.has(id);
  pendingDocs.set(id, flow);
  if (first && !quiet) toast.error(t('flows.save.leftFailed', { name: flow.name }), { id: `flow-pending-${id}`, description: t('flows.save.leftHint'), duration: 10_000 });
  scheduleRetry();
}

function scheduleRetry(delay = retryDelay): void {
  if (retryTimer || retrying || !pendingDocs.size) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retrying = retryPending().finally(() => {
      retrying = null;
      if (pendingDocs.size) scheduleRetry();
    });
  }, delay);
}

async function retryPending(): Promise<void> {
  for (const [id, flow] of [...pendingDocs]) {
    try {
      await api.saveFlow(id, flow);
      if (pendingDocs.get(id) === flow) {
        pendingDocs.delete(id);
        toast.success(t('flows.save.leftSaved', { name: flow.name }), { id: `flow-pending-${id}` });
      }
    } catch (err) {
      // The server answered and refused it (a deleted flow, an id taken meanwhile): another try cannot help.
      const status = (err as { status?: number })?.status ?? 0;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429 && pendingDocs.get(id) === flow) {
        pendingDocs.delete(id);
        if (status !== 404) toast.error(t('flows.save.leftDropped', { name: flow.name }), { id: `flow-pending-${id}`, description: flowErrorText(err), duration: 15_000 });
        else toast.dismiss(`flow-pending-${id}`);
      }
      /* anything else is kept for the next try */
    }
  }
  retryDelay = pendingDocs.size ? Math.min(retryDelay * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
}

/** Taken by the editor when the flow is opened again: it saves the document itself from then on. */
async function takePending(id: string): Promise<FlowDoc | undefined> {
  if (retrying) await retrying;
  const doc = pendingDocs.get(id);
  pendingDocs.delete(id);
  return doc;
}

/** True while edits of this flow wait for the server (the user left the flow). */
export function hasPendingSave(id: string): boolean {
  return pendingDocs.has(id);
}

// The connection came back: try at once instead of waiting for the back-off.
useConnection.subscribe((s, prev) => {
  if (!isConnected(s.status) || isConnected(prev.status) || !pendingDocs.size) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_MIN_MS;
  scheduleRetry(0);
});

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface Hist {
  past: FlowDoc[];
  present: FlowDoc;
  future: FlowDoc[];
  /** Last coalescing key and when it was used (typing in one field = one undo step). */
  key?: string;
  at?: number;
}

/** What identifies the content (timestamps excluded). */
export function flowSignature(flow: FlowDoc): string {
  const { updatedAt: _u, createdAt: _c, ...rest } = flow;
  return JSON.stringify(rest);
}

export interface FlowDocument {
  status: 'loading' | 'ready' | 'missing' | 'error';
  error?: unknown;
  flow: FlowDoc | null;
  issues: FlowIssue[];
  save: SaveState;
  saveError?: unknown;
  canUndo: boolean;
  canRedo: boolean;
  /** Applies an edit. `coalesce`: edits with the same key in a short time become one undo step. */
  apply(edit: (flow: FlowDoc) => FlowDoc, opts?: { coalesce?: string }): void;
  undo(): void;
  redo(): void;
  /** Saves now; resolves with the id the flow has on the server (a rename changes it). */
  flush(): Promise<string | null>;
  reload(): void;
}

export function useFlowDocument(flowId: string | null, onRenamed?: (from: string, to: string) => void): FlowDocument {
  const [status, setStatus] = useState<FlowDocument['status']>(flowId ? 'loading' : 'missing');
  const [error, setError] = useState<unknown>();
  const [hist, setHist] = useState<Hist | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<unknown>();
  const [reloadTick, setReloadTick] = useState(0);
  const savedSig = useRef<string>('');
  const savedAt = useRef<number>(0);
  const serverId = useRef<string | null>(flowId);
  const histRef = useRef<Hist | null>(null);
  histRef.current = hist;
  const inflight = useRef<Promise<string | null> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renamedRef = useRef(onRenamed);
  renamedRef.current = onRenamed;
  /** Bumped on every load: a save that ends after it no longer describes what is on screen. */
  const docSeq = useRef(0);

  /* ── load ── */
  const loadedTick = useRef(-1);
  useEffect(() => {
    // The parent follows a rename to the new id: the document here is already that flow.
    if (flowId && flowId === serverId.current && histRef.current && loadedTick.current === reloadTick) return;
    loadedTick.current = reloadTick;
    docSeq.current++;
    serverId.current = flowId;
    setHist(null);
    setSave('saved');
    setSaveError(undefined);
    if (!flowId) {
      setStatus('missing');
      return;
    }
    const ctrl = new AbortController();
    setStatus('loading');
    void (async () => {
      // A save of the flow just left may still be going: when it fails, its edits are kept (below) first.
      if (inflight.current) await inflight.current.catch(() => null);
      // Edits left here earlier that never reached the server come back and are saved by the editor.
      const pending = await takePending(flowId);
      if (ctrl.signal.aborted) {
        if (pending && !pendingDocs.has(flowId)) keepPending(flowId, pending, true);
        return;
      }
      if (pending) {
        savedSig.current = '';
        savedAt.current = pending.updatedAt ?? 0;
        setHist({ past: [], present: ensureLayout(pending), future: [] });
        setStatus('ready');
        return;
      }
      try {
        const { flow } = await api.getFlow(flowId, ctrl.signal);
        const laid = ensureLayout(flow);
        savedSig.current = flowSignature(flow);
        savedAt.current = flow.updatedAt ?? 0;
        setHist({ past: [], present: laid, future: [] });
        setStatus('ready');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError(err);
        setStatus((err as { status?: number })?.status === 404 ? 'missing' : 'error');
      }
    })();
    return () => ctrl.abort();
  }, [flowId, reloadTick]);

  // Until the load effect runs for a new id, the state still describes the previous flow.
  const stale = flowId !== serverId.current;
  const flow = stale ? null : (hist?.present ?? null);
  const knownIds = useFlows((s) => s.summaries.map((f) => f.id).join('\u0001'));
  const issues = useMemo(() => {
    if (!flow) return [];
    const known = new Set(knownIds ? knownIds.split('\u0001') : []);
    return validateFlow(flow, { knownFlowIds: known, addTrigger: false }).issues;
  }, [flow, knownIds]);

  /* ── save ── */
  const doSave = useCallback(async (): Promise<string | null> => {
    // Taken before waiting: when the user switches flows meanwhile, this still saves the flow they left.
    const h = histRef.current;
    const id = serverId.current;
    const seq = docSeq.current;
    /** Still the document on screen (not a flow the user has left). */
    const same = () => serverId.current === id && docSeq.current === seq;
    if (inflight.current) await inflight.current.catch(() => null);
    if (!h || !id) return id;
    const sig = flowSignature(h.present);
    if (same() && sig === savedSig.current) {
      setSave('saved');
      return id;
    }
    if (same()) setSave('saving');
    const work = (async () => {
      try {
        const res = await api.saveFlow(id, h.present);
        // The user moved on to another flow meanwhile: this one is saved, nothing here describes it any more.
        if (!same()) return res.flow.id;
        savedSig.current = sig;
        savedAt.current = res.flow.updatedAt ?? Date.now();
        setSaveError(undefined);
        if (res.flow.id !== id) {
          serverId.current = res.flow.id;
          renamedRef.current?.(id, res.flow.id);
        }
        // Edits made while saving are saved next.
        const now = histRef.current;
        setSave(now && flowSignature(now.present) !== sig ? 'dirty' : 'saved');
        return res.flow.id;
      } catch (err) {
        if (same()) {
          setSaveError(err);
          setSave('error');
        } else if ((err as { status?: number })?.status !== 404) {
          // The user left the flow: the edits stay in this window and are saved when the server takes them.
          keepPending(id, h.present);
        }
        throw err;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = work;
    return work;
  }, []);

  useEffect(() => {
    if (!flow || status !== 'ready') return;
    if (flowSignature(flow) === savedSig.current) return;
    setSave((s) => (s === 'saving' ? s : 'dirty'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void doSave().catch(() => undefined);
    }, SAVE_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flow, status, doSave]);

  // Leaving the flow (or the window) saves what is pending.
  useEffect(() => {
    const onHide = () => {
      if (histRef.current && flowSignature(histRef.current.present) !== savedSig.current) void doSave().catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [flowId, doSave]);

  // Someone else saved this flow (another window, an import): reload when nothing is pending here.
  const remoteUpdatedAt = useFlows((s) => s.summaries.find((f) => f.id === serverId.current)?.updatedAt ?? 0);
  useEffect(() => {
    if (status !== 'ready' || !remoteUpdatedAt || remoteUpdatedAt <= savedAt.current + 1) return;
    const h = histRef.current;
    if (h && flowSignature(h.present) !== savedSig.current) return;
    if (inflight.current) return;
    const id = serverId.current;
    if (!id) return;
    api.getFlow(id).then(
      ({ flow: fresh }) => {
        const cur = histRef.current;
        if (!cur || flowSignature(cur.present) !== savedSig.current) return;
        savedSig.current = flowSignature(fresh);
        savedAt.current = fresh.updatedAt ?? remoteUpdatedAt;
        if (flowSignature(fresh) !== flowSignature(cur.present)) setHist({ past: [...cur.past, cur.present].slice(-MAX_HISTORY), present: ensureLayout(fresh), future: [] });
      },
      () => undefined,
    );
  }, [remoteUpdatedAt, status]);

  /* ── edits ── */
  const apply = useCallback((edit: (flow: FlowDoc) => FlowDoc, opts: { coalesce?: string } = {}) => {
    setHist((h) => {
      if (!h) return h;
      const next = edit(h.present);
      if (next === h.present) return h;
      const now = Date.now();
      const merge = !!opts.coalesce && h.key === opts.coalesce && now - (h.at ?? 0) < COALESCE_MS;
      return {
        past: merge ? h.past : [...h.past, h.present].slice(-MAX_HISTORY),
        present: next,
        future: [],
        key: opts.coalesce,
        at: now,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setHist((h) => (h && h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] } : h));
  }, []);
  const redo = useCallback(() => {
    setHist((h) => (h && h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h));
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return doSave();
  }, [doSave]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  return {
    status: stale ? (flowId ? 'loading' : 'missing') : status,
    error,
    flow,
    issues,
    save,
    saveError,
    canUndo: !!hist?.past.length,
    canRedo: !!hist?.future.length,
    apply,
    undo,
    redo,
    flush,
    reload,
  };
}
