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

export type HypothesisStatus = 'pending' | 'exploring' | 'eliminated' | 'corroborated';

export interface Evidence {
  id: string;
  type: 'supports' | 'refutes' | 'neutral';
  content: string;
  source?: string;
  timestamp: string;
}

export interface Conclusion {
  verdict: 'eliminated' | 'corroborated';
  reason: string;
  timestamp: string;
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

// 'session-completed' is retained as a stable wire identifier for both the
// resolved and abandoned terminal transitions; renaming would break replay
// of existing JSONL files and external SSE consumers.
export type TreeEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'hypothesis-added'; hypothesis: Hypothesis }
  | { type: 'hypothesis-updated'; hypothesis: Hypothesis }
  | { type: 'evidence-added'; hypothesisId: string; evidence: Evidence }
  | { type: 'session-completed'; sessionId: string }
  | { type: 'snapshot'; session: Session; hypotheses: Hypothesis[] };

export interface StructuralCheck {
  childCount: number;
  substringOverlaps: [string, string][];
  duplicateLabels: string[];
  hasCatchAll: boolean;
}

export interface TreeState {
  session: Session;
  hypotheses: Map<string, Hypothesis>;
}
