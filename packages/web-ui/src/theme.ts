import type { Hypothesis } from './types';

type HypothesisStatus = Hypothesis['status'];
type EvidenceType = 'supports' | 'refutes' | 'neutral';

/**
 * The mark a status carries, wherever a status is shown: the ring around a
 * canvas node, the dot in the minimap, the swatch in the legend that explains
 * that ring, the pill in the status bar. One value per status, because a second
 * table would let the legend teach a mark the canvas does not draw.
 *
 * Each is light enough to clear the 3:1 non-text contrast floor on the overlay
 * surface, where these are drawn at full size and full opacity.
 */
export const STATUS_COLORS: Record<HypothesisStatus, string> = {
  pending: '#3b82f6',
  exploring: '#eab308',
  // Neutral rather than a hue of its own: an eliminated branch is retired from
  // the investigation, and the canvas dims it further.
  eliminated: '#6b7280',
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

export const EVIDENCE_TYPE_COLORS: Record<EvidenceType, string> = {
  supports: '#22c55e',
  refutes: '#ef4444',
  neutral: '#8b949e',
};

export const HIGHLIGHT_COLORS = {
  pathEdge: '#58a6ff',
  // Edges into pruned nodes (eliminated, out-of-scope) share this muted
  // stroke to signal that the lineage is no longer drawing investigation.
  prunedEdge: '#4b5563',
  defaultEdge: '#6b7280',
} as const;
