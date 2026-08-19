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

/** The marks a node face shows for its evidence. Colours are named as theme
 *  tokens rather than values so the palette stays defined in one place. */
export interface EvidenceLedger {
  refuting: number;
  supporting: number;
  neutral: number;
  refutingToken: 'refutes';
  supportingToken: 'supports';
  hasDecisive: boolean;
  /** A settled verdict resting only on paraphrase. Suppressed in a session that
   *  captured no artifacts at all, where the mark would fire on every node and
   *  so distinguish none of them. */
  ungrounded: boolean;
}

export function evidenceLedger(h: Hypothesis, ctx: { sessionGrounded: boolean }): EvidenceLedger {
  return {
    refuting: refutingWeight(h),
    supporting: supportingWeight(h),
    neutral: h.evidence.filter((e) => e.type === 'neutral').length,
    refutingToken: 'refutes',
    supportingToken: 'supports',
    hasDecisive: h.evidence.some((e) => e.decisive),
    ungrounded: ctx.sessionGrounded && hasUngroundedVerdict(h),
  };
}

/**
 * How many of a session's settled leaves rest on a verbatim record.
 *
 * Only leaves count: a settled parent's verdict rests on its children's, so
 * asking it for its own artifacts would double-count theirs.
 */
export function groundingMeter(hypotheses: Iterable<Hypothesis>): { grounded: number; total: number } {
  let grounded = 0;
  let total = 0;
  for (const h of hypotheses) {
    if (!isTerminal(h.status) || h.children.length > 0) continue;
    total += 1;
    if (!hasUngroundedVerdict(h)) grounded += 1;
  }
  return { grounded, total };
}
