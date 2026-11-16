import { describe, expect, it } from 'vitest';
import type { FlowNode } from '@durbun/protocol';
import { NODE_H, NODE_W } from './graph';
import { allNodesInView, MINIMAP, minimapCorner, minimapRect, shouldRefit } from './viewport';

const at = (id: string, x: number, y: number) => ({ id, type: 'delay', params: {}, position: { x, y } }) as unknown as FlowNode;
const vp1 = { x: 0, y: 0, zoom: 1 };

describe('minimap placement', () => {
  const size = { w: 1000, h: 600 };
  const bottom = minimapRect('bottom', size);
  const top = minimapRect('top', size);

  it('sits in the bottom-right corner, 10 px from the edges', () => {
    expect(bottom).toEqual({ x: 1000 - MINIMAP.margin - MINIMAP.w, y: 600 - MINIMAP.margin - MINIMAP.h, w: MINIMAP.w, h: MINIMAP.h });
    expect(top.y).toBe(MINIMAP.margin);
  });

  it('stays at the bottom while no node is under it', () => {
    expect(minimapCorner([at('a', 100, 100)], vp1, size)).toBe('bottom');
  });

  it('moves to the top when a node is under the bottom corner, and hides when both are taken', () => {
    const underBottom = at('b', bottom.x - NODE_W / 2, bottom.y);
    expect(minimapCorner([underBottom], vp1, size)).toBe('top');
    const underTop = at('t', top.x, top.y);
    expect(minimapCorner([underBottom, underTop], vp1, size)).toBe('hidden');
  });

  it('counts the ports and the selection ring that reach past a card', () => {
    // The card ends 4 px left of the minimap; its right-edge ports still reach under it.
    expect(minimapCorner([at('p', bottom.x - NODE_W - 4, bottom.y + 10)], vp1, size)).toBe('top');
  });

  it('keeps its current corner while that one is free (no jumping while the user pans)', () => {
    expect(minimapCorner([at('a', 100, 100)], vp1, size, 'top')).toBe('top');
    expect(minimapCorner([at('a', 100, 100)], vp1, size, 'hidden')).toBe('bottom');
  });

  it('follows the zoom and the pan', () => {
    const n = at('z', 400, 220);
    expect(minimapCorner([n], vp1, size)).toBe('bottom');
    expect(minimapCorner([n], { x: 0, y: 0, zoom: 2 }, size)).toBe('top');
    expect(minimapCorner([n], { x: 420, y: 250, zoom: 1 }, size)).toBe('top');
  });
});

describe('fitting again when the canvas shrinks', () => {
  const wide = { w: 1200, h: 700 };
  const narrow = { w: 800, h: 700 };
  const flow = [at('a', 40, 80), at('b', 340, 80), at('c', 640, 200)];
  // The rightmost card ends at 640 + NODE_W = 860 px: on screen at 1200, cut at 800.

  it('every node on screen, clear of the palette and the zoom bar', () => {
    expect(allNodesInView(flow, vp1, wide)).toBe(true);
    expect(allNodesInView(flow, vp1, narrow)).toBe(false);
    expect(allNodesInView([at('top', 40, 10)], vp1, wide)).toBe(false);
    expect(allNodesInView([at('low', 40, 700 - 48 - NODE_H + 1)], vp1, wide)).toBe(false);
    expect(allNodesInView([], vp1, wide)).toBe(true);
  });

  it('refits a flow that was all on screen and no longer is (the run panel opened)', () => {
    expect(shouldRefit(flow, vp1, wide, narrow)).toBe(true);
  });

  it('refits when the minimap would now sit on a node that was clear of it', () => {
    const size = { w: 1100, h: 700 };
    const smaller = { w: 1000, h: 700 };
    const near = [at('a', 40, 80), at('r', 560, 500)];
    // Card r spans 560-780 x 500-576: in view at both sizes; at 1000 px the bottom minimap starts at x = 810.
    expect(allNodesInView(near, vp1, smaller)).toBe(true);
    expect(shouldRefit(near, vp1, size, smaller, { minimap: true })).toBe(false);
    const under = [at('a', 40, 80), at('r', 700, 500)];
    expect(shouldRefit(under, vp1, { w: 1300, h: 700 }, { w: 1000, h: 700 }, { minimap: true })).toBe(true);
    expect(shouldRefit(under, vp1, { w: 1300, h: 700 }, { w: 1000, h: 700 })).toBe(false);
  });

  it('leaves a view the user zoomed into or panned away, a growing canvas and an empty flow alone', () => {
    expect(shouldRefit(flow, { x: -300, y: 0, zoom: 1 }, wide, narrow)).toBe(false);
    expect(shouldRefit(flow, { x: 0, y: 0, zoom: 3 }, wide, narrow)).toBe(false);
    expect(shouldRefit(flow, vp1, narrow, wide)).toBe(false);
    expect(shouldRefit([], vp1, wide, narrow)).toBe(false);
    expect(shouldRefit(flow, vp1, wide, { w: 0, h: 0 })).toBe(false);
  });
});
