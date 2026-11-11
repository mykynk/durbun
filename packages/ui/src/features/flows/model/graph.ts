/**
 * Pure graph editing for the flow canvas: geometry (node box, ports, edge paths) and document edits (add, move,
 * connect, delete, copy/paste, rename). Every edit returns a new FlowDoc; the editor keeps them for undo/redo.
 */
import {
  defaultFlowParams,
  flowNodePorts,
  flowNodeSpec,
  layoutFlow,
  layoutMissing,
  newNodeId,
  NODE_ID_RE,
  renameTemplateRoot,
  type FlowDoc,
  type FlowEdge,
  type FlowNode,
  type FlowPort,
  type FlowPosition,
} from '@durbun/protocol';

export const NODE_W = 220;
export const NODE_H = 76;
export const GRID = 8;
/** Ports leave on the right edge; `error` on the bottom edge, near the right corner. */
export const ERROR_PORT_X = NODE_W - 28;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

export function nodePos(node: FlowNode): FlowPosition {
  return node.position ?? { x: 0, y: 0 };
}

/** Output ports drawn on the right edge (error excluded). */
export function sidePorts(type: string): FlowPort[] {
  return flowNodePorts(type).filter((p) => p !== 'error');
}

export function hasErrorPort(type: string): boolean {
  return flowNodePorts(type).includes('error');
}

export function acceptsInput(type: string): boolean {
  return flowNodeSpec(type)?.acceptsInput ?? true;
}

/** Where an edge leaves a port, in canvas coordinates. */
export function portPoint(node: FlowNode, port: FlowPort): FlowPosition {
  const { x, y } = nodePos(node);
  if (port === 'error') return { x: x + ERROR_PORT_X, y: y + NODE_H };
  const ports = sidePorts(node.type);
  const i = Math.max(0, ports.indexOf(port));
  return { x: x + NODE_W, y: y + (NODE_H * (i + 1)) / (ports.length + 1) };
}

export function inputPoint(node: FlowNode): FlowPosition {
  const { x, y } = nodePos(node);
  return { x, y: y + NODE_H / 2 };
}

