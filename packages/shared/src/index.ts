/**
 * Domain contract shared by the server (engine + persistence) and the web-ui
 * dashboard: the hypothesis-tree types that cross the SSE/JSON wire, and the
 * pure status/evidence predicates both sides reason with. These are a single
 * piece of knowledge that must change together — defining them once here keeps
 * the two separately-bundled packages from drifting.
 *
 * Pure and dependency-free, so both bundlers (tsup for Node, Vite for the
 * browser) consume this TypeScript source directly with no build step.
 */

// ─── Wire contract types ───

export interface Hypothesis {
  id: string;
  parentId: string | null;
  sessionId: string;
  depth: number;
  content: string;
  status: HypothesisStatus;
  evidence: Evidence[];
  conclusion?: Conclusion;
  metadata: HypothesisMetadata;
  children: string[];
}

// 'out-of-scope': terminal but no refutation claimed — the agent set this
// branch aside as not worth investigating, distinct from elimination which
// asserts a refuting record. Closure treats both as pruning.
export type HypothesisStatus =
  | 'pending'
  | 'exploring'
  | 'eliminated'
  | 'corroborated'
  | 'out-of-scope';

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
  // Empty/absent when replaying older journals that did not record this.
  refutingEvidenceIds?: string[];
  // Set when the verdict has been superseded by a later refute. 'self' marks a
  // direct refute against this hypothesis; 'descendant' marks a cascade demote
  // triggered by a refute on a corroborated descendant. Renderers use this to
  // distinguish the historical-conclusion banner.
  supersededBy?: 'self' | 'descendant';
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
  | { type: 'snapshot'; session: Session | null; hypotheses: Hypothesis[] };

// ─── Status predicates ───

/**
 * Eliminated and out-of-scope are pruning verdicts: descendants of a pruned
 * branch are moot under the closure rule.
 */
export function isPruned(status: HypothesisStatus): boolean {
  return status === 'eliminated' || status === 'out-of-scope';
}

/**
 * A hypothesis is "live" when it can still accept further work or be reopened.
 * Pruning verdicts are the only excluded states.
 */
export function isLive(status: HypothesisStatus): boolean {
  return !isPruned(status);
}

/**
 * Terminal statuses cannot accept new children. Includes corroborated, which is
 * settled (though revisable by refutation on the leaf itself, not by sprouting
 * a new pending child below it).
 */
export function isTerminal(status: HypothesisStatus): boolean {
  return status === 'eliminated' || status === 'corroborated' || status === 'out-of-scope';
}

/**
 * A hypothesis is "open" when it is an unsettled competitor still inviting work
 * — pending or exploring. Distinct from isLive, which also admits a
 * corroborated (settled) verdict.
 */
export function isOpen(status: HypothesisStatus): boolean {
  return status === 'pending' || status === 'exploring';
}

// ─── Evidence counts ───

/**
 * Count of supporting / refuting evidence on a hypothesis. One definition so
 * every gate that fires and every number printed agree.
 */
export const countSupporting = (h: Hypothesis): number =>
  h.evidence.filter((e) => e.type === 'supports').length;
export const countRefuting = (h: Hypothesis): number =>
  h.evidence.filter((e) => e.type === 'refutes').length;
