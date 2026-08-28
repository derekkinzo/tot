import type { Hypothesis } from './types';

type HypothesisStatus = Hypothesis['status'];
type EvidenceType = 'supports' | 'refutes' | 'neutral';

/**
 * The mark a status carries, wherever a status is shown: the ring around a
 * canvas node, the dot in the minimap, the swatch in the legend that explains
 * that ring, the pill in the status bar, and the word naming the status in the
 * detail panel. One value per status, because a second table would let the
 * legend teach a mark the canvas does not draw.
 *
 * Each value clears both floors that apply to it: 3:1 where it is a graphic
 * (WCAG 2.2 SC 1.4.11) and 4.5:1 where it names the status in small text (SC
 * 1.4.3), on every surface the app draws it on. That is why these are lighter
 * than the hue a light theme would pick — a mid-tone hue readable on white is
 * not readable at 12px on this canvas.
 */
export const STATUS_COLORS: Record<HypothesisStatus, string> = {
  pending: '#60a5fa',
  exploring: '#eab308',
  // Neutral rather than a hue of its own: an eliminated branch is retired from
  // the investigation, and the canvas dims it further.
  eliminated: '#9ca3af',
  corroborated: '#22c55e',
  'out-of-scope': '#a78bfa',
};

export const STATUS_NODE_STYLES: Record<HypothesisStatus, { bg: string; border: string; icon: string }> = {
  pending:        { bg: '#1e293b', border: STATUS_COLORS.pending, icon: '○' },
  exploring:      { bg: '#1c1917', border: STATUS_COLORS.exploring, icon: '◉' },
  eliminated:     { bg: '#1c1917', border: STATUS_COLORS.eliminated, icon: '✗' },
  corroborated:   { bg: '#052e16', border: STATUS_COLORS.corroborated, icon: '✓' },
  'out-of-scope': { bg: '#1f1b3a', border: STATUS_COLORS['out-of-scope'], icon: '⊘' },
};

export const STATUS_LABELS: Record<HypothesisStatus, string> = {
  pending: 'Pending',
  exploring: 'Exploring',
  eliminated: 'Eliminated',
  corroborated: 'Corroborated',
  'out-of-scope': 'Out of scope',
};

/**
 * The mark an evidence type carries, on a panel row and in a node's ledger.
 * Read as small text in both places, so each clears 4.5:1 on the card and on
 * every node face.
 */
export const EVIDENCE_TYPE_COLORS: Record<EvidenceType, string> = {
  supports: '#22c55e',
  refutes: '#ff7b72',
  neutral: '#8b949e',
};

/**
 * Text on the app's surfaces. Two tiers, not three: no grey darker than
 * `secondary` clears 4.5:1 on the surfaces here, so a third tier could only be
 * had by making its text unreadable. Depth is carried by size and weight
 * instead, which cost nothing to read.
 */
export const TEXT = {
  primary: '#e1e4e8',
  secondary: '#8b949e',
} as const;

export const HIGHLIGHT_COLORS = {
  pathEdge: '#58a6ff',
  // An edge carries the tree's structure, so it holds the 3:1 graphic floor
  // whatever it connects. A pruned lineage is marked by the dash pattern below
  // rather than by a dimmer stroke: the only greys dim enough to read as
  // "retired" fall under that floor, and a dash is visible to a reader who
  // cannot tell two greys apart at all.
  prunedEdge: '#6b7280',
  defaultEdge: '#6b7280',
} as const;

/** Stroke pattern for an edge into a pruned node. */
export const PRUNED_EDGE_DASH = '5 4';
