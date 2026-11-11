import { memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { clsx } from 'clsx';
import { Ban, CircleAlert, CircleCheck, CircleSlash, CircleX, Plus, Trash, TriangleAlert } from 'lucide-react';
import { flowNodeSpec, type FlowDoc, type FlowNode, type FlowPort, type FlowPosition, type FlowStepStatus } from '@durbun/protocol';
import { Spinner, Tooltip, useFeatureActive } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import {
  acceptsInput,
  boundsOf,
  connectProblem,
  edgeKey,
  edgeMidpoint,
  edgePath,
  ERROR_PORT_X,
  hasErrorPort,
  inputPoint,
  intersects,
  moveNodes,
  NODE_H,
  NODE_W,
  nodePos,
  nodeRect,
  portPoint,
  sidePorts,
  snap,
  connect,
  type Rect,
} from '../model/graph';
import { nodeIcon } from '../model/icons';
import { nodeSummary } from '../model/summary';
import { GROUP_COLOR, nodeDescription, nodeName } from '../model/text';

export interface Selection {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { nodes: new Set(), edges: new Set() };

export interface NodeRunState {
  status: FlowStepStatus;
  /** How many times the node ran in the run (repeat). */
  count: number;
  handled?: boolean;
  unsupported?: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface QuickAddRequest {
  /** Client coordinates for the popover. */
  client: { x: number; y: number };
  /** Where the node goes (canvas coordinates); without it a step added after a port goes next to that node. */
  at?: FlowPosition;
  after?: { nodeId: string; port: FlowPort };
  /** Insert the new node into this edge (edgeKey). */
  insertEdge?: string;
}

export interface CanvasApi {
  /** 'all' shows every node; 'readable' never zooms out past readable text and starts at the flow's start. */
  fit(mode?: 'all' | 'readable'): void;
  zoomBy(factor: number): void;
  zoomTo(zoom: number): void;
  /** Brings a node into view when it is not comfortably visible. */
  center(nodeId: string): void;
  /** Gives the canvas the keyboard (Delete, arrows, Space). */
  focus(): void;
  /** Center of the visible area in canvas coordinates. */
  visibleCenter(): FlowPosition;
  viewport(): Viewport;
}

export interface CanvasProps {
  flow: FlowDoc;
  selection: Selection;
  onSelection(sel: Selection): void;
  /** Commit an edit (one undo step). */
  onEdit(edit: (flow: FlowDoc) => FlowDoc): void;
  issuesByNode: ReadonlyMap<string, { errors: number; warnings: number }>;
  overlay?: ReadonlyMap<string, NodeRunState>;
  /** Nodes to dim (a run from here: what will not run). */
  dimmed?: ReadonlySet<string>;
  onQuickAdd(req: QuickAddRequest): void;
  onNodeOpen?(id: string): void;
  onContextMenu?(e: { clientX: number; clientY: number; nodeId?: string; edge?: string; at: FlowPosition }): void;
  /** Viewport memory key (the flow id). */
  viewKey: string;
  showMinimap: boolean;
  readOnly?: boolean;
  apiRef?: Ref<CanvasApi | null>;
  onViewportChange?(v: Viewport): void;
}

const MIN_ZOOM = 0.2;
/** Below this the card texts are too small to read. */
const READABLE_ZOOM = 0.7;
const MAX_ZOOM = 2;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Viewports of flows opened in this window. */
const viewports = new Map<string, Viewport>();

type Drag =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'nodes'; sx: number; sy: number; origins: Map<string, FlowPosition>; moved: boolean; clickedId: string; additive: boolean }
  | { kind: 'connect'; from: string; port: FlowPort; sx: number; sy: number }
  | { kind: 'marquee'; sx: number; sy: number; additive: boolean; base: Selection };

function isEditableTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable);
}

