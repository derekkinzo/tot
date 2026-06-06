export interface Hypothesis {
  id: string;
  parentId: string | null;
  sessionId: string;
  depth: number;
  content: string;
  status: HypothesisStatus;
  score: number | null;
  scoreRationale?: string;
  evidence: Evidence[];
  conclusion?: Conclusion;
  metadata: HypothesisMetadata;
  children: string[];
}

// 'out-of-scope': terminal but no refutation claimed — the agent is set
// aside this branch as not worth investigating, distinct from elimination
// which asserts a refuting record. Closure treats both as pruning.
export type HypothesisStatus =
  | 'pending'
  | 'exploring'
  | 'eliminated'
  | 'corroborated'
  | 'out-of-scope';

/**
 * Glyphs used to render each status in text and markdown output. The web UI
 * mirrors these in theme.STATUS_NODE_STYLES; keep both in lockstep when
 * adjusting for accessibility or visual refresh.
 */
export const STATUS_ICONS: Record<HypothesisStatus, string> = {
  pending: '○',
  exploring: '◉',
  eliminated: '✗',
  corroborated: '✓',
  'out-of-scope': '⊘',
};

export interface Evidence {
  id: string;
  type: 'supports' | 'refutes' | 'neutral';
  content: string;
  source?: string;
  timestamp: string;
}

export interface Conclusion {
  verdict: 'eliminated' | 'corroborated' | 'out-of-scope';
  reason: string;
  timestamp: string;
  // Ids of refutes-typed evidence that ground an 'eliminated' verdict.
  // Empty array when replaying older journals that did not record this.
  refutingEvidenceIds?: string[];
}

export interface HypothesisMetadata {
  createdAt: string;
  updatedAt: string;
  source: 'agent' | 'human';
}

export interface Session {
  id: string;
  problem: string;
  rootNodeId: string;
  status: 'open' | 'resolved' | 'abandoned';
  createdAt: string;
  completedAt?: string;
}

// 'session-completed' covers both terminal transitions (resolved and
// abandoned); terminalStatus disambiguates which.
export type TreeEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'hypothesis-added'; hypothesis: Hypothesis }
  | { type: 'hypothesis-updated'; hypothesis: Hypothesis }
  | { type: 'evidence-added'; hypothesisId: string; evidence: Evidence }
  | { type: 'session-completed'; sessionId: string; terminalStatus: 'resolved' | 'abandoned' }
  | { type: 'session-reopened'; sessionId: string }
  | { type: 'snapshot'; session: Session; hypotheses: Hypothesis[] };

export interface StructuralCheck {
  childCount: number;
  substringOverlaps: [string, string][];
  duplicateLabels: string[];
  hasCatchAll: boolean;
  // True when sibling labels span uneven word-count ranges, surfacing the
  // possibility of mixed abstraction levels.
  abstractionMismatch: boolean;
}

export interface TreeState {
  session: Session;
  hypotheses: Map<string, Hypothesis>;
}
