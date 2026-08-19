// The hypothesis-tree wire contract and status predicates live in
// @tot-mcp/shared, the single definition the server also uses, so the dashboard
// cannot drift from it. Re-exported so existing '../types' importers are
// unaffected.
export type {
  HypothesisStatus,
  Decomposition,
  DecompositionGate,
  GateFinding,
  EvidenceKind,
  ArtifactRef,
  ArtifactDigest,
  Evidence,
  Conclusion,
  HypothesisMetadata,
  Hypothesis,
  Session,
  TreeEvent,
} from '@tot-mcp/shared';
export {
  isPruned, isLive, isTerminal, isOpen,
  countSupporting, countRefuting,
  deriveTitle, nodeLabel, splitProse, TITLE_MAX_LENGTH,
  supportingWeight, refutingWeight, hasUngroundedVerdict, sessionIsGrounded,
  gateLabel, gateMeaning, gateFindings, GATES,
} from '@tot-mcp/shared';

import type { HypothesisStatus } from '@tot-mcp/shared';
import type { EvidenceLedger } from './tree/evidenceView';
import type { SplitBadge } from './tree/splitView';

/** What a node face shows about how it was split. A face states that the
 *  declared relation and the recorded verdicts disagree; the panel says how. */
export type SplitFace = SplitBadge & { conflicted: boolean };

/** React Flow node payload for a hypothesis. Shared by the layout module and the node renderer. */
export type HypothesisData = {
  label: string;
  /** Evidence marks for the node face, precomputed so the renderer holds no rules. */
  ledger: EvidenceLedger;
  /** How this node was split, or null when it has no children or no recorded split. */
  split: SplitFace | null;
  status: HypothesisStatus;
  evidenceCount: number;
  selected: boolean;
  childCount: number;
  onPath: boolean;
  collapsed: boolean;
  hiddenChildren: number;
  pulseClass?: string;
  onToggleCollapse?: (id: string) => void;
};