/** Cubic path from a port to an input; loops back to the left get a wide curve, error edges leave downwards. */
export function edgePath(from: FlowPosition, to: FlowPosition, port: FlowPort): string {
  if (port === 'error') {
    const dy = Math.max(40, Math.abs(to.y - from.y) / 2);
    const dx = Math.max(60, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + dy}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }
  const back = to.x < from.x + 24;
  if (back) {
    const out = 60;
    const lift = Math.max(70, Math.abs(to.y - from.y) / 2 + 50);
    const midY = Math.max(from.y, to.y) + lift;
    return `M ${from.x} ${from.y} C ${from.x + out} ${from.y}, ${from.x + out} ${midY}, ${(from.x + to.x) / 2} ${midY} S ${to.x - out} ${to.y}, ${to.x} ${to.y}`;
  }
  const dx = Math.max(40, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** Middle of an edge, for its delete button / label. */
export function edgeMidpoint(from: FlowPosition, to: FlowPosition, port: FlowPort): FlowPosition {
  if (port !== 'error' && to.x < from.x + 24) {
    const lift = Math.max(70, Math.abs(to.y - from.y) / 2 + 50);
    return { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + lift };
  }
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

export function edgeKey(e: FlowEdge): string {
  return `${e.from}\u0001${e.port ?? 'out'}\u0001${e.to}`;
}

export function boundsOf(nodes: readonly FlowNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of nodes) {
    const p = nodePos(n);
    x1 = Math.min(x1, p.x);
    y1 = Math.min(y1, p.y);
    x2 = Math.max(x2, p.x + NODE_W);
    y2 = Math.max(y2, p.y + NODE_H);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function nodeRect(n: FlowNode): Rect {
  const p = nodePos(n);
  return { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
}

/* ───────────── edits ───────────── */

export function withNodes(flow: FlowDoc, nodes: FlowNode[], edges: FlowEdge[] = flow.edges): FlowDoc {
  return { ...flow, nodes, edges };
}

/** A free spot near `at` (moves down until nothing overlaps). */
export function freeSpot(flow: FlowDoc, at: FlowPosition): FlowPosition {
  let p = { x: snap(at.x), y: snap(at.y) };
  for (let i = 0; i < 40; i++) {
    const r = { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
    if (!flow.nodes.some((n) => intersects(r, nodeRect(n)))) return p;
    p = { x: p.x, y: p.y + NODE_H + 24 };
  }
  return p;
}

export interface AddNodeOptions {
  at?: FlowPosition;
  /** Connect from this node/port to the new one (and place it to the right). */
  after?: { nodeId: string; port: FlowPort };
  params?: Record<string, unknown>;
  label?: string;
}

export function addNode(flow: FlowDoc, type: string, opts: AddNodeOptions = {}): { flow: FlowDoc; id: string } {
  const id = newNodeId(
    flow.nodes.map((n) => n.id),
    type,
  );
  let at = opts.at;
  const source = opts.after ? flow.nodes.find((n) => n.id === opts.after!.nodeId) : undefined;
  if (!at && source) {
    const p = portPoint(source, opts.after!.port);
    at = opts.after!.port === 'error' ? { x: p.x - NODE_W / 2, y: p.y + 60 } : { x: nodePos(source).x + NODE_W + 60, y: p.y - NODE_H / 2 };
  }
  const node: FlowNode = { id, type, params: { ...defaultFlowParams(type), ...(opts.params ?? {}) } };
  if (opts.label) node.label = opts.label;
  if (Object.keys(node.params!).length === 0) delete node.params;
  node.position = freeSpot(flow, at ?? { x: 0, y: 0 });
  const edges = source && acceptsInput(type) ? [...flow.edges, edgeFor(opts.after!.nodeId, opts.after!.port, id)] : flow.edges;
  return { flow: withNodes(flow, [...flow.nodes, node], edges), id };
}

function edgeFor(from: string, port: FlowPort, to: string): FlowEdge {
  return port === 'out' ? { from, to } : { from, port, to };
}

export function moveNodes(flow: FlowDoc, positions: ReadonlyMap<string, FlowPosition>): FlowDoc {
  return withNodes(
    flow,
    flow.nodes.map((n) => {
      const p = positions.get(n.id);
      return p ? { ...n, position: { x: snap(p.x), y: snap(p.y) } } : n;
    }),
  );
}

/** Why a connection is not allowed (null = fine). */
export function connectProblem(flow: FlowDoc, from: string, port: FlowPort, to: string): 'self' | 'trigger' | 'duplicate' | 'port' | null {
  const target = flow.nodes.find((n) => n.id === to);
  const source = flow.nodes.find((n) => n.id === from);
  if (!target || !source) return 'port';
  if (!acceptsInput(target.type)) return 'trigger';
  if (!flowNodePorts(source.type).includes(port)) return 'port';
  // A repeat node may receive its own loop back (it ends the iteration); any other self edge is a mistake.
  if (from === to && !(source.type === 'logic.repeat' && port === 'loop')) return 'self';
  if (flow.edges.some((e) => e.from === from && (e.port ?? 'out') === port && e.to === to)) return 'duplicate';
  return null;
}

export function connect(flow: FlowDoc, from: string, port: FlowPort, to: string): FlowDoc {
  if (connectProblem(flow, from, port, to)) return flow;
  return { ...flow, edges: [...flow.edges, edgeFor(from, port, to)] };
}

export function removeEdges(flow: FlowDoc, keys: ReadonlySet<string>): FlowDoc {
  return { ...flow, edges: flow.edges.filter((e) => !keys.has(edgeKey(e))) };
}

export function removeNodes(flow: FlowDoc, ids: ReadonlySet<string>): FlowDoc {
  return withNodes(
    flow,
    flow.nodes.filter((n) => !ids.has(n.id)),
    flow.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
  );
}

/**
 * Removes nodes but keeps the chain: a node with one way in and one way out is bridged (A → B → C becomes A → C),
 * which is what people expect when they delete a step in the middle.
 */
export function removeNodesBridged(flow: FlowDoc, ids: ReadonlySet<string>): FlowDoc {
  let edges = flow.edges;
  for (const id of ids) {
    const incoming = edges.filter((e) => e.to === id && !ids.has(e.from));
    const outgoing = edges.filter((e) => e.from === id && (e.port ?? 'out') === 'out' && !ids.has(e.to));
    if (incoming.length >= 1 && outgoing.length === 1) {
      const to = outgoing[0]!.to;
      for (const e of incoming) {
        if (!edges.some((x) => x.from === e.from && (x.port ?? 'out') === (e.port ?? 'out') && x.to === to)) edges = [...edges, { ...e, to }];
      }
    }
    edges = edges.filter((e) => e.from !== id && e.to !== id);
  }
  return withNodes(
    flow,
    flow.nodes.filter((n) => !ids.has(n.id)),
    edges,
  );
}

export function updateNode(flow: FlowDoc, id: string, patch: (n: FlowNode) => FlowNode): FlowDoc {
  return withNodes(
    flow,
    flow.nodes.map((n) => (n.id === id ? patch(n) : n)),
  );
}

export type RenameProblem = 'invalid' | 'taken' | 'reserved';

const RESERVED = new Set(['env', 'vars', 'input', 'target', 'trigger', 'run', 'item']);

export function renameProblem(flow: FlowDoc, from: string, to: string): RenameProblem | null {
  if (to === from) return null;
  if (!NODE_ID_RE.test(to)) return 'invalid';
  if (RESERVED.has(to)) return 'reserved';
  if (flow.nodes.some((n) => n.id === to)) return 'taken';
  return null;
}

/** Renames a node and every `{{from…}}` template in the flow (params, outputs). */
export function renameNode(flow: FlowDoc, from: string, to: string): FlowDoc {
  if (renameProblem(flow, from, to) || from === to) return flow;
  const nodes = flow.nodes.map((n) => {
    const params = n.params ? (renameTemplateRoot(n.params, from, to) as Record<string, unknown>) : undefined;
    const next: FlowNode = { ...n, ...(params ? { params } : {}) };
    if (n.id === from) next.id = to;
    return next;
  });
  const edges = flow.edges.map((e) => ({ ...e, from: e.from === from ? to : e.from, to: e.to === from ? to : e.to }));
  const outputs = flow.outputs?.map((o) => ({ ...o, value: renameTemplateRoot(o.value, from, to) as string }));
  return { ...flow, nodes, edges, ...(outputs ? { outputs } : {}) };
}

/* ───────────── clipboard ───────────── */

export const CLIPBOARD_FORMAT = 'durbun-flow-nodes';

export interface NodeClipboard {
  format: typeof CLIPBOARD_FORMAT;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function copyNodes(flow: FlowDoc, ids: ReadonlySet<string>): NodeClipboard {
  return {
    format: CLIPBOARD_FORMAT,
    nodes: flow.nodes.filter((n) => ids.has(n.id)),
    edges: flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

export function parseClipboard(text: string): NodeClipboard | null {
  try {
    const v = JSON.parse(text) as Partial<NodeClipboard>;
    if (v && v.format === CLIPBOARD_FORMAT && Array.isArray(v.nodes) && Array.isArray(v.edges)) return v as NodeClipboard;
  } catch {
    /* not ours */
  }
  return null;
}

/**
 * Pastes nodes with new ids (templates between them follow the rename), offset so they do not cover the
 * originals. Returns the new ids.
 */
export function pasteNodes(flow: FlowDoc, clip: NodeClipboard, offset: FlowPosition = { x: 40, y: 40 }): { flow: FlowDoc; ids: string[] } {
  let next = flow;
  const map = new Map<string, string>();
  const used = new Set(flow.nodes.map((n) => n.id));
  for (const n of clip.nodes) {
    const prefix = flowNodeSpec(n.type)?.idPrefix;
    let id = n.id;
    if (used.has(id) || RESERVED.has(id) || !NODE_ID_RE.test(id)) id = prefix ? newNodeId(used, n.type) : newNodeId(used, 'step');
    used.add(id);
    map.set(n.id, id);
  }
  let nodes = clip.nodes.map((n) => ({ ...n, id: map.get(n.id)!, position: { x: snap(nodePos(n).x + offset.x), y: snap(nodePos(n).y + offset.y) } }));
  for (const [from, to] of map) {
    if (from === to) continue;
    nodes = nodes.map((n) => (n.params ? { ...n, params: renameTemplateRoot(n.params, from, to) as Record<string, unknown> } : n));
  }
  const edges = clip.edges.filter((e) => map.has(e.from) && map.has(e.to)).map((e) => ({ ...e, from: map.get(e.from)!, to: map.get(e.to)! }));
  next = withNodes(next, [...next.nodes, ...nodes], [...next.edges, ...edges]);
  return { flow: next, ids: nodes.map((n) => n.id) };
}

/* ───────────── layout ───────────── */

export function tidyUp(flow: FlowDoc): FlowDoc {
  return layoutFlow(flow);
}

export function ensureLayout(flow: FlowDoc): FlowDoc {
  return flow.nodes.some((n) => !n.position) ? layoutMissing(flow) : flow;
}

/** Nodes reachable from `id` (the "run from here" preview). */
export function downstream(flow: FlowDoc, id: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    for (const to of out.get(stack.pop()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}

/** Nodes that run before `id` (their outputs are what a template in `id` can read). */
export function upstream(flow: FlowDoc, id: string): Set<string> {
  const inc = new Map<string, string[]>();
  for (const e of flow.edges) inc.set(e.to, [...(inc.get(e.to) ?? []), e.from]);
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const from of inc.get(stack.pop()!) ?? []) {
      if (!seen.has(from) && from !== id) {
        seen.add(from);
        stack.push(from);
      }
    }
  }
  return seen;
}
