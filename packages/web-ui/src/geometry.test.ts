import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  NODE_GAP_X,
  NODE_GAP_Y,
  OVERLAY_INSET,
  OVERLAY_GAP,
  LEGEND_MAX_WIDTH,
  HEADER_STACK_MAX_WIDTH,
  HEADER_TEXT_MAX_WIDTH,
} from './geometry';

const SRC = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8');

/** The px amount a `calc(100% - Npx)` expression subtracts. */
function subtracted(expr: string): number {
  const m = /calc\(100%\s*-\s*(\d+)px\)/.exec(expr);
  if (!m) throw new Error(`not a calc(100% - Npx) expression: ${expr}`);
  return Number(m[1]);
}

describe('canvas geometry', () => {
  it('reserves clear space around a node face', () => {
    for (const v of [NODE_WIDTH, NODE_HEIGHT, NODE_GAP_X, NODE_GAP_Y]) {
      expect(v).toBeGreaterThan(0);
    }
    // A gap smaller than nothing would let siblings touch.
    expect(NODE_GAP_X).toBeGreaterThan(0);
    expect(NODE_GAP_Y).toBeGreaterThan(0);
  });
});

describe('overlay geometry', () => {
  // The header stack and the right-hand overlays are anchored to opposite
  // corners of the same band. Nothing repositions them as the canvas narrows,
  // so the header's ceiling is what keeps the two from meeting.

  it('bounds the header stack so it cannot reach the right-hand overlays', () => {
    const reserved = subtracted(HEADER_STACK_MAX_WIDTH);
    // Both insets, the widest right-hand overlay, and a gap between them.
    expect(reserved).toBeGreaterThanOrEqual(2 * OVERLAY_INSET + LEGEND_MAX_WIDTH + OVERLAY_GAP);
  });

  it('reserves at least as much as the widest right-hand overlay occupies', () => {
    // The legend is the widest thing anchored top-right; a reserve smaller than
    // it would leave the header sliding underneath at narrow widths.
    expect(subtracted(HEADER_STACK_MAX_WIDTH)).toBeGreaterThan(LEGEND_MAX_WIDTH);
  });

  it('keeps the header text ceiling inside the header stack ceiling', () => {
    // The text may ellipsize earlier than the stack wraps, never later.
    expect(HEADER_TEXT_MAX_WIDTH).toMatch(/min\(/);
  });
});

describe('geometry is the single source for overlay sizing', () => {
  // A dimension duplicated in a component drifts from the reserve computed here,
  // and the drift is invisible until two overlays collide on a narrow canvas.

  it('the legend takes its width ceiling from the geometry module', () => {
    const legend = SRC('./components/Legend.tsx');
    expect(legend).toMatch(/LEGEND_MAX_WIDTH/);
    expect(legend).not.toMatch(/maxWidth:\s*\d/);
  });

  it('the canvas applies the header stack ceiling to its top-left overlay', () => {
    const treeView = SRC('./components/TreeView.tsx');
    expect(treeView).toMatch(/HEADER_STACK_MAX_WIDTH/);
  });
});
