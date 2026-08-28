import {
  hasUngroundedVerdict,
  isTerminal,
  refutingWeight,
  supportingWeight,
  type Evidence,
  type Hypothesis,
} from '../types';

/**
 * Pure projections of a hypothesis's evidence for display, kept out of the
 * components so the reading order and the marks they render are testable.
 *
 * Refutation is privileged throughout: a counter-instance is what settles a
 * claim under falsification, so it is read first and never given the same visual
 * weight as support.
 */

/** Evidence partitioned into reading order. Every record appears in exactly one group. */
export interface EvidenceRows {
  refuters: Evidence[];
  neutral: Evidence[];
  supports: Evidence[];
  /** Records asserted not to discriminate: retained and readable, but read last. */
  tray: Evidence[];
}

export function orderEvidenceRows(h: Hypothesis): EvidenceRows {
  const rows: EvidenceRows = { refuters: [], neutral: [], supports: [], tray: [] };
  for (const e of h.evidence) {
    if (e.nonDiagnostic) rows.tray.push(e);
    else if (e.type === 'refutes') rows.refuters.push(e);
    else if (e.type === 'neutral') rows.neutral.push(e);
    else rows.supports.push(e);
  }
  // A record the verdict turns on leads its group; the rest keep filing order.
  for (const group of [rows.refuters, rows.neutral, rows.supports, rows.tray]) {
    group.sort((a, b) => Number(b.decisive ?? false) - Number(a.decisive ?? false));
  }
  return rows;
}

/**
 * How many records each linked group holds, keyed by group id.
 *
 * A group of records the agent declared to be one observation weighs once
 * however many records it holds, so a reader seeing five rows and a tally of
 * three needs the grouping stated to reconcile them. Groups of one are omitted:
 * a lone record already weighs once, so naming it a group would say nothing.
 */
export function linkedGroupSizes(h: Hypothesis): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const e of h.evidence) {
    if (e.linkedGroupId === undefined) continue;
    sizes.set(e.linkedGroupId, (sizes.get(e.linkedGroupId) ?? 0) + 1);
  }
  for (const [id, size] of sizes) if (size < 2) sizes.delete(id);
  return sizes;
}

/** The marks a node face shows for its evidence. */
export interface EvidenceLedger {
  refuting: number;
  supporting: number;
  neutral: number;
  /** Records the agent declared not to discriminate. They weigh nothing, so
   *  without their own mark a node holding only these looks like a node holding
   *  nothing — and a reader cannot tell the question was looked at. */
  setAside: number;
  hasDecisive: boolean;
  /** A verdict of this node's own resting only on paraphrase. Suppressed in a
   *  session that captured no artifacts at all, where the mark would fire on
   *  every node and so distinguish none of them. */
  ungrounded: boolean;
}

/**
 * Whether a node makes a claim of its own that a verbatim record could ground.
 *
 * A node still open has no verdict yet. A settled parent's verdict rests on its
 * children's, so its own records are not what grounds it. A branch set aside
 * asserts no refutation at all, so there is nothing there to ground. The node
 * face and the session meter both ask this, so a face can never mark a node the
 * meter beside it does not count.
 */
function claimsAGroundableVerdict(h: Hypothesis): boolean {
  return isTerminal(h.status) && h.status !== 'out-of-scope' && h.children.length === 0;
}

export function evidenceLedger(h: Hypothesis, ctx: { sessionGrounded: boolean }): EvidenceLedger {
  return {
    refuting: refutingWeight(h),
    supporting: supportingWeight(h),
    // Measured like the weights beside it: a record that weighs nothing is
    // reported as set aside rather than counted here.
    neutral: h.evidence.filter((e) => e.type === 'neutral' && !e.nonDiagnostic).length,
    setAside: h.evidence.filter((e) => e.nonDiagnostic).length,
    // A record that weighs nothing cannot be the one a verdict turns on.
    hasDecisive: h.evidence.some((e) => e.decisive && !e.nonDiagnostic),
    ungrounded: ctx.sessionGrounded && claimsAGroundableVerdict(h) && hasUngroundedVerdict(h),
  };
}

/**
 * How many of a session's settled leaves carry a verbatim record.
 *
 * Counts what is measurable: whether a captured artifact is attached, not whether
 * the verdict was bound to it. Scoped to the nodes that claim a verdict of their
 * own — see {@link claimsAGroundableVerdict}.
 */
export function groundingMeter(hypotheses: Iterable<Hypothesis>): { grounded: number; total: number } {
  let grounded = 0;
  let total = 0;
  for (const h of hypotheses) {
    if (!claimsAGroundableVerdict(h)) continue;
    total += 1;
    if (!hasUngroundedVerdict(h)) grounded += 1;
  }
  return { grounded, total };
}
