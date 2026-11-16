/**
 * The open flow: loads it, keeps undo/redo, validates locally and saves by itself shortly after each change
 * (drafts with errors are saved too; the run uses what is saved, so a run flushes first).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateFlow, type FlowDoc, type FlowIssue } from '@durbun/protocol';
import { toast } from '../../../components';
import { api, isEditConflict, useFlows } from '../../../data';
import { isConnected, useConnection } from '../../../data/stores/connection';
import { t } from '../../../i18n/core';
import { isDesktopApp } from '../../../lib/platform';
import { dropDraft, readDraft, storeDraft, type FlowDraft } from './drafts';
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

function keepPending(id: string, flow: FlowDoc, quiet = false, base = 0): void {
  const first = !pendingDocs.has(id);
  pendingDocs.set(id, flow);
  // Also kept on disk: a reload or a quit before the server takes it must not lose the edits.
  storeDraft(id, flow, base);
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
        dropDraftIfSame(id, flow);
        toast.success(t('flows.save.leftSaved', { name: flow.name }), { id: `flow-pending-${id}` });
      }
    } catch (err) {
      // The server answered and refused it (a deleted flow, an id taken meanwhile): another try cannot help.
      const status = (err as { status?: number })?.status ?? 0;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429 && pendingDocs.get(id) === flow) {
        pendingDocs.delete(id);
        dropDraftIfSame(id, flow);
        if (status !== 404) toast.error(t('flows.save.leftDropped', { name: flow.name }), { id: `flow-pending-${id}`, description: flowErrorText(err), duration: 15_000 });
        else toast.dismiss(`flow-pending-${id}`);
      }
      /* anything else is kept for the next try */
    }
  }
  retryDelay = pendingDocs.size ? Math.min(retryDelay * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
}

/** Drops the stored draft of a flow once the server holds exactly that content (a newer draft stays). */
function dropDraftIfSame(id: string, flow: FlowDoc): void {
  const d = readDraft(id);
  if (d && flowSignature(d.flow) === flowSignature(flow)) dropDraft(id);
}