export const Canvas = memo(function Canvas(props: CanvasProps) {
  const { flow, selection, onSelection, onEdit, issuesByNode, overlay, dimmed, onQuickAdd, onNodeOpen, onContextMenu, viewKey, showMinimap, readOnly, apiRef, onViewportChange } = props;
  const t = useT();
  const lang = useLanguage();
  const featureActive = useFeatureActive();
  const uid = useId().replace(/:/g, '');
  const hintId = `${uid}-keys`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [vp, setVp] = useState<Viewport>(() => viewports.get(viewKey) ?? { x: 40, y: 40, zoom: 1 });
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const drag = useRef<Drag | null>(null);
  const [dragPos, setDragPos] = useState<Map<string, FlowPosition> | null>(null);
  const [wire, setWire] = useState<{ from: FlowPosition; to: FlowPosition; port: FlowPort; target?: string; bad?: boolean } | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [panning, setPanning] = useState(false);
  const [space, setSpace] = useState(false);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const selRef = useRef(selection);
  selRef.current = selection;

  /* ── size ── */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const setViewport = useCallback(
    (next: Viewport | ((v: Viewport) => Viewport)) => {
      setVp((v) => {
        const n = typeof next === 'function' ? next(v) : next;
        viewports.set(viewKey, n);
        return n;
      });
    },
    [viewKey],
  );

  useEffect(() => onViewportChange?.(vp), [vp, onViewportChange]);

  const fit = useCallback(
    (mode: 'all' | 'readable' = 'all') => {
      const el = rootRef.current;
      const b = boundsOf(flowRef.current.nodes);
      if (!el || !b) {
        setViewport({ x: 40, y: 40, zoom: 1 });
        return;
      }
      // The palette sits on top and the zoom bar and hint at the bottom: keep the nodes clear of both.
      const pad = 48;
      const top = 64;
      const bottom = 72;
      const w = el.clientWidth || 800;
      const h = el.clientHeight || 600;
      const zoom = clampZoom(Math.min((w - pad * 2) / Math.max(b.w, 1), (h - top - bottom) / Math.max(b.h, 1), 1.1));
      if (mode === 'readable' && zoom < READABLE_ZOOM) {
        // Too big to read whole: start where the flow starts (left, triggers) at a size the cards can be read.
        const z = READABLE_ZOOM;
        const fitsHeight = b.h * z <= h - top - bottom;
        setViewport({ zoom: z, x: pad - b.x * z, y: fitsHeight ? top + (h - top - bottom - b.h * z) / 2 - b.y * z : top - b.y * z });
        return;
      }
      setViewport({ zoom, x: (w - b.w * zoom) / 2 - b.x * zoom, y: top + (h - top - bottom - b.h * zoom) / 2 - b.y * zoom });
    },
    [setViewport],
  );

  // A flow opened for the first time in this window is fitted.
  const fitted = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (fitted.current === viewKey) return;
    fitted.current = viewKey;
    const saved = viewports.get(viewKey);
    if (saved) setVp(saved);
    else requestAnimationFrame(() => fit('readable'));
  }, [viewKey, fit]);

  const zoomAround = useCallback(
    (factor: number, cx: number, cy: number) => {
      setViewport((v) => {
        const zoom = clampZoom(v.zoom * factor);
        const k = zoom / v.zoom;
        return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    },
    [setViewport],
  );

  const center = useCallback(
    (nodeId: string) => {
      const n = flowRef.current.nodes.find((x) => x.id === nodeId);
      const el = rootRef.current;
      if (!n || !el) return;
      const p = nodePos(n);
      const v = vpRef.current;
      const sx = p.x * v.zoom + v.x;
      const sy = p.y * v.zoom + v.y;
      const margin = 60;
      // Only move when the node is not comfortably visible.
      if (sx > margin && sy > margin && sx + NODE_W * v.zoom < el.clientWidth - margin && sy + NODE_H * v.zoom < el.clientHeight - margin) return;
      setViewport({ ...v, x: el.clientWidth / 2 - (p.x + NODE_W / 2) * v.zoom, y: el.clientHeight / 2 - (p.y + NODE_H / 2) * v.zoom });
    },
    [setViewport],
  );

  useImperativeHandle(
    apiRef,
    (): CanvasApi => ({
      fit,
      zoomBy: (f) => zoomAround(f, (rootRef.current?.clientWidth ?? 800) / 2, (rootRef.current?.clientHeight ?? 600) / 2),
      zoomTo: (z) => {
        const el = rootRef.current;
        const cx = (el?.clientWidth ?? 800) / 2;
        const cy = (el?.clientHeight ?? 600) / 2;
        zoomAround(z / vpRef.current.zoom, cx, cy);
      },
      center,
      focus: () => rootRef.current?.focus({ preventScroll: true }),
      visibleCenter: () => {
        const v = vpRef.current;
        const el = rootRef.current;
        return { x: ((el?.clientWidth ?? 800) / 2 - v.x) / v.zoom - NODE_W / 2, y: ((el?.clientHeight ?? 600) / 2 - v.y) / v.zoom - NODE_H / 2 };
      },
      viewport: () => vpRef.current,
    }),
    [fit, zoomAround, center],
  );

  /* ── coordinates ── */
  const toWorld = useCallback((clientX: number, clientY: number): FlowPosition => {
    const r = rootRef.current!.getBoundingClientRect();
    const v = vpRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }, []);

  /* ── wheel: pan, Ctrl/⌘ or pinch zooms ── */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.fl-minimap')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAround(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        setViewport((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX) * k, y: v.y - (e.shiftKey ? 0 : e.deltaY) * k }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround, setViewport]);

  /* ── space = hand tool ── */
  const activeRef = useRef(featureActive);
  activeRef.current = featureActive;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !activeRef.current) return;
      // Only on the canvas (or a step on it), or with nothing focused: anywhere else Space belongs to the focused
      // control (a button, a switch, a dialog). Hidden views stay mounted, so this listener lives on.
      const root = rootRef.current;
      const target = e.target as HTMLElement | null;
      const onCanvas = !!root && !!target && (target === root || (root.contains(target) && !!target.closest('[data-node-id]') && !target.closest('button')));
      if (!onCanvas && target !== document.body) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setSpace(true);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* ── pointer ── */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointerFocus.current = true;
    setTimeout(() => {
      pointerFocus.current = false;
    }, 0);
    const target = e.target as HTMLElement;
    if (target.closest('.fl-ui')) return;
    if (e.button === 2) return; // context menu
    const root = rootRef.current!;
    const portEl = target.closest<HTMLElement>('[data-port]');
    const nodeEl = target.closest<HTMLElement>('[data-node-id]');
    const edgeEl = target.closest<SVGElement>('[data-edge-key]');
    const pan = e.button === 1 || space;
    root.focus({ preventScroll: true });

    if (!pan && portEl && !readOnly) {
      const nodeId = portEl.dataset.nodeId!;
      const port = portEl.dataset.port as FlowPort;
      const node = flowRef.current.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      drag.current = { kind: 'connect', from: nodeId, port, sx: e.clientX, sy: e.clientY };
      const p = portPoint(node, port);
      setWire({ from: p, to: p, port });
      root.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (!pan && nodeEl) {
      const id = nodeEl.dataset.nodeId!;
      const sel = selRef.current;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      let nodes = sel.nodes;
      if (additive) {
        nodes = new Set(sel.nodes);
        if (nodes.has(id)) (nodes as Set<string>).delete(id);
        else (nodes as Set<string>).add(id);
        onSelection({ nodes, edges: new Set() });
      } else if (!sel.nodes.has(id)) {
        nodes = new Set([id]);
        onSelection({ nodes, edges: new Set() });
      }
      if (readOnly) return;
      const origins = new Map<string, FlowPosition>();
      for (const n of flowRef.current.nodes) if (nodes.has(n.id) || n.id === id) origins.set(n.id, nodePos(n));
      drag.current = { kind: 'nodes', sx: e.clientX, sy: e.clientY, origins, moved: false, clickedId: id, additive };
      root.setPointerCapture(e.pointerId);
      return;
    }
    if (!pan && edgeEl) {
      const key = edgeEl.dataset.edgeKey!;
      onSelection({ nodes: new Set(), edges: new Set([key]) });
      return;
    }
    if (!pan && e.shiftKey) {
      drag.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, additive: true, base: selRef.current };
      root.setPointerCapture(e.pointerId);
      return;
    }
    // Empty canvas: pan (a click without moving clears the selection).
    const v = vpRef.current;
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false };
    setPanning(true);
    root.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const v = vpRef.current;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      setViewport({ ...v, x: d.ox + dx, y: d.oy + dy });
    } else if (d.kind === 'nodes') {
      const dx = (e.clientX - d.sx) / v.zoom;
      const dy = (e.clientY - d.sy) / v.zoom;
      if (!d.moved && Math.hypot(dx * v.zoom, dy * v.zoom) < 3) return;
      d.moved = true;
      const next = new Map<string, FlowPosition>();
      for (const [id, p] of d.origins) next.set(id, { x: snap(p.x + dx), y: snap(p.y + dy) });
      setDragPos(next);
    } else if (d.kind === 'connect') {
      const to = toWorld(e.clientX, e.clientY);
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node-id]');
      const targetId = hit?.dataset.nodeId;
      const problem = targetId ? connectProblem(flowRef.current, d.from, d.port, targetId) : null;
      const node = targetId ? flowRef.current.nodes.find((n) => n.id === targetId) : undefined;
      const from = portPoint(flowRef.current.nodes.find((n) => n.id === d.from)!, d.port);
      setWire({ from, to: node && !problem ? inputPoint(node) : to, port: d.port, target: problem ? undefined : targetId, bad: !!targetId && !!problem && problem !== 'duplicate' });
    } else if (d.kind === 'marquee') {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      setMarquee(rect);
      const hits = new Set<string>(d.base.nodes);
      for (const n of flowRef.current.nodes) if (intersects(rect, nodeRect(n))) hits.add(n.id);
      onSelection({ nodes: hits, edges: new Set() });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    try {
      rootRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    if (d.kind === 'pan') {
      if (!d.moved) onSelection({ nodes: new Set(), edges: new Set() });
    } else if (d.kind === 'nodes') {
      if (d.moved && dragPos) {
        const positions = dragPos;
        onEdit((f) => moveNodes(f, positions));
      } else if (!d.moved && !d.additive && selRef.current.nodes.size > 1) {
        onSelection({ nodes: new Set([d.clickedId]), edges: new Set() });
      }
      setDragPos(null);
    } else if (d.kind === 'connect') {
      const w = wire;
      setWire(null);
      const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4;
      if (w?.target) {
        const target = w.target;
        onEdit((f) => connect(f, d.from, d.port, target));
      } else if (moved && !w?.bad) {
        // Dropped on empty canvas: pick the next step there, connected to this port.
        const at = toWorld(e.clientX, e.clientY);
        onQuickAdd({ client: { x: e.clientX, y: e.clientY }, at: { x: at.x, y: at.y - NODE_H / 2 }, after: { nodeId: d.from, port: d.port } });
      } else if (!moved) {
        // A click on a port: add the next step after it.
        const node = flowRef.current.nodes.find((n) => n.id === d.from);
        if (node) {
          const p = portPoint(node, d.port);
          const at = d.port === 'error' ? { x: p.x - NODE_W / 2, y: p.y + 60 } : { x: nodePos(node).x + NODE_W + 60, y: p.y - NODE_H / 2 };
          onQuickAdd({ client: { x: e.clientX, y: e.clientY }, at, after: { nodeId: d.from, port: d.port } });
        }
      }
    } else if (d.kind === 'marquee') {
      setMarquee(null);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    // Pointer capture (pan, drag) retargets the click events to the canvas itself: look at what is under the pointer.
    const target = ((typeof document.elementFromPoint === 'function' ? document.elementFromPoint(e.clientX, e.clientY) : null) as HTMLElement | null) ?? (e.target as HTMLElement);
    if (!rootRef.current?.contains(target) || target.closest('.fl-ui')) return;
    const nodeEl = target.closest<HTMLElement>('[data-node-id]');
    if (nodeEl) {
      onNodeOpen?.(nodeEl.dataset.nodeId!);
      return;
    }
    if (readOnly || target.closest('[data-edge-key]')) return;
    const at = toWorld(e.clientX, e.clientY);
    onQuickAdd({ client: { x: e.clientX, y: e.clientY }, at: { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 } });
  };

  const onContext = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onContextMenu) return;
    const target = e.target as HTMLElement;
    if (target.closest('.fl-ui') || isEditableTarget(target)) return;
    e.preventDefault();
    const nodeId = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    const edge = target.closest<SVGElement>('[data-edge-key]')?.dataset.edgeKey;
    if (nodeId && !selRef.current.nodes.has(nodeId)) onSelection({ nodes: new Set([nodeId]), edges: new Set() });
    if (edge) onSelection({ nodes: new Set(), edges: new Set([edge]) });
    onContextMenu({ clientX: e.clientX, clientY: e.clientY, nodeId, edge, at: toWorld(e.clientX, e.clientY) });
  };

  /* ── keyboard: Tab reaches the steps, focusing one selects it (unless it is part of the selection) ── */
  const pointerFocus = useRef(false);
  const openRef = useRef(onNodeOpen);
  openRef.current = onNodeOpen;
  const openNode = useCallback((id: string) => openRef.current?.(id), []);
  const focusNode = useCallback(
    (id: string) => {
      // A click selects on pointerdown (with Shift/⌘ toggling): the focus that follows it changes nothing.
      if (pointerFocus.current || selRef.current.nodes.has(id)) return;
      onSelection({ nodes: new Set([id]), edges: new Set() });
      // The step is in view when the keyboard lands on it.
      requestAnimationFrame(() => center(id));
    },
    [onSelection, center],
  );

  /* ── render data ── */
  const nodes = useMemo(() => (dragPos ? flow.nodes.map((n) => (dragPos.has(n.id) ? { ...n, position: dragPos.get(n.id)! } : n)) : flow.nodes), [flow.nodes, dragPos]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edges = useMemo(
    () =>
      flow.edges
        .map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const port = e.port ?? 'out';
          const a = portPoint(from, port);
          const b = inputPoint(to);
          return { key: edgeKey(e), port, a, b, d: edgePath(a, b, port), dim: !!dimmed && (dimmed.has(e.from) || dimmed.has(e.to)) };
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
    [flow.edges, byId, dimmed],
  );
  const selectedEdge = selection.edges.size === 1 ? edges.find((e) => selection.edges.has(e.key)) : undefined;

  const gridSize = 24 * vp.zoom;
  const style = {
    backgroundSize: `${gridSize}px ${gridSize}px`,
    backgroundPosition: `${vp.x}px ${vp.y}px`,
  };

  return (
    <div
      ref={rootRef}
      className={clsx('fl-canvas', panning && 'is-panning', space && 'is-hand', readOnly && 'is-readonly')}
      style={style}
      tabIndex={0}
      role="application"
      aria-label={t('flows.canvas.label')}
      aria-roledescription={t('flows.canvas.role')}
      aria-describedby={hintId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContext}
    >
      <span id={hintId} className="sr-only">
        {t('flows.canvas.keysHint')}
      </span>
      <div className="fl-world" style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }}>
        <svg className="fl-edges" width="1" height="1" aria-hidden>
          <defs>
            {(['out', 'error', 'loop', 'sel'] as const).map((k) => (
              <marker key={k} id={`${uid}-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={`fl-arrow fl-arrow--${k}`} />
              </marker>
            ))}
          </defs>
          {edges.map((e) => {
            const sel = selection.edges.has(e.key);
            const kind = sel ? 'sel' : e.port === 'error' ? 'error' : e.port === 'loop' ? 'loop' : 'out';
            return (
              <g key={e.key} className={clsx('fl-edge', `fl-edge--${e.port}`, sel && 'is-selected', e.dim && 'is-dim')}>
                <path d={e.d} className="fl-edge__hit" data-edge-key={e.key} />
                <path d={e.d} className="fl-edge__line" markerEnd={`url(#${uid}-arrow-${kind})`} />
              </g>
            );
          })}
          {wire ? <path d={edgePath(wire.from, wire.to, wire.port)} className={clsx('fl-wire', wire.target && 'is-snapped', wire.bad && 'is-bad')} /> : null}
          {marquee ? <rect className="fl-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} /> : null}
        </svg>
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            lang={lang}
            onFocusNode={focusNode}
            onOpen={openNode}
            selected={selection.nodes.has(n.id)}
            issues={issuesByNode.get(n.id)}
            run={overlay?.get(n.id)}
            dim={!!dimmed?.has(n.id)}
            connecting={!!wire}
            wireTarget={wire?.target === n.id}
          />
        ))}
        {selectedEdge && !readOnly ? (
          <EdgeActions
            at={edgeMidpoint(selectedEdge.a, selectedEdge.b, selectedEdge.port)}
            zoom={vp.zoom}
            onInsert={(client) => {
              const mid = edgeMidpoint(selectedEdge.a, selectedEdge.b, selectedEdge.port);
              onQuickAdd({ client, at: { x: mid.x - NODE_W / 2, y: mid.y - NODE_H / 2 }, insertEdge: selectedEdge.key });
            }}
            onDelete={() => {
              const key = selectedEdge.key;
              onEdit((f) => ({ ...f, edges: f.edges.filter((x) => edgeKey(x) !== key) }));
              onSelection({ nodes: new Set(), edges: new Set() });
            }}
          />
        ) : null}
      </div>
      {/* A short or narrow stage (run panel open, small window) has no room for it: it would cover the nodes. */}
      {showMinimap && nodes.length > 1 && size.h >= 360 && size.w >= 560 ? <Minimap nodes={nodes} vp={vp} size={size} onMove={(x, y) => setViewport((v) => ({ ...v, x, y }))} /> : null}
    </div>
  );
});

