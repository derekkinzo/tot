// The hypothesis-tree wire contract lives in @tot-mcp/shared so the server and
// the dashboard cannot drift. Re-exported here so existing './types.js'
// importers are unaffected.
export type {
  ArtifactRef,
  ArtifactIntegrity,
  ArtifactLineWindow,
  Decomposition,
  DecompositionGate,
  ArtifactDigest,
  EvidenceKind,
  HypothesisDraft,
  Hypothesis,
  HypothesisStatus,
  Evidence,
  Conclusion,
  HypothesisMetadata,
  Session,
  TreeEvent,
} from '@tot-mcp/shared';
export { ARTIFACT_ROUTE_PREFIX, rendersAsLines } from '@tot-mcp/shared';

import type { HypothesisStatus, Session, Hypothesis } from '@tot-mcp/shared';

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

export interface StructuralCheck {
  childCount: number;
  /** Sibling id pairs where one label contains the other and the containment is
   *  not a declared conjunction of siblings. */
  substringOverlaps: [string, string][];
  duplicateLabels: string[];
  /** Labels that read as a conjunction of two siblings — the combined-hypothesis
   *  construct, which contains its conjuncts by construction. */
  combinedLabels: string[];
  /** Labels whose wording reads as a residual branch. Lexical: it says how the
   *  labels read, never that the set covers the space beneath its parent. */
  catchAllLabels: string[];
  /** Labels carrying a finite clause where a noun phrase was asked for. The
   *  canvas renders the label and nothing else, so prose in that slot is read
   *  truncated. */
  clauseShapedLabels: string[];
}

export interface TreeState {
  session: Session;
  hypotheses: Map<string, Hypothesis>;
}
