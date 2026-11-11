import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Copy,
  Ellipsis,
  FileDown,
  FileUp,
  Globe,
  LayoutGrid,
  ListPlus,
  Map as MapIcon,
  Maximize2,
  Minus,
  PanelRight,
  Play,
  Plus,
  Power,
  Redo2,
  Scissors,
  Share2,
  Sparkles,
  SquareDashedMousePointer,
  Trash,
  Undo2,
  Workflow,
} from 'lucide-react';
import { FLOW_FORMAT, FLOW_VERSION, flowNodeSpec, type FlowDoc, type FlowPort, type FlowPreflight } from '@durbun/protocol';
import { ApiError, api, isConnected, latestRunOf, rememberFlowRun, setFlowSummaries, ui, useConnection, useFlows, useUi } from '../../data';
import {
  Button,
  DropdownMenu,
  EmptyState,
  IconButton,
  openContextMenu,
  SplitPane,
  Spinner,
  Tooltip,
  confirm,
  copyText,
  downloadUrl,
  pickFiles,
  toast,
  useCommands,
  useFeatureActive,
  usePersistentState,
  useShortcut,
  type MenuItem,
} from '../../components';
import { useLanguage, useT } from '../../i18n';
import { FLOW_FILE_ACCEPT, readPicked, transfer } from '../transfer/store';
import { Canvas, EMPTY_SELECTION, type CanvasApi, type QuickAddRequest, type Selection } from './components/Canvas';
import { NodePicker } from './components/NodePicker';
import { NodeInspector } from './components/NodeInspector';
import { FlowSettings } from './components/FlowSettings';
import { TemplateScope, type TemplateScopeValue } from './components/fields';
import { EnvironmentsDialog } from './components/EnvironmentsDialog';
import { EnvPicker, PreflightChip, RunButton, RunDialog, TargetPicker, runRequest, usePreflight, useRunTarget, type RunDialogState } from './components/RunControls';
import { RunPanel } from './components/RunPanel';
import { FlowList, newFlowMenu, type NewFlowKind } from './components/FlowList';
import { ImportFlowsDialog } from './components/ImportDialog';
import { AiPackDialog } from './components/AiDialog';
import { FromRequestsDialog } from './components/FromRequestsDialog';
import { useFlowDocument, type FlowDocument } from './model/useFlowDocument';
import { flowErrorText } from './model/errors';
import {
  GRID,
  NODE_H,
  NODE_W,
  acceptsInput,
  addNode,
  connect,
  copyNodes,
  downstream,
  edgeKey,
  moveNodes,
  nodePos,
  parseClipboard,
  pasteNodes,
  removeEdges,
  removeNodes,
  removeNodesBridged,
  sidePorts,
  tidyUp,
  updateNode,
  type NodeClipboard,
} from './model/graph';
import { lastOutputs, lastSteps, runOverlay } from './model/run';
import { templateSuggestions } from './model/templates';
import { nodeName } from './model/text';
import { loadEnvironments, useEnvironments } from './model/envStore';
import './i18n';
import './flows.css';

type DialogState = { kind: 'env' } | { kind: 'import'; text: string | null } | { kind: 'ai'; flowId: string | null } | { kind: 'requests'; ids?: string[] } | null;

/** Inputs typed for each flow in this window (never stored: they may hold passwords). */
const lastInputs = new Map<string, Record<string, string>>();
/** Copied steps, for the context menu's Paste (the system clipboard cannot be read without a paste event). */
let clipboard: NodeClipboard | null = null;

const ENV_KEY_RE = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)/g;

function usedEnvKeys(flow: FlowDoc | null): string[] {
  if (!flow) return [];
  const keys = new Set<string>();
  for (const m of JSON.stringify(flow.nodes).matchAll(ENV_KEY_RE)) keys.add(m[1]!);
  return [...keys].sort();
}

/** The port a new step continues from (the "happy path"). */
function continuePort(type: string): FlowPort | undefined {
  const ports = sidePorts(type);
  return (['out', 'done', 'true'] as FlowPort[]).find((p) => ports.includes(p)) ?? ports[0];
}

/** Where a new step goes on when nothing is selected: the one step whose happy-path port is still free (none if several). */
function openTail(f: FlowDoc): { nodeId: string; port: FlowPort } | undefined {
  const tails = f.nodes.flatMap((n) => {
    const port = n.disabled ? undefined : continuePort(n.type);
    return port && !f.edges.some((e) => e.from === n.id && (e.port ?? 'out') === port) ? [{ nodeId: n.id, port }] : [];
  });
  return tails.length === 1 ? tails[0] : undefined;
}

/** Adds a step where the quick-add asked for it: free, after a port, or into an existing connection. */
function placeStep(f: FlowDoc, type: string, req: QuickAddRequest): { flow: FlowDoc; id: string } {
  if (req.insertEdge) {
    const e = f.edges.find((x) => edgeKey(x) === req.insertEdge);
    if (e) {
      const r = addNode(removeEdges(f, new Set([req.insertEdge])), type, { ...(req.at ? { at: req.at } : {}), after: { nodeId: e.from, port: e.port ?? 'out' } });
      const out = continuePort(type);
      const to = f.nodes.find((n) => n.id === e.to);
      return { flow: out && to && acceptsInput(to.type) ? connect(r.flow, r.id, out, e.to) : r.flow, id: r.id };
    }
  }
  return addNode(f, type, { ...(req.at ? { at: req.at } : {}), ...(req.after ? { after: req.after } : {}) });
}

/** "Yeni akış", then "Yeni akış 2", "Yeni akış 3"… while the name is taken. */
export function freeName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A dialog of the window (this tab's or a global one) is open: keys and pastes are its own. */
function modalOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
}

function isEditable(el: Element | null): boolean {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable);
}

function looksLikeFlowText(text: string): boolean {
  return /"format"\s*:\s*"durbun-(flow|package)"/.test(text) || (/"nodes"\s*:/.test(text) && /"edges"\s*:/.test(text));
}

