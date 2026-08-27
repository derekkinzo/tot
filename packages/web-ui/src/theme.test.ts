import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

describe('a control that shows only a glyph still says what it does', () => {
  // A button whose whole content is a symbol is announced as "button" and nothing
  // else without an accessible name (WCAG 2.2 SC 4.1.2 Name, Role, Value). Checked
  // as the class over every component, so a new one cannot slip in unnamed.
  const COMPONENT_DIR = resolve(__dirname, 'components');
  const GLYPH_ONLY = /^[\s×✕✖?▼▶◀▲←→↑↓·▪⚠◍✓✗○◉⊘+\-–—]{1,4}$/;

  /**
   * Every `<button>` in a source file, as [openingTag, content].
   *
   * The opening tag is found by scanning for a `>` outside braces, quotes and
   * parens — a handler like `onClick={() => f()}` contains a `>` that a
   * character-class match would stop at, which would hide the whole element from
   * this check.
   */
  const buttons = (src: string): [string, string][] => {
    const found: [string, string][] = [];
    let i = 0;
    while ((i = src.indexOf('<button', i)) !== -1) {
      let j = i + 7;
      let brace = 0, paren = 0;
      let quote: string | null = null;
      while (j < src.length) {
        const ch = src[j];
        if (quote) {
          if (ch === quote && src[j - 1] !== '\\') quote = null;
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') brace++;
        else if (ch === '}') brace--;
        else if (ch === '(') paren++;
        else if (ch === ')') paren--;
        else if (ch === '>' && brace === 0 && paren === 0) break;
        j++;
      }
      const openTag = src.slice(i + 7, j);
      const close = src.indexOf('</button>', j);
      if (close === -1) break;
      found.push([openTag, src.slice(j + 1, close)]);
      i = close + 9;
    }
    return found;
  };

  it('finds the buttons it is meant to check, including multi-line handlers', () => {
    // Guards the guard. The arrow in the handler carries a '>' that a naive match
    // stops at, which is how an unnamed control hid from an earlier version of
    // this check.
    const sample = [
      '<button',
      '  onClick={() => setOpen(!open)}',
      '  aria-label="Go"',
      '>→</button>',
      '<button onClick={x}>Save</button>',
    ].join('\n');
    const found = buttons(sample);
    expect(found).toHaveLength(2);
    expect(found[0][1].trim()).toBe('→');
    expect(found[0][0]).toContain('aria-label="Go"');
    expect(found[1][1].trim()).toBe('Save');
    expect(GLYPH_ONLY.test('→')).toBe(true);
    expect(GLYPH_ONLY.test('Save')).toBe(false);
  });

  it('examines every button the components declare', () => {
    // A check that silently examined none would pass vacuously.
    let total = 0;
    for (const file of readdirSync(COMPONENT_DIR).filter((f) => f.endsWith('.tsx'))) {
      total += buttons(readFileSync(resolve(COMPONENT_DIR, file), 'utf-8')).length;
    }
    expect(total).toBeGreaterThan(10);
  });

  it('names every glyph-only control in every component', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(COMPONENT_DIR).filter((f) => f.endsWith('.tsx'))) {
      const src = readFileSync(resolve(COMPONENT_DIR, file), 'utf-8');
      for (const [openTag, content] of buttons(src)) {
        // Content carrying a JSX expression renders text this check cannot read;
        // only bare glyph literals are judged.
        if (content.includes('{')) continue;
        if (!GLYPH_ONLY.test(content.trim())) continue;
        if (/aria-label=|aria-labelledby=/.test(openTag)) continue;
        offenders.push(`${file}: <button>${content.trim()}</button>`);
      }
    }
    expect(offenders, `glyph-only controls with no accessible name:\n${offenders.join('\n')}`).toEqual([]);
  });
});
