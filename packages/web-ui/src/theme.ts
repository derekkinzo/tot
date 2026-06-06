import type { Hypothesis } from './types';

type HypothesisStatus = Hypothesis['status'];
type EvidenceType = 'supports' | 'refutes' | 'neutral';

export const STATUS_COLORS: Record<HypothesisStatus, string> = {
  pending: '#3b82f6',
  exploring: '#eab308',
  eliminated: '#ef4444',
  corroborated: '#22c55e',
  'out-of-scope': '#a78bfa',
};

export const STATUS_NODE_STYLES: Record<HypothesisStatus, { bg: string; border: string; icon: string }> = {
  pending:        { bg: '#1e293b', border: '#3b82f6', icon: '○' },
  exploring:      { bg: '#1c1917', border: '#eab308', icon: '◉' },
  eliminated:     { bg: '#1c1917', border: '#4b5563', icon: '✗' },
  corroborated:   { bg: '#052e16', border: '#22c55e', icon: '✓' },
  'out-of-scope': { bg: '#1f1b3a', border: '#a78bfa', icon: '⊘' },
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
  eliminatedEdge: '#4b5563',
  defaultEdge: '#6b7280',
} as const;
