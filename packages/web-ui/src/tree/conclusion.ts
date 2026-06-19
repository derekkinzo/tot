import type { Hypothesis } from '../types';

/**
 * Classifies a hypothesis's conclusion record for display.
 *
 * A reopen-on-refute leaves the conclusion on the hypothesis but demotes its
 * live status, so the banner must be marked historical. `supersededBy` is the
 * explicit signal; the status/verdict mismatch is the legacy fallback for
 * journals written before that field existed.
 *
 * Returns the raw `verdict` (callers apply their own label) plus the derived
 * flags — it deliberately does NOT format a label, so DetailPanel and
 * ExportButton keep their distinct wording.
 */
export interface ConclusionStatus {
  verdict: 'eliminated' | 'corroborated' | 'out-of-scope';
  /** True when the conclusion is a superseded/reopened record, not the live verdict. */
  isHistorical: boolean;
  /** True when a refute on a descendant (cascade demote) reopened this node. */
  supersededByDescendant: boolean;
}

export function conclusionStatus(h: Hypothesis): ConclusionStatus | null {
  if (!h.conclusion) return null;
  const supersededBy = h.conclusion.supersededBy;
  return {
    verdict: h.conclusion.verdict,
    isHistorical: supersededBy !== undefined || h.status !== h.conclusion.verdict,
    supersededByDescendant: supersededBy === 'descendant',
  };
}