/** True when any flow of this window has edits the server has not taken. */
export function anyPendingSave(): boolean {
  return pendingDocs.size > 0;
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

/** `conflict`: another window saved this flow since it was loaded here; the user picks whose version stays. */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

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

/** A draft from an earlier window that never reached the server, offered back when the flow opens. */
export interface DraftOffer {
  draft: FlowDraft;
  /** The flow was saved elsewhere after the draft's edits started: restoring overwrites those changes. */
  changedSince: boolean;
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
  /** Unsaved edits found from an earlier window (reload, quit, crash), until restored or discarded. */
  draft: DraftOffer | null;
  /** Puts the draft on the canvas as one undoable edit; it is saved like any other edit. */
  restoreDraft(): void;
  /** Forgets the draft; returns it so the caller can offer an undo. */
  discardDraft(): FlowDraft | null;
  /** Offers a discarded draft again (undo of discard). */
  offerDraft(draft: FlowDraft): void;
  /** Conflict: saves this window's version over the other one. */
  keepMine(): Promise<string | null>;
  /** Conflict: loads the version saved elsewhere; this window's version stays offered as a draft. */
  loadTheirs(): void;
}

export function useFlowDocument(flowId: string | null, onRenamed?: (from: string, to: string) => void): FlowDocument {
  const [status, setStatus] = useState<FlowDocument['status']>(flowId ? 'loading' : 'missing');
  const [error, setError] = useState<unknown>();
  const [hist, setHist] = useState<Hist | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  /** Read by the autosave effect without re-running it on every save state change. */
  const saveRef = useRef(save);
  saveRef.current = save;
  const [saveError, setSaveError] = useState<unknown>();
  const [reloadTick, setReloadTick] = useState(0);
  const [draft, setDraft] = useState<DraftOffer | null>(null);
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
    setDraft(null);
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
        // Edits an earlier window could not save: offered back, never applied by themselves.
        const stored = readDraft(flowId);
        if (stored && flowSignature(stored.flow) === savedSig.current) dropDraft(flowId);
        else if (stored) setDraft({ draft: stored, changedSince: !!stored.base && (flow.updatedAt ?? 0) > stored.base + 1 });
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
  const doSave = useCallback(async (overwrite = false): Promise<string | null> => {
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
        // Saved against the copy loaded here: a save another window made meanwhile is refused (`flow.conflict`).
        const res = await api.saveFlow(id, h.present, overwrite || !savedAt.current ? {} : { baseUpdatedAt: savedAt.current });
        // The user moved on to another flow meanwhile: this one is saved, nothing here describes it any more.
        if (!same()) {
          dropDraftIfSame(id, h.present);
          return res.flow.id;
        }
        savedSig.current = sig;
        savedAt.current = res.flow.updatedAt ?? Date.now();
        setSaveError(undefined);
        dropDraftIfSame(id, h.present);
        if (res.flow.id !== id) {
          serverId.current = res.flow.id;
          renamedRef.current?.(id, res.flow.id);
        }
        // Edits made while saving are saved next.
        const now = histRef.current;
        setSave(now && flowSignature(now.present) !== sig ? 'dirty' : 'saved');
        return res.flow.id;
      } catch (err) {
        if (isEditConflict(err)) {
          // Nothing is overwritten by itself: the edits wait on disk until the user picks a version.
          const cur = same() ? histRef.current : null;
          storeDraft(id, cur ? cur.present : h.present, savedAt.current);
          if (same()) {
            setSaveError(err);
            setSave('conflict');
          } else {
            toast.warn(t('flows.conflict.leftTitle', { name: h.present.name }), { id: `flow-pending-${id}`, description: t('flows.conflict.leftHint'), duration: 15_000 });
          }
          throw err;
        }
        if (same()) {
          setSaveError(err);
          setSave('error');
          // Kept on disk too: closing or reloading the window now must not lose them.
          const cur = histRef.current;
          storeDraft(id, cur ? cur.present : h.present, savedAt.current);
        } else if ((err as { status?: number })?.status !== 404) {
          // The user left the flow: the edits stay in this window and are saved when the server takes them.
          keepPending(id, h.present, false, savedAt.current);
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
    // Until the user picks a version, edits only go to disk (each save would be refused again).
    if (saveRef.current === 'conflict') {
      if (serverId.current) storeDraft(serverId.current, flow, savedAt.current);
      return;
    }
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

  // Leaving the flow (or the window) saves what is pending. The window may be gone before the server answers, so
  // the edits are also written to this browser's storage first; the next window offers them back.
  useEffect(() => {
    const unsaved = () => !!histRef.current && flowSignature(histRef.current.present) !== savedSig.current;
    const onHide = (e?: Event) => {
      if (!unsaved()) return;
      if (e && serverId.current) storeDraft(serverId.current, histRef.current!.present, savedAt.current);
      void doSave().catch(() => undefined);
    };
    // In a browser tab the page asks before it goes (the Mac app keeps the draft instead: a blocked unload there
    // would silently stop the quit).
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsaved() && !pendingDocs.size) return;
      if (serverId.current && unsaved()) storeDraft(serverId.current, histRef.current!.present, savedAt.current);
      if (isDesktopApp()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
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

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const restoreDraft = useCallback(() => {
    const offer = draftRef.current;
    if (!offer) return;
    setDraft(null);
    // From here on they are ordinary edits: saved shortly, kept on disk again only if that save fails.
    if (serverId.current) dropDraft(serverId.current);
    setHist((h) => (h ? { past: [...h.past, h.present].slice(-MAX_HISTORY), present: ensureLayout(offer.draft.flow), future: [] } : h));
  }, []);
  const discardDraft = useCallback((): FlowDraft | null => {
    const offer = draftRef.current;
    const id = serverId.current;
    setDraft(null);
    if (offer && id) dropDraft(id);
    return offer?.draft ?? null;
  }, []);
  const offerDraft = useCallback((d: FlowDraft) => {
    const id = serverId.current;
    if (!id) return;
    storeDraft(id, d.flow, d.base, d.at);
    setDraft({ draft: d, changedSince: !!d.base && savedAt.current > d.base + 1 });
  }, []);

  const keepMine = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSave('saving');
    return doSave(true);
  }, [doSave]);
  const loadTheirs = useCallback(() => {
    const id = serverId.current;
    const cur = histRef.current;
    // Kept as a draft: the reload offers it back, so this choice loses nothing until the draft is discarded.
    if (id && cur && flowSignature(cur.present) !== savedSig.current) storeDraft(id, cur.present, savedAt.current);
    setReloadTick((n) => n + 1);
  }, []);

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
    draft: stale ? null : draft,
    restoreDraft,
    discardDraft,
    offerDraft,
    keepMine,
    loadTheirs,
  };
}