/* ───────────── node ───────────── */

interface NodeCardProps {
  node: FlowNode;
  lang: 'tr' | 'en';
  onFocusNode(id: string): void;
  onOpen?(id: string): void;
  selected: boolean;
  issues?: { errors: number; warnings: number };
  run?: NodeRunState;
  dim: boolean;
  connecting: boolean;
  wireTarget: boolean;
}

const PORT_LABEL: Partial<Record<FlowPort, string>> = { true: 'flows.port.true', false: 'flows.port.false', loop: 'flows.port.loop', done: 'flows.port.done' };

const NodeCard = memo(function NodeCard({ node, lang, onFocusNode, onOpen, selected, issues, run, dim, connecting, wireTarget }: NodeCardProps) {
  const t = useT();
  const spec = flowNodeSpec(node.type);
  const Icon = nodeIcon(node.type);
  const color = spec ? GROUP_COLOR[spec.group] : 'var(--text-subtle)';
  const ports = sidePorts(node.type);
  const summary = nodeSummary(node, lang);
  const p = nodePos(node);
  const status = run?.status;
  const statusClass = status ? (status === 'failed' && run?.handled ? 'is-handled' : `is-${status}`) : undefined;
  return (
    <div
      className={clsx('fl-node', selected && 'is-selected', node.disabled && 'is-disabled', dim && 'is-dim', statusClass, connecting && acceptsInput(node.type) && 'is-droppable', wireTarget && 'is-wire-target', !spec && 'is-unknown')}
      data-node-id={node.id}
      style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: NODE_W, height: NODE_H, ['--node-color' as string]: color }}
      role="group"
      aria-roledescription={t('flows.node.role')}
      aria-label={`${nodeName(node, lang)} (${node.id})${summary ? `: ${summary}` : ''}`}
      tabIndex={0}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusNode(node.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen?.(node.id);
        }
      }}
    >
      <div className="fl-node__bar" aria-hidden />
      <div className="fl-node__head">
        <span className="fl-node__icon" aria-hidden>
          <Icon size={14} />
        </span>
        <span className="fl-node__title">{nodeName(node, lang)}</span>
        <RunBadge run={run} />
      </div>
      <div className="fl-node__summary" title={summary || undefined}>
        {summary || <span className="fl-node__placeholder">{!spec ? t('flows.node.unknownType', { type: node.type }) : spec.params.some((q) => q.required) ? t('flows.node.notSet') : nodeDescription(node.type, lang)}</span>}
      </div>
      <div className="fl-node__foot">
        <span className="fl-node__id">{node.id}</span>
        {node.disabled ? <span className="fl-node__flag">{t('flows.node.disabledShort')}</span> : null}
        {issues?.errors ? (
          <span className="fl-node__issue is-error" title={t('flows.node.errors', { count: issues.errors })}>
            <CircleAlert size={11} aria-hidden />
            {issues.errors}
          </span>
        ) : issues?.warnings ? (
          <span className="fl-node__issue is-warn" title={t('flows.node.warnings', { count: issues.warnings })}>
            <TriangleAlert size={11} aria-hidden />
            {issues.warnings}
          </span>
        ) : null}
        {run && run.count > 1 ? <span className="fl-node__count tnum">×{run.count}</span> : null}
      </div>
      {acceptsInput(node.type) ? <span className="fl-port fl-port--in" style={{ top: NODE_H / 2 }} aria-hidden /> : null}
      {ports.map((port, i) => {
        const top = (NODE_H * (i + 1)) / (ports.length + 1);
        const label = PORT_LABEL[port];
        return (
          <span key={port}>
            {label ? (
              <span className={clsx('fl-port-label', `fl-port-label--${port}`)} style={{ top }}>
                {t(label)}
              </span>
            ) : null}
            <span className={clsx('fl-port', 'fl-port--out', `fl-port--${port}`)} style={{ top }} data-port={port} data-node-id={node.id} title={label ? t(label) : t('flows.port.out')} />
          </span>
        );
      })}
      {hasErrorPort(node.type) ? <span className="fl-port fl-port--error" style={{ left: ERROR_PORT_X, top: NODE_H }} data-port="error" data-node-id={node.id} title={t('flows.port.error')} /> : null}
    </div>
  );
});

