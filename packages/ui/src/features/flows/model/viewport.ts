import type { FlowNode } from '@durbun/protocol';
import { boundsOf, intersects, NODE_H, NODE_W, nodePos, type Rect } from './graph';

/** Canvas viewport: screen = world × zoom + (x, y). */
export interface ViewportLike {
  x: number;
  y: number;
  zoom: number;
}

export interface Size {
  w: number;
  h: number;
}

/** The minimap's box and its distance from the canvas edges (px). */
export const MINIMAP = { w: 180, h: 120, margin: 10 } as const;

/**
 * Where the minimap sits: the bottom-right corner, the top-right corner when nodes are under the bottom one, or not
 * at all when nodes fill both (it never covers a step the user is looking at).
 */
export type MinimapCorner = 'bottom' | 'top' | 'hidden';

/** Room the canvas tools take (the palette on top, the zoom bar at the bottom) that fitted nodes stay clear of. */
const TOOLS_TOP = 48;
const TOOLS_BOTTOM = 48;
/** Ports, port labels and the selection ring reach a little past a card. */
const NODE_SLACK = 8;

/** A node's box on screen (canvas px), with room for its ports and labels. */
export function nodeScreenRect(n: FlowNode, vp: ViewportLike): Rect {
  const p = nodePos(n);
  return {
    x: p.x * vp.zoom + vp.x - NODE_SLACK,
    y: p.y * vp.zoom + vp.y - NODE_SLACK,
    w: NODE_W * vp.zoom + NODE_SLACK * 2,
    h: NODE_H * vp.zoom + NODE_SLACK * 2,
  };
}

export function minimapRect(corner: Exclude<MinimapCorner, 'hidden'>, size: Size): Rect {
  const x = size.w - MINIMAP.margin - MINIMAP.w;
  const y = corner === 'bottom' ? size.h - MINIMAP.margin - MINIMAP.h : MINIMAP.margin;
  return { x, y, w: MINIMAP.w, h: MINIMAP.h };
}

function covers(corner: Exclude<MinimapCorner, 'hidden'>, nodes: readonly FlowNode[], vp: ViewportLike, size: Size): boolean {
  const box = minimapRect(corner, size);
  return nodes.some((n) => intersects(nodeScreenRect(n, vp), box));
}

/**
 * The corner for the minimap: the current one while it covers no node (it does not jump around while the user pans),
 * else the bottom, else the top, else none.
 */
export function minimapCorner(nodes: readonly FlowNode[], vp: ViewportLike, size: Size, current: MinimapCorner = 'bottom'): MinimapCorner {
  if (current !== 'hidden' && !covers(current, nodes, vp, size)) return current;
  if (!covers('bottom', nodes, vp, size)) return 'bottom';
  if (!covers('top', nodes, vp, size)) return 'top';
  return 'hidden';
}

/** Every node is on screen, clear of the canvas tools. */
export function allNodesInView(nodes: readonly FlowNode[], vp: ViewportLike, size: Size): boolean {
  const b = boundsOf(nodes);
  if (!b) return true;
  const x1 = b.x * vp.zoom + vp.x;
  const y1 = b.y * vp.zoom + vp.y;
  const x2 = x1 + b.w * vp.zoom;
  const y2 = y1 + b.h * vp.zoom;
  return x1 >= 0 && y1 >= TOOLS_TOP && x2 <= size.w && y2 <= size.h - TOOLS_BOTTOM;
}

/**
 * The canvas got smaller (the run panel opened, the window shrank): fit the flow again when it was all on screen
 * before and now is not, or now sits under the minimap's corner (`minimap`: the minimap is shown). A flow the user
 * zoomed into or panned away from keeps its view; the minimap then moves out of the way instead.
 */
export function shouldRefit(nodes: readonly FlowNode[], vp: ViewportLike, prev: Size, next: Size, opts: { minimap?: boolean } = {}): boolean {
  if (nodes.length === 0 || (next.w >= prev.w && next.h >= prev.h)) return false;
  if (next.w <= 0 || next.h <= 0) return false;
  if (!allNodesInView(nodes, vp, prev)) return false;
  if (!allNodesInView(nodes, vp, next)) return true;
  return !!opts.minimap && covers('bottom', nodes, vp, next) && !covers('bottom', nodes, vp, prev);
}