/** Flows tab ("Akışlar"): saved flows, the graph editor, runs and their reports. */
export default function FlowsView() {
  const t = useT();
  const lang = useLanguage();
  const active = useFeatureActive();
  const summaries = useFlows((s) => s.summaries);
  const loaded = useFlows((s) => s.loaded);
  const [selectedId, setSelectedId] = usePersistentState<string | null>('flows.open', null);
  const [showMinimap, setShowMinimap] = usePersistentState('flows.minimap', true);
  const [showInspector, setShowInspector] = usePersistentState('flows.inspector', true);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [picker, setPicker] = useState<QuickAddRequest | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [runDialog, setRunDialog] = useState<RunDialogState | null>(null);
  const [panel, setPanel] = useState<{ runId: string | null; open: boolean }>({ runId: null, open: false });
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [focusName, setFocusName] = useState<string | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pendingRun = useRef<string | null>(null);

  const doc = useFlowDocument(selectedId, (from, to) => setSelectedId((cur) => (cur === from ? to : cur)));
  const flow = doc.status === 'ready' ? doc.flow : null;
  const flowId = flow?.id ?? null;

  // A flow deleted elsewhere (or a stale remembered id) closes.
  useEffect(() => {
    if (doc.status === 'missing' && selectedId) setSelectedId(null);
  }, [doc.status, selectedId, setSelectedId]);
  useEffect(() => {
    setSelection(EMPTY_SELECTION);
    setPicker(null);
    setPanel((p) => (p.open ? { runId: null, open: false } : p));
  }, [selectedId]);
  useEffect(() => {
    void loadEnvironments();
  }, []);

  // The list normally comes with the socket's snapshot; a server (or mock) that never sends it is asked over REST.
  useEffect(() => {
    if (loaded) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api.listFlows(ctrl.signal).then(
        (list) => {
          if (!useFlows.getState().loaded) setFlowSummaries(list);
        },
        () => undefined,
      );
    }, 1500);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [loaded]);

  // Back online: a flow that could not be opened is read again, edits that could not be saved are saved.
  const connected = useConnection((s) => isConnected(s.status));
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) {
      if (doc.status === 'error') doc.reload();
      else if (doc.save === 'error') void doc.flush().catch(() => undefined);
    }
    wasConnected.current = connected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  /* ── runs ── */
  const runs = useFlows((s) => s.runs);
  const summary = summaries.find((f) => f.id === flowId);
  const flowRun = flowId ? latestRunOf(runs, flowId) : undefined;
  const panelRun = panel.runId ? runs[panel.runId] : undefined;
  const overlayRun = panelRun && panelRun.flowId === flowId ? panelRun : flowRun;
  const liveRun = flowRun?.status === 'running' ? flowRun : undefined;
  const lastRunId = summary?.lastRun?.id;
  useEffect(() => {
    if (!lastRunId || useFlows.getState().runs[lastRunId]) return;
    const ctrl = new AbortController();
    api.getFlowRun(lastRunId, ctrl.signal).then(rememberFlowRun, () => undefined);
    return () => ctrl.abort();
  }, [lastRunId]);
  const overlay = useMemo(() => runOverlay(overlayRun), [overlayRun]);
  const stepsByNode = useMemo(() => lastSteps(overlayRun), [overlayRun]);

  /* ── focus requests (other tabs, notifications) ── */
  const focus = useUi((s) => s.focus);
  useEffect(() => {
    if (focus?.kind === 'flowFromRequests') {
      ui.consumeFocus(focus.seq);
      setDialog({ kind: 'requests', ids: focus.ids });
      return;
    }
    if (focus?.kind === 'flowImport') {
      ui.consumeFocus(focus.seq);
      setDialog({ kind: 'import', text: focus.text });
      return;
    }
    if (focus?.kind !== 'flow') return;
    ui.consumeFocus(focus.seq);
    const { flowId: id, runId } = focus;
    void (id === selectedId ? Promise.resolve(true) : switchTo(id)).then((ok) => {
      // After the switch (which closes the panel of the flow left).
      if (ok && runId) setTimeout(() => setPanel({ runId, open: true }), 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  /* ── selection ── */
  const liveSelection = useMemo((): Selection => {
    if (!flow) return EMPTY_SELECTION;
    const ids = new Set(flow.nodes.map((n) => n.id));
    const keys = new Set(flow.edges.map(edgeKey));
    const nodes = [...selection.nodes].filter((id) => ids.has(id));
    const edges = [...selection.edges].filter((k) => keys.has(k));
    if (nodes.length === selection.nodes.size && edges.length === selection.edges.size) return selection;
    return { nodes: new Set(nodes), edges: new Set(edges) };
  }, [flow, selection]);
  const selectedNodes = useMemo(() => (flow ? flow.nodes.filter((n) => liveSelection.nodes.has(n.id)) : []), [flow, liveSelection]);
  const single = selectedNodes.length === 1 ? selectedNodes[0]! : undefined;
  const selectNode = useCallback((id: string, path?: string) => {
    setSelection({ nodes: new Set([id]), edges: new Set() });
    requestAnimationFrame(() => canvasApi.current?.center(id));
    // A problem with a path (`nodes[3].params.url`) also takes the user to that field once the inspector shows the step.
    const field = /^nodes\[\d+\]\.(id|params\.[A-Za-z0-9_]+)/.exec(path ?? '')?.[1];
    if (field) {
      setShowInspector(true);
      setTimeout(() => {
        const row = document.querySelector<HTMLElement>(`.fl-insp [data-field="${field}"]`);
        if (!row) return;
        row.scrollIntoView({ block: 'nearest' });
        row.querySelector<HTMLElement>('input, textarea, select, button')?.focus({ preventScroll: true });
      }, 60);
    }
  }, []);

  const issuesByNode = useMemo(() => {
    const m = new Map<string, { errors: number; warnings: number }>();
    for (const i of doc.issues) {
      if (!i.nodeId) continue;
      const c = m.get(i.nodeId) ?? { errors: 0, warnings: 0 };
      if (i.level === 'error') c.errors++;
      else c.warnings++;
      m.set(i.nodeId, c);
    }
    return m;
  }, [doc.issues]);
  const errorCount = doc.issues.filter((i) => i.level === 'error').length;
  const warnCount = doc.issues.length - errorCount;

  /* ── templates ── */
  const envs = useEnvironments();
  const envKeys = useMemo(() => [...new Set((envs?.environments ?? []).flatMap((e) => e.vars.map((v) => v.key)))].sort(), [envs]);
  const outputs = useMemo(() => lastOutputs(overlayRun), [overlayRun]);
  const scopeNode = single?.id;
  const templateScope = useMemo<TemplateScopeValue>(
    () => ({ suggestions: () => (flow ? templateSuggestions({ flow, nodeId: scopeNode, envKeys, lastOutputs: outputs }) : []) }),
    [flow, scopeNode, envKeys, outputs],
  );
  const usedKeys = useMemo(() => usedEnvKeys(flow), [flow]);

  /* ── run target + preflight ── */
  const [target, setTarget] = useRunTarget(flow);
  const req = useMemo(() => runRequest(target, undefined), [target]);
  const { preflight, loading: pfLoading } = usePreflight(flowId, req, `${summary?.updatedAt ?? 0}|${envs?.activeId ?? ''}`, active && !!flow);

  /* ── edits ── */
  const apply = doc.apply;
  const addStep = useCallback(
    (type: string, request: QuickAddRequest) => {
      if (!doc.flow) return;
      const { id } = placeStep(doc.flow, type, request);
      apply((f) => placeStep(f, type, request).flow);
      setSelection({ nodes: new Set([id]), edges: new Set() });
      // A step placed next to its predecessor can land outside the visible canvas: bring it into view, and give
      // the canvas the keyboard (Delete, arrows act on the new step).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          canvasApi.current?.center(id);
          canvasApi.current?.focus();
        }),
      );
    },
    [doc.flow, apply],
  );
  const openPickerAtCenter = useCallback(
    (client?: { x: number; y: number }) => {
      if (!flow) return;
      const c = canvasApi.current?.visibleCenter() ?? { x: 0, y: 0 };
      const rect = wrapRef.current?.getBoundingClientRect();
      const at = client ?? (rect ? { x: rect.left + rect.width / 2 - 160, y: rect.top + 80 } : { x: 200, y: 120 });
      const after = single ? (sidePorts(single.type).length ? { nodeId: single.id, port: continuePort(single.type)! } : undefined) : openTail(flow);
      setPicker(after ? { client: at, after } : { client: at, at: { x: c.x - NODE_W / 2, y: c.y - NODE_H / 2 } });
    },
    [flow, single],
  );
  /* The edit commands take what they act on: a context menu acts on the step it was opened on, not on what the
     selection was when the menu was built. */
  const deleteItems = useCallback(
    (target: Selection, bridged = false) => {
      if (!flow) return;
      const nodes = new Set([...target.nodes].filter((id) => flowNodeSpec(flow.nodes.find((n) => n.id === id)?.type ?? '')?.group !== 'trigger' || flow.nodes.filter((n) => n.type.startsWith('trigger.')).length > 1));
      const blocked = target.nodes.size - nodes.size;
      if (!nodes.size && !target.edges.size) {
        if (blocked) toast.info(t('flows.edit.lastTrigger'));
        return;
      }
      // A deleted step takes the focus with it; keep the keyboard on the canvas.
      const el = document.activeElement;
      if (el && el !== document.body && wrapRef.current?.contains(el)) canvasApi.current?.focus();
      apply((f) => {
        let next = target.edges.size ? removeEdges(f, target.edges) : f;
        if (nodes.size) next = bridged ? removeNodesBridged(next, nodes) : removeNodes(next, nodes);
        return next;
      });
      setSelection(EMPTY_SELECTION);
      if (blocked) toast.info(t('flows.edit.lastTrigger'));
    },
    [flow, apply, t],
  );
  const deleteSelection = useCallback((bridged = false) => deleteItems(liveSelection, bridged), [deleteItems, liveSelection]);
  const copyItems = useCallback(
    (ids: ReadonlySet<string>): NodeClipboard | null => {
      if (!flow || !ids.size) return null;
      clipboard = copyNodes(flow, ids);
      return clipboard;
    },
    [flow],
  );
  const copySelection = useCallback(() => copyItems(liveSelection.nodes), [copyItems, liveSelection]);
  const paste = useCallback(
    (clip: NodeClipboard, at?: { x: number; y: number }) => {
      if (!doc.flow) return;
      let offset = { x: 40, y: 40 };
      if (at && clip.nodes.length) {
        const minX = Math.min(...clip.nodes.map((n) => nodePos(n).x));
        const minY = Math.min(...clip.nodes.map((n) => nodePos(n).y));
        offset = { x: at.x - minX, y: at.y - minY };
      }
      const { ids } = pasteNodes(doc.flow, clip, offset);
      apply((f) => pasteNodes(f, clip, offset).flow);
      setSelection({ nodes: new Set(ids), edges: new Set() });
    },
    [doc.flow, apply],
  );
  const duplicateItems = useCallback(
    (ids: ReadonlySet<string>) => {
      const clip = copyItems(ids);
      if (clip) paste(clip);
    },
    [copyItems, paste],
  );
  const duplicateSelection = useCallback(() => duplicateItems(liveSelection.nodes), [duplicateItems, liveSelection]);
  const toggleItems = useCallback(
    (ids: ReadonlySet<string>) => {
      const nodes = flow ? flow.nodes.filter((n) => ids.has(n.id)) : [];
      if (!nodes.length) return;
      const disable = nodes.some((n) => !n.disabled);
      apply((f) => nodes.reduce((acc, n) => updateNode(acc, n.id, (x) => (disable ? { ...x, disabled: true } : (({ disabled: _d, ...rest }) => rest)(x))), f));
    },
    [flow, apply],
  );
  const toggleDisabled = useCallback(() => toggleItems(liveSelection.nodes), [toggleItems, liveSelection]);
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!flow || !selectedNodes.length) return;
      const m = new Map(selectedNodes.map((n) => [n.id, { x: nodePos(n).x + dx, y: nodePos(n).y + dy }]));
      apply((f) => moveNodes(f, m), { coalesce: 'nudge' });
    },
    [flow, selectedNodes, apply],
  );
  const tidy = useCallback(() => {
    apply((f) => tidyUp(f));
    requestAnimationFrame(() => canvasApi.current?.fit());
  }, [apply]);

  /* ── flows: create, open, delete ── */
  /** Leaving a flow whose last save failed asks first (its edits are kept and saved again in the background). */
  const leaveOk = useCallback(async (): Promise<boolean> => {
    if (doc.save !== 'error' || !flow) return true;
    return confirm({ title: t('flows.save.leaveTitle'), message: t('flows.save.leaveMessage', { name: flow.name }), confirmLabel: t('flows.save.leaveConfirm') });
  }, [doc.save, flow, t]);
  const switchTo = useCallback(
    async (id: string) => {
      if (id === selectedId || !(await leaveOk())) return false;
      setSelectedId(id);
      return true;
    },
    [selectedId, leaveOk, setSelectedId],
  );
  const open = useCallback((id: string) => void switchTo(id), [switchTo]);
  const createBlank = useCallback(async () => {
    if (!(await leaveOk())) return;
    try {
      const r = await api.createFlow({
        format: FLOW_FORMAT,
        version: FLOW_VERSION,
        name: freeName(t('flows.list.untitled'), summaries.map((f) => f.name)),
        nodes: [{ id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } }],
        edges: [],
      });
      setSelectedId(r.flow.id);
      setFocusName(r.flow.id);
    } catch (err) {
      toast.error(t('flows.new.failed'), { description: flowErrorText(err) });
    }
  }, [leaveOk, setSelectedId, summaries, t]);
  const importFromFile = useCallback(async () => {
    const files = await pickFiles({ accept: FLOW_FILE_ACCEPT, multiple: true });
    if (!files.length) return;
    const { pkg, texts } = await readPicked(files);
    if (pkg) {
      transfer.openImport(pkg.text, pkg.name);
      if (texts.length) toast.info(t('flows.import.packageAlone'));
      return;
    }
    setDialog({ kind: 'import', text: texts.length === 1 ? texts[0]! : `[${texts.map((x) => x.trim()).join(',\n')}]` });
  }, [t]);
  const onNew = useCallback(
    (kind: NewFlowKind) => {
      if (kind === 'blank') void createBlank();
      else if (kind === 'requests') setDialog({ kind: 'requests' });
      else if (kind === 'ai') setDialog({ kind: 'ai', flowId: null });
      else void importFromFile();
    },
    [createBlank, importFromFile],
  );
  const duplicateFlow = useCallback(
    async (id: string) => {
      try {
        if (id === flowId) await doc.flush();
        const r = await api.duplicateFlow(id);
        setSelectedId(r.flow.id);
        toast.success(t('flows.list.duplicated', { name: r.flow.name }));
      } catch (err) {
        toast.error(t('flows.list.duplicateFailed'), { description: flowErrorText(err) });
      }
    },
    [flowId, doc, setSelectedId, t],
  );
  const exportFlow = useCallback(
    async (id: string) => {
      let exportId = id;
      if (id === flowId) {
        try {
          // The file is what the server has: save the latest edits first (a rename changes the id).
          exportId = (await doc.flush()) ?? id;
        } catch (err) {
          toast.error(t('flows.save.failed'), { description: flowErrorText(err) });
          return;
        }
      }
      downloadUrl(api.flowExportUrl(exportId), `${exportId}.durbun-flow.json`);
    },
    [flowId, doc, t],
  );
  const deleteFlow = useCallback(
    async (id: string) => {
      const f = summaries.find((x) => x.id === id);
      if (!f) return;
      const callers = summaries.filter((x) => x.calls.includes(id)).map((x) => x.name);
      const ok = await confirm({
        title: t('flows.list.deleteTitle', { name: f.name }),
        message: callers.length ? t('flows.list.deleteUsed', { names: callers.join(', ') }) : t('flows.list.deleteMessage'),
        confirmLabel: t('flows.list.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteFlow(id);
        if (id === selectedId) setSelectedId(null);
        toast.success(t('flows.list.deleted', { name: f.name }));
      } catch (err) {
        toast.error(t('flows.list.deleteFailed'), { description: flowErrorText(err) });
      }
    },
    [summaries, selectedId, setSelectedId, t],
  );

  /* ── running ── */
  const startRun = useCallback(
    async (id: string, inputs: Record<string, unknown>, startNodeId?: string) => {
      try {
        const run = await api.runFlow(id, runRequest(target, undefined, { inputs, ...(startNodeId ? { startNodeId } : {}) }));
        rememberFlowRun(run);
        setPanel({ runId: run.id, open: true });
      } catch (err) {
        const pf = err instanceof ApiError && err.status === 409 ? (err.body?.preflight as FlowPreflight | undefined) : undefined;
        if (pf) setRunDialog({ preflight: pf, ...(startNodeId ? { startNodeId } : {}) });
        else toast.error(t('flows.run.failed'), { description: flowErrorText(err) });
      }
    },
    [target, t],
  );
  const requestRun = useCallback(
    async (startNodeId?: string) => {
      if (!flow || busy || liveRun) return;
      setBusy(true);
      try {
        let id: string | null;
        try {
          id = await doc.flush();
        } catch (err) {
          toast.error(t('flows.save.failed'), { description: flowErrorText(err) });
          return;
        }
        if (!id) {
          toast.error(t('flows.save.failed'), { description: flowErrorText(doc.saveError) });
          return;
        }
        const pf = await api.preflightFlow(id, runRequest(target, undefined, startNodeId ? { startNodeId } : {}));
        const blocking = !pf.ok || pf.issues.some((i) => i.level === 'error');
        if (blocking || pf.irreversible.length || flow.inputs?.length) {
          setRunDialog({ preflight: pf, ...(startNodeId ? { startNodeId } : {}) });
          return;
        }
        await startRun(id, {}, startNodeId);
      } catch (err) {
        toast.error(t('flows.run.failed'), { description: flowErrorText(err) });
      } finally {
        setBusy(false);
      }
    },
    [flow, busy, liveRun, doc, target, startRun, t],
  );
  const stopRun = useCallback(async () => {
    if (!liveRun) return;
    try {
      await api.cancelFlowRun(liveRun.id);
    } catch (err) {
      toast.error(t('flows.run.stopFailed'), { description: flowErrorText(err) });
    }
  }, [liveRun, t]);
  const runFromList = useCallback(
    (id: string) => {
      if (id === flowId) void requestRun();
      else {
        pendingRun.current = id;
        void switchTo(id).then((ok) => {
          if (!ok) pendingRun.current = null;
        });
      }
    },
    [flowId, requestRun, switchTo],
  );
  useEffect(() => {
    if (flowId && pendingRun.current === flowId) {
      pendingRun.current = null;
      void requestRun();
    }
  }, [flowId, requestRun]);

  const dimmed = useMemo(() => {
    if (!flow || !runDialog?.startNodeId) return undefined;
    const keep = downstream(flow, runDialog.startNodeId);
    keep.add(runDialog.startNodeId);
    return new Set(flow.nodes.filter((n) => !keep.has(n.id)).map((n) => n.id));
  }, [flow, runDialog]);

  /* ── keyboard + clipboard ── */
  // Only the canvas itself (or a step on it): focus that fell back to the page after a click on plain text in the
  // inspector must not let Backspace delete the selected step.
  const canvasFocused = () => {
    const el = document.activeElement;
    return !!el && el !== document.body && !!wrapRef.current?.contains(el);
  };
  const kb = active && !!flow && !dialog && !runDialog && !picker;
  const onCanvas = (fn: () => void) => () => {
    if (canvasFocused()) fn();
  };
  useShortcut(['Delete', 'Backspace'], onCanvas(() => deleteSelection()), { enabled: kb && (liveSelection.nodes.size > 0 || liveSelection.edges.size > 0) });
  useShortcut(['Shift+Delete', 'Shift+Backspace'], onCanvas(() => deleteSelection(true)), { enabled: kb && liveSelection.nodes.size > 0 });
  useShortcut('Mod+A', onCanvas(() => flow && setSelection({ nodes: new Set(flow.nodes.map((n) => n.id)), edges: new Set() })), { enabled: kb, allowInInputs: false });
  useShortcut('Mod+D', onCanvas(duplicateSelection), { enabled: kb && liveSelection.nodes.size > 0, allowInInputs: false });
  useShortcut('Mod+Z', () => doc.undo(), { enabled: kb && doc.canUndo, allowInInputs: false });
  useShortcut(['Shift+Mod+Z', 'Mod+Y'], () => doc.redo(), { enabled: kb && doc.canRedo, allowInInputs: false });
  useShortcut('ArrowLeft', onCanvas(() => nudge(-GRID, 0)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('ArrowRight', onCanvas(() => nudge(GRID, 0)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('ArrowUp', onCanvas(() => nudge(0, -GRID)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('ArrowDown', onCanvas(() => nudge(0, GRID)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('Shift+ArrowLeft', onCanvas(() => nudge(-GRID * 5, 0)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('Shift+ArrowRight', onCanvas(() => nudge(GRID * 5, 0)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('Shift+ArrowUp', onCanvas(() => nudge(0, -GRID * 5)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('Shift+ArrowDown', onCanvas(() => nudge(0, GRID * 5)), { enabled: kb && selectedNodes.length > 0, allowRepeat: true });
  useShortcut('F', () => canvasApi.current?.fit(), { enabled: kb });
  useShortcut('A', onCanvas(() => openPickerAtCenter()), { enabled: kb });
  useShortcut('Shift+Mod+L', tidy, { enabled: kb, allowInInputs: false });
  useShortcut('Mod+Enter', () => void (liveRun ? stopRun() : requestRun()), { enabled: active && !!flow && !dialog && !runDialog });
  useShortcut('Escape', () => setSelection(EMPTY_SELECTION), { enabled: kb && (liveSelection.nodes.size > 0 || liveSelection.edges.size > 0), allowInInputs: false, priority: -1 });

  const clipboardState = useRef({ kb, copySelection, paste, deleteSelection, hasSelection: false });
  clipboardState.current = { kb, copySelection, paste, deleteSelection, hasSelection: liveSelection.nodes.size > 0 };
  useEffect(() => {
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      const s = clipboardState.current;
      if (!s.kb || !s.hasSelection || isEditable(document.activeElement) || !canvasFocused()) return;
      const clip = s.copySelection();
      if (!clip) return;
      e.clipboardData?.setData('text/plain', JSON.stringify(clip, null, 2));
      e.preventDefault();
      if (cut) s.deleteSelection();
    };
    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    const pasteEv = (e: ClipboardEvent) => {
      const s = clipboardState.current;
      if (!active || modalOpen() || isEditable(document.activeElement) || (s.kb && !canvasFocused())) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      const clip = parseClipboard(text);
      if (clip && s.kb) {
        e.preventDefault();
        s.paste(clip);
      } else if (looksLikeFlowText(text) && !dialogRef.current && !runDialogRef.current) {
        e.preventDefault();
        setDialog({ kind: 'import', text });
      }
    };
    document.addEventListener('copy', copy);
    document.addEventListener('cut', cut);
    document.addEventListener('paste', pasteEv);
    return () => {
      document.removeEventListener('copy', copy);
      document.removeEventListener('cut', cut);
      document.removeEventListener('paste', pasteEv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const runDialogRef = useRef(runDialog);
  runDialogRef.current = runDialog;

  /* ── context menus ── */
  const onContextMenu = useCallback(
    (e: { clientX: number; clientY: number; nodeId?: string; edge?: string; at: { x: number; y: number } }) => {
      if (!flow) return;
      const items: MenuItem[] = [];
      if (e.nodeId) {
        const node = flow.nodes.find((n) => n.id === e.nodeId);
        if (!node) return;
        if (!liveSelection.nodes.has(node.id)) setSelection({ nodes: new Set([node.id]), edges: new Set() });
        const many = liveSelection.nodes.has(node.id) && liveSelection.nodes.size > 1;
        // What the commands act on, fixed now: the selection this menu was built with may be an older one.
        const ids: ReadonlySet<string> = many ? new Set(liveSelection.nodes) : new Set([node.id]);
        const target: Selection = { nodes: ids, edges: new Set() };
        const isTrigger = node.type.startsWith('trigger.');
        if (!many && !isTrigger) items.push({ label: t('flows.edit.runFromHere'), icon: Play, disabled: !!liveRun, onSelect: () => void requestRun(node.id) });
        if (!many && node.type === 'flow.call' && typeof node.params?.flowId === 'string' && node.params.flowId) {
          const target = node.params.flowId;
          items.push({ label: t('flows.edit.openSubflow'), icon: Workflow, onSelect: () => open(target) });
        }
        if (items.length) items.push({ type: 'separator' });
        items.push(
          { label: t('flows.edit.duplicate'), icon: Copy, shortcut: 'Mod+D', onSelect: () => duplicateItems(ids) },
          { label: t('flows.edit.copy'), icon: Copy, shortcut: 'Mod+C', onSelect: () => void copyItems(ids) },
          { label: t('flows.edit.cut'), icon: Scissors, shortcut: 'Mod+X', onSelect: () => copyItems(ids) && deleteItems(target) },
          { label: (many ? flow.nodes.filter((n) => ids.has(n.id)).some((n) => !n.disabled) : !node.disabled) ? t('flows.edit.disable') : t('flows.edit.enable'), icon: Power, onSelect: () => toggleItems(ids) },
          { type: 'separator' },
          { label: t('flows.edit.deleteBridged'), icon: Trash, shortcut: 'Shift+Delete', onSelect: () => deleteItems(target, true) },
          { label: many ? t('flows.edit.deleteMany', { count: ids.size }) : t('flows.edit.delete'), icon: Trash, shortcut: 'Delete', danger: true, onSelect: () => deleteItems(target) },
        );
      } else if (e.edge) {
        const key = e.edge;
        setSelection({ nodes: new Set(), edges: new Set([key]) });
        items.push(
          { label: t('flows.edge.insert'), icon: Plus, onSelect: () => setPicker({ client: { x: e.clientX, y: e.clientY }, at: { x: e.at.x - NODE_W / 2, y: e.at.y - NODE_H / 2 }, insertEdge: key }) },
          { label: t('flows.edge.delete'), icon: Trash, danger: true, onSelect: () => apply((f) => removeEdges(f, new Set([key]))) },
        );
      } else {
        items.push(
          { label: t('flows.edit.addHere'), icon: Plus, shortcut: 'A', onSelect: () => setPicker({ client: { x: e.clientX, y: e.clientY }, at: { x: e.at.x - NODE_W / 2, y: e.at.y - NODE_H / 2 } }) },
          { label: t('flows.edit.paste'), icon: ClipboardPaste, shortcut: 'Mod+V', disabled: !clipboard, onSelect: () => clipboard && paste(clipboard, e.at) },
          { type: 'separator' },
          { label: t('flows.edit.selectAll'), icon: SquareDashedMousePointer, shortcut: 'Mod+A', onSelect: () => setSelection({ nodes: new Set(flow.nodes.map((n) => n.id)), edges: new Set() }) },
          { label: t('flows.edit.tidy'), icon: LayoutGrid, shortcut: 'Shift+Mod+L', onSelect: tidy },
          { label: t('flows.canvas.fit'), icon: Maximize2, shortcut: 'F', onSelect: () => canvasApi.current?.fit() },
        );
      }
      openContextMenu({ x: e.clientX, y: e.clientY }, items);
    },
    [flow, liveSelection, liveRun, requestRun, open, duplicateItems, copyItems, deleteItems, toggleItems, apply, paste, tidy, t],
  );
  const onNodeOpen = useCallback(
    (id: string) => {
      const node = flow?.nodes.find((n) => n.id === id);
      if (node?.type === 'flow.call' && typeof node.params?.flowId === 'string' && node.params.flowId) open(node.params.flowId);
      else setShowInspector(true);
    },
    [flow, open, setShowInspector],
  );

  /* ── palette ── */
  const group = t('common.groups.flows');
  useCommands([
    { id: 'flows.new', title: t('flows.commands.new'), group, icon: Plus, keywords: ['flow', 'akış', 'new', 'yeni', 'graph'], run: () => void createBlank() },
    { id: 'flows.fromRequests', title: t('flows.commands.fromRequests'), group, icon: ListPlus, keywords: ['flow', 'akış', 'request', 'istek', 'network'], run: () => setDialog({ kind: 'requests' }) },
    { id: 'flows.ai', title: t('flows.commands.ai'), group, icon: Sparkles, keywords: ['ai', 'yapay zeka', 'prompt', 'chatgpt', 'claude', 'flow'], run: () => setDialog({ kind: 'ai', flowId }) },
    { id: 'flows.import', title: t('flows.commands.import'), group, icon: FileUp, keywords: ['import', 'içe aktar', 'flow', 'akış', 'json'], run: () => void importFromFile() },
    { id: 'flows.environments', title: t('flows.commands.environments'), group, icon: Globe, keywords: ['env', 'ortam', 'environment', 'variables', 'değişken'], run: () => setDialog({ kind: 'env' }) },
    ...(flow
      ? [
          { id: 'flows.run', title: t('flows.commands.run', { name: flow.name }), group, icon: Play, shortcut: 'Mod+Enter', keywords: ['run', 'çalıştır', 'start', 'başlat'], run: () => void requestRun(), disabled: !!liveRun },
          { id: 'flows.tidy', title: t('flows.commands.tidy'), group, icon: LayoutGrid, shortcut: 'Shift+Mod+L', keywords: ['layout', 'düzenle', 'tidy', 'hizala'], run: tidy },
          { id: 'flows.export', title: t('flows.commands.export', { name: flow.name }), group, icon: FileDown, keywords: ['export', 'dışa aktar', 'json'], run: () => void exportFlow(flow.id) },
        ]
      : []),
  ]);

  /* ── render ── */
  const empty = loaded && summaries.length === 0 && !selectedId;
  return (
    <div className="fl fill">
      <SplitPane id="flows.list" sizedPane="first" defaultSize={260} minSize={200} maxSize={420} overlayBelow={0} className="fl-split">
        <FlowList
          summaries={summaries}
          loaded={loaded}
          selectedId={selectedId}
          active={active && !dialog}
          onOpen={open}
          onNew={onNew}
          onRun={runFromList}
          onDuplicate={(id) => void duplicateFlow(id)}
          onExport={(id) => void exportFlow(id)}
          onAi={(id) => setDialog({ kind: 'ai', flowId: id })}
          onDelete={(id) => void deleteFlow(id)}
        />
        <div className="fl-main">
          {empty ? (
            <Welcome onNew={onNew} />
          ) : !selectedId ? (
            <EmptyState size="lg" icon={Workflow} title={t('flows.empty.pickTitle')} description={t('flows.empty.pickHint')} />
          ) : doc.status === 'loading' ? (
            <div className="fl-main__loading">
              <Spinner size={18} />
            </div>
          ) : doc.status === 'error' || !flow ? (
            <EmptyState
              size="md"
              tone="danger"
              icon={CircleAlert}
              title={t('flows.empty.loadFailed')}
              description={flowErrorText(doc.error)}
              actions={
                <Button variant="secondary" onClick={doc.reload}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : (
            <TemplateScope.Provider value={templateScope}>
              <EditorHeader
                flow={flow}
                doc={doc}
                focusName={focusName === flow.id}
                onNameFocused={() => setFocusName(null)}
                errors={errorCount}
                warnings={warnCount}
                onShowIssues={() => {
                  setSelection(EMPTY_SELECTION);
                  setShowInspector(true);
                }}
                runBar={
                  <>
                    <TargetPicker flow={flow} target={target} onChange={setTarget} preflight={preflight} />
                    <EnvPicker onManage={() => setDialog({ kind: 'env' })} />
                    <PreflightChip preflight={preflight} loading={pfLoading} flow={flow} />
                    <RunButton running={!!liveRun} busy={busy} onRun={() => void requestRun()} onStop={() => void stopRun()} />
                  </>
                }
                moreItems={(): MenuItem[] => [
                  { label: t('flows.more.ai'), icon: Sparkles, onSelect: () => setDialog({ kind: 'ai', flowId: flow.id }) },
                  { label: t('flows.more.export'), icon: FileDown, onSelect: () => void exportFlow(flow.id) },
                  { label: t('flows.more.share'), icon: Share2, onSelect: () => transfer.openExport('share', [flow.id]) },
                  {
                    label: t('flows.more.copyJson'),
                    icon: Copy,
                    onSelect: async () => {
                      const { createdAt: _c, updatedAt: _u, ...rest } = flow;
                      if (await copyText(JSON.stringify(rest, null, 2))) toast.success(t('flows.more.jsonCopied'));
                      else toast.error(t('flows.more.copyFailed'));
                    },
                  },
                  { label: t('flows.more.duplicate'), icon: Copy, onSelect: () => void duplicateFlow(flow.id) },
                  { label: t('flows.more.environments'), icon: Globe, onSelect: () => setDialog({ kind: 'env' }) },
                  { type: 'separator' },
                  { label: t('flows.more.delete'), icon: Trash, danger: true, onSelect: () => void deleteFlow(flow.id) },
                ]}
                inspectorOpen={showInspector}
                onToggleInspector={() => setShowInspector((v) => !v)}
              />
              <SplitPane id="flows.inspector" sizedPane="second" defaultSize={320} minSize={280} maxSize={0.6} overlayBelow={760} collapsed={showInspector ? null : 'second'} onOverlayDismiss={() => setShowInspector(false)} className="fl-split">
                <SplitPane id="flows.runPanel" direction="vertical" sizedPane="second" defaultSize={260} minSize={140} maxSize={0.7} collapsed={panel.open && panel.runId ? null : 'second'} className="fl-split">
                  <div className="fl-stage" ref={wrapRef}>
                    <Canvas
                      flow={flow}
                      selection={liveSelection}
                      onSelection={setSelection}
                      onEdit={apply}
                      issuesByNode={issuesByNode}
                      overlay={overlay}
                      dimmed={dimmed}
                      onQuickAdd={setPicker}
                      onNodeOpen={onNodeOpen}
                      onContextMenu={onContextMenu}
                      viewKey={flow.id}
                      showMinimap={showMinimap}
                      apiRef={canvasApi}
                      onViewportChange={(v) => setZoom(Math.round(v.zoom * 100))}
                    />
                    <div className="fl-ui fl-palette" role="toolbar" aria-label={t('flows.canvas.tools')}>
                      <Tooltip content={t('flows.canvas.addStep')} shortcut="A">
                        <Button size="sm" variant="secondary" icon={Plus} onClick={(e) => openPickerAtCenter({ x: e.clientX, y: e.clientY + 16 })}>
                          {t('flows.canvas.add')}
                        </Button>
                      </Tooltip>
                      <span className="fl-palette__sep" />
                      <IconButton icon={Undo2} label={t('flows.canvas.undo')} shortcut="Mod+Z" disabled={!doc.canUndo} onClick={doc.undo} />
                      <IconButton icon={Redo2} label={t('flows.canvas.redo')} shortcut="Shift+Mod+Z" disabled={!doc.canRedo} onClick={doc.redo} />
                      <span className="fl-palette__sep" />
                      <IconButton icon={LayoutGrid} label={t('flows.edit.tidy')} shortcut="Shift+Mod+L" onClick={tidy} disabled={flow.nodes.length < 2} />
                    </div>
                    <div className="fl-ui fl-zoombar" role="toolbar" aria-label={t('flows.canvas.zoom')}>
                      <IconButton icon={Minus} label={t('flows.canvas.zoomOut')} onClick={() => canvasApi.current?.zoomBy(1 / 1.2)} />
                      <button type="button" className="fl-zoombar__value tnum" onClick={() => canvasApi.current?.zoomTo(1)} title={t('flows.canvas.zoomReset')}>
                        {zoom}%
                      </button>
                      <IconButton icon={Plus} label={t('flows.canvas.zoomIn')} onClick={() => canvasApi.current?.zoomBy(1.2)} />
                      <IconButton icon={Maximize2} label={t('flows.canvas.fit')} shortcut="F" onClick={() => canvasApi.current?.fit()} />
                      <IconButton icon={MapIcon} label={t('flows.canvas.minimap')} active={showMinimap} onClick={() => setShowMinimap((v) => !v)} />
                    </div>
                    {flow.nodes.length <= 1 ? <div className="fl-ui fl-stage__hint">{t('flows.canvas.startHint')}</div> : null}
                  </div>
                  {panel.open && panel.runId ? (
                    <RunPanel
                      flow={flow}
                      runId={panel.runId}
                      onRunId={(id) => setPanel({ runId: id, open: !!id })}
                      onSelectNode={selectNode}
                      onRerun={() => void requestRun()}
                      onPickTarget={() => document.querySelector<HTMLButtonElement>('.fl-header [data-picker="target"]')?.click()}
                      onManageEnvironments={() => setDialog({ kind: 'env' })}
                      // Closed, the canvas and "last run" follow the newest run again, not the one shown here.
                      onClose={() => setPanel({ runId: null, open: false })}
                    />
                  ) : (
                    <span />
                  )}
                </SplitPane>
                {showInspector ? (
                  <aside className="fl-inspector" aria-label={t('flows.inspector.label')}>
                    {single ? (
                      <NodeInspector
                        key={single.id}
                        flow={flow}
                        node={single}
                        issues={doc.issues.filter((i) => i.nodeId === single.id)}
                        lastStep={stepsByNode.get(single.id)}
                        flows={summaries}
                        apply={apply}
                        onRenamed={(_from, to) => setSelection({ nodes: new Set([to]), edges: new Set() })}
                        onDelete={() => deleteSelection()}
                        onDuplicate={duplicateSelection}
                        onRunFromHere={() => void requestRun(single.id)}
                        runFromHereBlocked={single.type.startsWith('trigger.') ? 'trigger' : liveRun ? 'running' : undefined}
                        onOpenFlow={open}
                      />
                    ) : selectedNodes.length > 1 ? (
                      <SelectionPanel
                        names={selectedNodes.map((n) => nodeName(n, lang))}
                        anyEnabled={selectedNodes.some((n) => !n.disabled)}
                        onDuplicate={duplicateSelection}
                        onToggle={toggleDisabled}
                        onDelete={() => deleteSelection()}
                        onClear={() => setSelection(EMPTY_SELECTION)}
                      />
                    ) : (
                      <FlowSettings flow={flow} issues={doc.issues} flows={summaries} apply={apply} onSelectNode={selectNode} />
                    )}
                  </aside>
                ) : (
                  <span />
                )}
              </SplitPane>
              {!panel.open && overlayRun ? (
                <button type="button" className={clsx('fl-ui fl-lastrun', `is-${overlayRun.status}`)} onClick={() => setPanel({ runId: overlayRun.id, open: true })}>
                  {overlayRun.status === 'running' ? <Spinner size={12} /> : overlayRun.status === 'passed' ? <CircleCheck size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
                  {t('flows.runPanel.show', { status: t(`flows.status.${overlayRun.status}`) })}
                </button>
              ) : null}
              <NodePicker
                open={!!picker}
                at={picker?.client ?? null}
                hideTriggers={!!(picker?.after || picker?.insertEdge)}
                onPick={(type) => {
                  const r = picker;
                  setPicker(null);
                  if (r) addStep(type, r);
                }}
                onClose={() => setPicker(null)}
              />
              <RunDialog
                open={!!runDialog}
                flow={flow}
                state={runDialog}
                initialInputs={lastInputs.get(flow.id) ?? {}}
                onClose={() => setRunDialog(null)}
                onRun={(inputs) => {
                  const start = runDialog?.startNodeId;
                  lastInputs.set(
                    flow.id,
                    Object.fromEntries(Object.entries(inputs).filter(([k]) => !flow.inputs?.find((d) => d.name === k)?.secret).map(([k, v]) => [k, String(v)])),
                  );
                  setRunDialog(null);
                  void startRun(flow.id, inputs, start);
                }}
              />
            </TemplateScope.Provider>
          )}
        </div>
      </SplitPane>
      <EnvironmentsDialog open={dialog?.kind === 'env'} onClose={() => setDialog(null)} usedKeys={usedKeys} />
      <ImportFlowsDialog
        open={dialog?.kind === 'import'}
        text={dialog?.kind === 'import' ? dialog.text : null}
        onClose={() => setDialog(null)}
        onImported={(ids) => {
          setDialog(null);
          if (ids[0]) void switchTo(ids[0]);
        }}
      />
      <AiPackDialog
        open={dialog?.kind === 'ai'}
        flowId={dialog?.kind === 'ai' ? dialog.flowId : null}
        onClose={() => setDialog(null)}
        onImported={(ids) => {
          setDialog(null);
          if (ids[0]) void switchTo(ids[0]);
        }}
      />
      <FromRequestsDialog
        open={dialog?.kind === 'requests'}
        initialIds={dialog?.kind === 'requests' ? dialog.ids : undefined}
        onClose={() => setDialog(null)}
        onCreated={(id) => {
          setDialog(null);
          void switchTo(id);
        }}
      />
    </div>
  );
}

/* ───────────── header ───────────── */

function EditorHeader({
  flow,
  doc,
  focusName,
  onNameFocused,
  errors,
  warnings,
  onShowIssues,
  runBar,
  moreItems,
  inspectorOpen,
  onToggleInspector,
}: {
  flow: FlowDoc;
  doc: FlowDocument;
  focusName: boolean;
  onNameFocused(): void;
  errors: number;
  warnings: number;
  onShowIssues(): void;
  runBar: ReactNode;
  moreItems(): MenuItem[];
  inspectorOpen: boolean;
  onToggleInspector(): void;
}) {
  const t = useT();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!focusName) return;
    const el = nameRef.current;
    if (el) {
      el.focus();
      el.select();
    }
    onNameFocused();
  }, [focusName, onNameFocused]);
  const commit = () => {
    if (draft === null) return;
    const name = draft.trim();
    setDraft(null);
    if (name && name !== flow.name) doc.apply((f) => ({ ...f, name }));
  };
  return (
    <div className="fl-header">
      <input
        ref={nameRef}
        className="fl-header__name"
        value={draft ?? flow.name}
        aria-label={t('flows.header.name')}
        spellCheck={false}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{ width: `${Math.min(40, Math.max(8, (draft ?? flow.name).length + 2))}ch` }}
      />
      <SaveState doc={doc} />
      {errors || warnings ? (
        <button type="button" className={clsx('fl-issues-chip', errors ? 'is-error' : 'is-warn')} onClick={onShowIssues}>
          <CircleAlert size={13} aria-hidden />
          {errors ? t('flows.header.errors', { count: errors }) : t('flows.header.warnings', { count: warnings })}
        </button>
      ) : null}
      <span className="grow" />
      <div className="fl-runbar">{runBar}</div>
      <DropdownMenu items={moreItems} minWidth={240} align="end" aria-label={t('flows.more.label')}>
        {(p) => <IconButton icon={Ellipsis} label={t('flows.more.label')} {...p} />}
      </DropdownMenu>
      <IconButton icon={PanelRight} label={inspectorOpen ? t('flows.header.hideInspector') : t('flows.header.showInspector')} active={inspectorOpen} onClick={onToggleInspector} />
    </div>
  );
}

function SaveState({ doc }: { doc: FlowDocument }) {
  const t = useT();
  if (doc.save === 'error') {
    return (
      <span className="fl-save is-error" role="status">
        <CircleAlert size={13} aria-hidden />
        <Tooltip content={flowErrorText(doc.saveError)}>
          <span>{t('flows.save.error')}</span>
        </Tooltip>
        <button type="button" className="fl-link" onClick={() => void doc.flush()}>
          {t('common.retry')}
        </button>
      </span>
    );
  }
  return (
    <span className={clsx('fl-save', doc.save !== 'saved' && 'is-pending')} role="status" aria-live="polite">
      {doc.save === 'saved' ? <CircleCheck size={13} aria-hidden /> : <Spinner size={11} />}
      <span className="fl-save__text">{doc.save === 'saved' ? t('flows.save.saved') : t('flows.save.saving')}</span>
    </span>
  );
}

/* ───────────── multi selection ───────────── */

function SelectionPanel({ names, anyEnabled, onDuplicate, onToggle, onDelete, onClear }: { names: string[]; anyEnabled: boolean; onDuplicate(): void; onToggle(): void; onDelete(): void; onClear(): void }) {
  const t = useT();
  return (
    <div className="fl-insp fl-multisel">
      <div className="fl-insp__head">
        <h2>{t('flows.selection.title', { count: names.length })}</h2>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t('flows.selection.clear')}
        </Button>
      </div>
      <ul className="fl-multisel__list">
        {names.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      <div className="fl-multisel__actions">
        <Button size="sm" variant="secondary" icon={Copy} onClick={onDuplicate}>
          {t('flows.edit.duplicate')}
        </Button>
        <Button size="sm" variant="secondary" icon={Power} onClick={onToggle}>
          {anyEnabled ? t('flows.edit.disable') : t('flows.edit.enable')}
        </Button>
        <Button size="sm" variant="danger" icon={Trash} onClick={onDelete}>
          {t('flows.edit.deleteMany', { count: names.length })}
        </Button>
      </div>
      <p className="fl-insp__hint">{t('flows.selection.hint')}</p>
    </div>
  );
}

/* ───────────── first visit ───────────── */

function Welcome({ onNew }: { onNew(kind: NewFlowKind): void }) {
  const t = useT();
  const items = newFlowMenu(t, onNew).filter((i) => i.type !== 'separator');
  return (
    <div className="fl-welcome">
      <EmptyState size="lg" tone="accent" icon={Workflow} title={t('flows.empty.title')} description={t('flows.empty.description')}>
        <div className="fl-welcome__cards">
          {items.map((i, n) => {
            const Icon = i.icon!;
            return (
              <button key={n} type="button" className="fl-welcome__card" onClick={i.onSelect}>
                <Icon size={18} aria-hidden />
                <span className="fl-welcome__title">{i.label}</span>
                <span className="fl-welcome__hint">{i.description}</span>
              </button>
            );
          })}
        </div>
        <ul className="fl-welcome__points">
          <li>{t('flows.empty.point1')}</li>
          <li>{t('flows.empty.point2')}</li>
          <li>{t('flows.empty.point3')}</li>
        </ul>
      </EmptyState>
    </div>
  );
}
