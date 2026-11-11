/**
 * Automatic placement of flow nodes (left → right in run order). Flows written by an AI or built from requests
 * have no positions; the canvas calls this for them, and for "Tidy up".
 */
import { flowNodeSpec } from './catalog';
import type { FlowDoc, FlowNode, FlowPosition } from './types';

export const LAYOUT_COLUMN = 280;
export const LAYOUT_ROW = 116;

function forwardEdges(flow: FlowDoc): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  // Drop back edges (loops) found by a DFS from every root, so ranks are well defined.
  const state = new Map<string, 1 | 2>();
  const forward = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = state.get(to);
      if (s === 1) continue; // back edge
      forward.set(id, [...(forward.get(id) ?? []), to]);
      if (!s) visit(to);
    }
    state.set(id, 2);
  };
  const incoming = new Set(flow.edges.map((e) => e.to));
  const roots = flow.nodes.filter((n) => flowNodeSpec(n.type)?.group === 'trigger' || !incoming.has(n.id));
  for (const r of roots) if (!state.has(r.id)) visit(r.id);
  for (const n of flow.nodes) if (!state.has(n.id)) visit(n.id);
  return forward;
}

/** Full layout: every node gets a new position. */
export function layoutFlow(flow: FlowDoc): FlowDoc {
  const forward = forwardEdges(flow);
  const indeg = new Map<string, number>(flow.nodes.map((n) => [n.id, 0]));
  for (const tos of forward.values()) for (const t of tos) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  const rank = new Map<string, number>();
  const queue = flow.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  const remaining = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of forward.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      remaining.set(to, (remaining.get(to) ?? 1) - 1);
      if (remaining.get(to) === 0) queue.push(to);
    }
  }
  for (const n of flow.nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  const columns = new Map<number, string[]>();
  for (const n of flow.nodes) {
    const r = rank.get(n.id)!;
    columns.set(r, [...(columns.get(r) ?? []), n.id]);
  }
  const preds = new Map<string, string[]>();
  for (const [from, tos] of forward) for (const t of tos) preds.set(t, [...(preds.get(t) ?? []), from]);
  const order = new Map<string, number>();
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    const ids = columns.get(r)!;
    if (r > 0) {
      ids.sort((a, b) => {
        const ba = barycenter(a, preds, order);
        const bb = barycenter(b, preds, order);
        return ba - bb;
      });
    }
    ids.forEach((id, i) => order.set(id, i));
  }
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const pos = new Map<string, FlowPosition>();
  for (const r of ranks) {
    const ids = columns.get(r)!;
    const offset = ((tallest - ids.length) * LAYOUT_ROW) / 2;
    ids.forEach((id, i) => pos.set(id, { x: r * LAYOUT_COLUMN, y: Math.round(offset + i * LAYOUT_ROW) }));
  }
  return { ...flow, nodes: flow.nodes.map((n) => ({ ...n, position: pos.get(n.id)! })) };
}

function barycenter(id: string, preds: Map<string, string[]>, order: Map<string, number>): number {
  const ps = (preds.get(id) ?? []).map((p) => order.get(p)).filter((v): v is number => v !== undefined);
  if (ps.length === 0) return Number.MAX_SAFE_INTEGER;
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}

/** Place only the nodes without a position (next to what leads into them); keeps the others. */
export function layoutMissing(flow: FlowDoc): FlowDoc {
  const missing = flow.nodes.filter((n) => !n.position);
  if (missing.length === 0) return flow;
  if (missing.length === flow.nodes.length) return layoutFlow(flow);
  const placed = new Map<string, FlowPosition>();
  for (const n of flow.nodes) if (n.position) placed.set(n.id, n.position);
  const taken = (p: FlowPosition) => [...placed.values()].some((q) => Math.abs(q.x - p.x) < LAYOUT_COLUMN * 0.6 && Math.abs(q.y - p.y) < LAYOUT_ROW * 0.6);
  const pending = [...missing];
  let guard = 0;
  while (pending.length && guard++ < 10_000) {
    const node = pending.shift()!;
    const pred = flow.edges.find((e) => e.to === node.id && placed.has(e.from));
    let p: FlowPosition;
    if (pred) {
      const base = placed.get(pred.from)!;
      p = { x: base.x + LAYOUT_COLUMN, y: base.y };
    } else if (pending.some((m) => flow.edges.some((e) => e.from === m.id && e.to === node.id)) && guard < 5_000) {
      pending.push(node);
      continue;
    } else {
      const maxY = Math.max(0, ...[...placed.values()].map((q) => q.y));
      p = { x: 0, y: maxY + LAYOUT_ROW };
    }
    while (taken(p)) p = { x: p.x, y: p.y + LAYOUT_ROW };
    placed.set(node.id, p);
  }
  return { ...flow, nodes: flow.nodes.map((n: FlowNode) => (n.position ? n : { ...n, position: placed.get(n.id) ?? { x: 0, y: 0 } })) };
}
