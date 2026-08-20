import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATUS_COLORS, STATUS_NODE_STYLES, STATUS_LABELS, EVIDENCE_TYPE_COLORS } from './theme';
import { isPruned, type HypothesisStatus } from './types';

const STYLESHEET = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');

/** Relative luminance per WCAG 2.x, for `#rgb`, `#rrggbb`, or `rgba(r,g,b,a)`. */
function luminance(color: string): number {
  let rgb: number[];
  const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  if (rgba) {
    rgb = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
  } else {
    const hex = color.trim().replace('#', '');
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a color: ${color}`);
    rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio per WCAG 2.x; 1 (identical) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The full selector of the rule targeting `key`, including any ancestors. */
function ruleFor(key: string): { selector: string; body: string } {
  const m = new RegExp(`([^{}\\n;]*${escape(key)}[^{}]*)\\{([^}]*)\\}`).exec(STYLESHEET);
  if (!m) throw new Error(`stylesheet declares no rule for ${key}`);
  return { selector: m[1].trim(), body: m[2] };
}

/** The value a declaration assigns inside the rule targeting `key`. */
function declared(key: string, property: string): string {
  const { body } = ruleFor(key);
  const decl = new RegExp(`(?:^|;)\\s*${escape(property)}\\s*:\\s*([^;]+)`).exec(body);
  if (!decl) throw new Error(`${key} declares no ${property}`);
  return decl[1].trim();
}

/** How many class selectors a rule carries, the term that decides a tie. */
function classCount(selector: string): number {
  return (selector.match(/\.[A-Za-z_][-\w]*/g) ?? []).length;
}

const CANVAS_BACKGROUND = '#0f1117';

/** Canvas-library widgets this app restyles, each shipping a light default. */
const VENDOR_WIDGET_OVERRIDES = [
  '.react-flow__controls',
  '.react-flow__controls-button',
  '.react-flow__minimap-mask',
];

describe('contrast helpers', () => {
  // The thresholds below are only as trustworthy as the ratio they use.
  it('agrees with the WCAG reference points', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});

describe('canvas chrome is themed for a dark canvas', () => {
  // The zoom controls and the minimap ship light-on-light defaults built for a
  // light canvas. Left alone on this one, the control icons sit near-white on
  // near-white and the minimap's out-of-view wash reads as a bright block that
  // hides the nodes under it.

  it('gives the zoom controls an icon that meets WCAG 2.2 SC 1.4.11 on its own button', () => {
    const background = declared('.react-flow__controls-button', 'background');
    const icon = declared('.react-flow__controls-button svg', 'fill');
    // 3:1 is the floor for a user-interface component.
    expect(contrast(icon, background)).toBeGreaterThanOrEqual(3);
  });

  it('floats the zoom controls on the same surface as every other overlay', () => {
    // A surface over the canvas is separated by its edge, not by its fill, so
    // the controls borrow the widget treatment rather than inventing a second
    // one that drifts from it.
    expect(declared('.react-flow__controls-button', 'background'))
      .toBe(declared('.overlay-widget', 'background'));
    expect(declared('.react-flow__controls', 'border'))
      .toBe(declared('.overlay-widget', 'border'));
  });

  it('outranks the vendor rule it is overriding', () => {
    // The canvas library's own stylesheet is imported by the component that uses
    // it, so it lands after this one. An override written at the vendor's own
    // specificity — a single class — therefore loses the tie and silently has no
    // effect. Each override names an ancestor to outrank it.
    for (const key of VENDOR_WIDGET_OVERRIDES) {
      const { selector } = ruleFor(key);
      expect(classCount(selector), selector).toBeGreaterThan(1);
    }
  });

  it('washes the minimap out-of-view area darker than the canvas, not lighter', () => {
    // A light wash over a dark canvas inverts the figure/ground the reader
    // expects: the part they are NOT looking at becomes the brightest thing.
    const mask = declared('.react-flow__minimap-mask', 'fill');
    expect(luminance(mask)).toBeLessThan(luminance(CANVAS_BACKGROUND));
  });
});

describe('status palette', () => {
  it('identifies every status without relying on colour', () => {
    // WCAG 2.2 SC 1.4.1: colour is never the only carrier of a state. Each
    // status pairs its hue with a glyph and a label.
    const icons = Object.values(STATUS_NODE_STYLES).map((s) => s.icon);
    expect(new Set(icons).size).toBe(icons.length);
    for (const [status, style] of Object.entries(STATUS_NODE_STYLES)) {
      expect(style.icon.trim(), status).not.toBe('');
      expect(STATUS_LABELS[status as keyof typeof STATUS_LABELS], status).toBeTruthy();
    }
  });

  it('keeps a status border perceivable wherever the border is the cue', () => {
    // WCAG 2.2 SC 1.4.11 floor for a user-interface component. A pruned node is
    // exempt because its border is deliberately muted to retire the lineage
    // visually; the glyph, the label, the strikethrough, and the reduced opacity
    // carry its state instead.
    for (const [status, style] of Object.entries(STATUS_NODE_STYLES)) {
      if (isPruned(status as HypothesisStatus)) continue;
      expect(contrast(style.border, style.bg), status).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives each status and evidence type a distinct colour', () => {
    const statuses = Object.values(STATUS_COLORS);
    expect(new Set(statuses).size).toBe(statuses.length);
    const evidence = Object.values(EVIDENCE_TYPE_COLORS);
    expect(new Set(evidence).size).toBe(evidence.length);
  });
});
