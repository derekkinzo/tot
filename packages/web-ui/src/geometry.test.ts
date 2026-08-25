import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  overlayFit,
  FOLLOW_INDICATOR_WIDTH,
  CONTROLS_WIDTH,
  MINIMAP_MAX_WIDTH,
  HEADER_MIN_WIDTH,
  LEGEND_MIN_CANVAS_WIDTH,
  MINIMAP_MIN_CANVAS_WIDTH,
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

  it('the canvas takes its header ceiling from this module, not a literal', () => {
    // Which ceiling applies depends on what else the canvas can seat, so the
    // canvas asks rather than hard-coding a width that would drift from the
    // reserve computed here.
    const treeView = SRC('./components/TreeView.tsx');
    expect(treeView).toMatch(/overlayFit/);
    expect(treeView).toMatch(/maxWidth:\s*fit\.headerMaxWidth/);
    // No hand-written pixel ceiling on the header stack.
    expect(treeView).not.toMatch(/maxWidth:\s*['"`]?calc\(100%/);
  });

  it('the canvas seats the minimap and the legend only when they fit', () => {
    const treeView = SRC('./components/TreeView.tsx');
    expect(treeView).toMatch(/fit\.showMinimap/);
    expect(treeView).toMatch(/fit\.showLegend/);
  });
});

describe('what fits on the canvas as it narrows', () => {
  // The reserve that keeps the header clear of the legend is only meaningful
  // while there is room for both. On a canvas narrower than their sum it turns
  // against the reader: the header is squeezed toward nothing and its controls
  // stop being reachable. The overlays that cannot fit stand down instead.

  it('keeps every overlay on a wide canvas', () => {
    const fit = overlayFit(1440);
    expect(fit.showLegend).toBe(true);
    expect(fit.showMinimap).toBe(true);
  });

  /** The px a `calc(100% - Npx)` ceiling holds back. */
  const reserved = (expr: string): number => {
    const m = /calc\(100% - (\d+)px\)/.exec(expr);
    if (!m) throw new Error(`not a reserve expression: ${expr}`);
    return Number(m[1]);
  };

  it('reserves only what is actually seated opposite the header', () => {
    // Reserving for a legend that is not there wastes width the header needs;
    // reserving for nothing runs the header under the follow indicator, which
    // stays put at every size.
    const wide = overlayFit(1440);
    const narrow = overlayFit(LEGEND_MIN_CANVAS_WIDTH - 1);
    expect(reserved(wide.headerMaxWidth)).toBeGreaterThan(LEGEND_MAX_WIDTH);
    expect(reserved(narrow.headerMaxWidth)).toBeLessThan(reserved(wide.headerMaxWidth));
    expect(reserved(narrow.headerMaxWidth)).toBeGreaterThanOrEqual(FOLLOW_INDICATOR_WIDTH);
  });

  it('always yields room for the follow indicator, at every width', () => {
    // It is the only way to stop the canvas moving under the reader, so it is
    // never the thing that gets covered.
    for (const w of [1440, 900, 700, 560, 480, 400, 320, 280, 200, 120]) {
      expect(reserved(overlayFit(w).headerMaxWidth), `canvas ${w}`)
        .toBeGreaterThanOrEqual(FOLLOW_INDICATOR_WIDTH);
    }
  });

  it('gives the header a usable width wherever the canvas allows one', () => {
    for (const w of [1440, 900, 700, 560, 480, 400]) {
      const usable = w - reserved(overlayFit(w).headerMaxWidth);
      expect(usable, `canvas ${w} leaves the header ${usable}px`).toBeGreaterThan(0);
    }
    // At the width where the legend departs, the header gains rather than loses.
    const justBelow = LEGEND_MIN_CANVAS_WIDTH - 1;
    const before = justBelow - reserved(overlayFit(LEGEND_MIN_CANVAS_WIDTH).headerMaxWidth);
    const after = justBelow - reserved(overlayFit(justBelow).headerMaxWidth);
    expect(after).toBeGreaterThan(before);
  });

  it('drops the legend before the header becomes unusable', () => {
    expect(overlayFit(LEGEND_MIN_CANVAS_WIDTH).showLegend).toBe(true);
    expect(overlayFit(LEGEND_MIN_CANVAS_WIDTH - 1).showLegend).toBe(false);
  });

  it('drops the minimap before it can meet the zoom controls', () => {
    expect(overlayFit(MINIMAP_MIN_CANVAS_WIDTH).showMinimap).toBe(true);
    expect(overlayFit(MINIMAP_MIN_CANVAS_WIDTH - 1).showMinimap).toBe(false);
  });

  it('reserves room for the controls beside the minimap', () => {
    // The two share the bottom band, so the threshold has to cover both plus
    // their insets and a gap.
    expect(MINIMAP_MIN_CANVAS_WIDTH).toBeGreaterThan(MINIMAP_MAX_WIDTH + CONTROLS_WIDTH + 2 * OVERLAY_INSET);
  });

  it('is monotonic: nothing reappears as the canvas shrinks', () => {
    let legendSeenOff = false;
    let minimapSeenOff = false;
    for (let w = 1600; w >= 100; w -= 20) {
      const fit = overlayFit(w);
      if (!fit.showLegend) legendSeenOff = true;
      if (!fit.showMinimap) minimapSeenOff = true;
      if (legendSeenOff) expect(fit.showLegend, `legend returned at ${w}`).toBe(false);
      if (minimapSeenOff) expect(fit.showMinimap, `minimap returned at ${w}`).toBe(false);
    }
  });
});
