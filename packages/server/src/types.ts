// The hypothesis-tree wire contract lives in @tot-mcp/shared so the server and
// the dashboard cannot drift. Re-exported here so existing './types.js'
// importers are unaffected.
export type {
  ArtifactRef,
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
  substringOverlaps: [string, string][];
  duplicateLabels: string[];
  hasCatchAll: boolean;
  // True when sibling labels span uneven word-count ranges, surfacing the
  // possibility of mixed abstraction levels.
  abstractionMismatch: boolean;
  // Word-count span of the sibling labels (present when childCount >= 2), so
  // formatters reuse the engine's counts instead of recomputing the split.
  minWords?: number;
  maxWords?: number;
}

export interface TreeState {
  session: Session;
  hypotheses: Map<string, Hypothesis>;
}