function RunBadge({ run }: { run?: NodeRunState }) {
  const t = useT();
  if (!run) return null;
  if (run.status === 'running') return <Spinner size={12} className="fl-node__status" />;
  if (run.status === 'passed') return <CircleCheck size={14} className="fl-node__status is-passed" aria-label={t('flows.status.passed')} />;
  if (run.status === 'failed')
    return run.handled ? (
      <CircleAlert size={14} className="fl-node__status is-handled" aria-label={t('flows.status.handled')} />
    ) : (
      <CircleX size={14} className="fl-node__status is-failed" aria-label={t('flows.status.failed')} />
    );
  if (run.status === 'skipped') return <CircleSlash size={14} className="fl-node__status is-skipped" aria-label={t('flows.status.skipped')} />;
  return <Ban size={14} className="fl-node__status is-cancelled" aria-label={t('flows.status.cancelled')} />;
}

/* ───────────── edge actions ───────────── */

function EdgeActions({ at, zoom, onInsert, onDelete }: { at: FlowPosition; zoom: number; onInsert(client: { x: number; y: number }): void; onDelete(): void }) {
  const t = useT();
  return (
    <div className="fl-ui fl-edge-actions" style={{ transform: `translate(${at.x}px, ${at.y}px) scale(${1 / zoom}) translate(-50%, -50%)` }}>
      <Tooltip content={t('flows.edge.insert')}>
        <button type="button" className="fl-edge-btn" aria-label={t('flows.edge.insert')} onClick={(e) => onInsert({ x: e.clientX, y: e.clientY })}>
          <Plus size={13} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content={t('flows.edge.delete')} shortcut="Backspace">
        <button type="button" className="fl-edge-btn is-danger" aria-label={t('flows.edge.delete')} onClick={onDelete}>
          <Trash size={13} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

/* ───────────── minimap ───────────── */

const MM_W = 180;
const MM_H = 120;

function Minimap({ nodes, vp, size, onMove }: { nodes: readonly FlowNode[]; vp: Viewport; size: { w: number; h: number }; onMove(x: number, y: number): void }) {
  const t = useT();
  const b = boundsOf(nodes)!;
  const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: size.w / vp.zoom, h: size.h / vp.zoom };
  const x1 = Math.min(b.x, view.x) - 40;
  const y1 = Math.min(b.y, view.y) - 40;
  const x2 = Math.max(b.x + b.w, view.x + view.w) + 40;
  const y2 = Math.max(b.y + b.h, view.y + view.h) + 40;
  const k = Math.min(MM_W / (x2 - x1), MM_H / (y2 - y1));
  const ox = (MM_W - (x2 - x1) * k) / 2;
  const oy = (MM_H - (y2 - y1) * k) / 2;
  const toMap = (x: number, y: number) => ({ x: ox + (x - x1) * k, y: oy + (y - y1) * k });
  const dragging = useRef(false);
  const moveTo = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - r.left - ox) / k + x1;
    const wy = (e.clientY - r.top - oy) / k + y1;
    onMove(size.w / 2 - wx * vp.zoom, size.h / 2 - wy * vp.zoom);
  };
  const v = toMap(view.x, view.y);
  return (
    <svg
      className="fl-ui fl-minimap"
      width={MM_W}
      height={MM_H}
      role="img"
      aria-label={t('flows.canvas.minimap')}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e);
      }}
      onPointerMove={(e) => dragging.current && moveTo(e)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {nodes.map((n) => {
        const p = toMap(nodePos(n).x, nodePos(n).y);
        const spec = flowNodeSpec(n.type);
        return <rect key={n.id} x={p.x} y={p.y} width={Math.max(2, NODE_W * k)} height={Math.max(2, NODE_H * k)} rx={1.5} style={{ fill: spec ? GROUP_COLOR[spec.group] : 'var(--text-subtle)' }} className="fl-minimap__node" />;
      })}
      <rect className="fl-minimap__view" x={v.x} y={v.y} width={view.w * k} height={view.h * k} />
    </svg>
  );
}

