// The hypothesis-tree wire contract and status predicates live in
// @tot-mcp/shared, the single definition the server also uses, so the dashboard
// cannot drift from it. Re-exported so existing '../types' importers are
// unaffected.
export type {
  HypothesisStatus,
  Evidence,
  Conclusion,
  HypothesisMetadata,
  Hypothesis,
  Session,
  TreeEvent,
} from '@tot-mcp/shared';
export { isPruned, isLive, isTerminal, isOpen, countSupporting, countRefuting } from '@tot-mcp/shared';

import type { HypothesisStatus } from '@tot-mcp/shared';

/** React Flow node payload for a hypothesis. Shared by the layout module and the node renderer. */
export type HypothesisData = {
  label: string;
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
