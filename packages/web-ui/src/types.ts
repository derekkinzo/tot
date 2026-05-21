export interface Hypothesis {
  id: string;
  parentId: string | null;
  sessionId: string;
  depth: number;
  content: string;
  status: 'pending' | 'exploring' | 'eliminated' | 'confirmed';
  score: number | null;
  evidence: Evidence[];
  conclusion?: {
    verdict: 'eliminated' | 'confirmed';
    reason: string;
    timestamp: string;
  };
  metadata: {
    createdAt: string;
    updatedAt: string;
    source: 'agent' | 'human';
  };
  children: string[];
}

export interface Evidence {
  id: string;
  type: 'supports' | 'refutes' | 'neutral';
  content: string;
  source?: string;
  timestamp: string;
}

export interface Session {
  id: string;
  problem: string;
  rootNodeId: string;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
  completedAt?: string;
}

export type TreeEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'hypothesis-added'; hypothesis: Hypothesis }
  | { type: 'hypothesis-updated'; hypothesis: Hypothesis }
  | { type: 'evidence-added'; hypothesisId: string; evidence: Evidence }
  | { type: 'session-completed'; sessionId: string }
  | { type: 'snapshot'; session: Session; hypotheses: Hypothesis[] };
