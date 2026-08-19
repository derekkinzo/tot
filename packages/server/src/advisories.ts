import { isLive, isOpen } from './closure.js';
import { countSupporting, countRefuting } from '@tot-mcp/shared';
import type { Hypothesis } from './types.js';

/**
 * Pure methodology predicates behind the add_evidence advisory nudges. Each
 * encodes one rule from the project's epistemic basis (Popper falsification,
 * Heuer ACH diagnosticity, Mill eliminative induction) and takes already-read
 * state so it can be unit-tested without a TreeManager. The formatter owns the
 * prose and the engine reads; this module owns the decisions.
 */

// countSupporting/countRefuting are part of the shared domain contract; re-export
// so existing './advisories.js' importers (the formatter) are unaffected.
export { countSupporting, countRefuting } from '@tot-mcp/shared';

/** Inference-language detector: ≥2 hedging keywords reads as inference, not direct observation. */
const INFERENCE_KEYWORDS = /\b(suggests?|impl(y|ies)|could|might|possibly|consistent with|indicates?|likely|appears?)\b/gi;

/**
 * Baseline nudge: the very first piece of (non-refuting) evidence on a
 * hypothesis — prompt for the "normal" baseline that makes it diagnostic.
 */
export function needsBaselinePrompt(hypothesis: Hypothesis): boolean {
  const last = hypothesis.evidence[hypothesis.evidence.length - 1];
  return hypothesis.evidence.length === 1 && !!last && last.type !== 'refutes';
}

/** Directness: the latest supports/neutral evidence reads as inference (≥2 hedge words). */
export function readsAsInference(hypothesis: Hypothesis): boolean {
  const last = hypothesis.evidence[hypothesis.evidence.length - 1];
  if (!last || (last.type !== 'supports' && last.type !== 'neutral')) return false;
  const matches = last.content.match(INFERENCE_KEYWORDS);
  return !!matches && matches.length >= 2;
}

/**
 * Confirmation bias (Popper asymmetry-of-refutation, Heuer ACH): ≥3 supporting,
 * zero refuting, with a live rival to discriminate against — support that has
 * faced no refutation is the classic red flag. The live-sibling gate scopes the
 * nudge to genuinely competitive contexts.
 */
export function isConfirmationBias(hypothesis: Hypothesis, siblings: Hypothesis[]): boolean {
  const activeSiblings = siblings.filter((s) => isLive(s.status));
  return countSupporting(hypothesis) >= 3 && countRefuting(hypothesis) === 0 && activeSiblings.length > 0;
}

/**
 * Source independence (Heuer): ≥3 evidence items accumulated, and the SUPPORTING
 * evidence — ≥2 sourced items — all cites a single origin, so independent
 * corroboration would strengthen it. Scoped to supporting evidence because the
 * nudge is about corroboration diversity; a repeated refuting source does not
 * "strengthen" the hypothesis and is irrelevant here.
 */
export function lacksSourceDiversity(hypothesis: Hypothesis): boolean {
  if (hypothesis.evidence.length < 3) return false;
  const sources = hypothesis.evidence
    .filter((e) => e.type === 'supports' && e.source)
    .map((e) => e.source);
  return sources.length >= 2 && new Set(sources).size === 1;
}

/**
 * The latest record is a retelling of output that exists somewhere as bytes: a
 * transcription whose content spans several lines, which a human summary of an
 * observation does not. Structural rather than a guess at what output looks like.
 *
 * Worth surfacing because a retyped log cannot be re-read or checked, while the
 * file it came from can be captured and cited instead.
 */
export function readsAsRetypedOutput(hypothesis: Hypothesis): boolean {
  const last = hypothesis.evidence[hypothesis.evidence.length - 1];
  if (!last || last.kind === 'artifact') return false;
  return last.content.trim().includes('\n');
}

/** Elimination nudge (Bacon/Mill eliminative induction): ≥2 refuting, zero supporting. */
export function suggestsElimination(hypothesis: Hypothesis): boolean {
  return countRefuting(hypothesis) >= 2 && countSupporting(hypothesis) === 0;
}

/**
 * Diagnosticity (Heuer ACH, Popper): the latest evidence supports this
 * hypothesis, there are open rivals, none of them has any refuting evidence,
 * and this hypothesis has ≥2 evidence items — so the evidence may not actually
 * discriminate between the live competitors.
 */
export function lacksDiagnosticity(hypothesis: Hypothesis, siblings: Hypothesis[]): boolean {
  const last = hypothesis.evidence[hypothesis.evidence.length - 1];
  if (!last || last.type !== 'supports') return false;
  const openSiblings = siblings.filter((s) => isOpen(s.status));
  if (openSiblings.length === 0 || hypothesis.evidence.length < 2) return false;
  return openSiblings.every((s) => s.evidence.filter((e) => e.type === 'refutes').length === 0);
}
