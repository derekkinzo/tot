/**
 * Adaptive response formatters for tool results.
 *
 * Signals are grounded in established reasoning methodologies:
 * - Eliminative Induction (Bacon 1620, Novum Organum): tables of presence/absence,
 *   exclusion of alternatives as the engine of inference
 * - Methods of Agreement and Difference (Mill 1843, System of Logic): comparative
 *   evidence across cases to isolate causal factors
 * - Multiple Working Hypotheses (Chamberlin 1890): parallel hypothesis families
 *   guard against parental affection for a single explanation
 * - Falsificationism (Popper 1959): severity of tests, asymmetry of refutation
 * - Strong Inference (Platt 1964): crucial experiment design, recycling discipline
 * - Causal Inference (Hill 1965): temporality, specificity, reproducibility
 * - Analysis of Competing Hypotheses (Heuer 1999): diagnosticity, red team, sensitivity
 * - Scientific Debugging (Zeller 2009): hypothesize-test-eliminate cycle
 * - Expert Debugging Studies (Ko & Myers 2004, Parnin & Orso 2011): depth limits
 *
 * Design principles:
 * - Signals fire conditionally based on tree state (avoid prompt fatigue)
 * - Advisory, never blocking (agents retain autonomy)
 * - Grounded in quantitative signals (evidence counts, scores, depths)
 *
 * Threshold rationale:
 * - Confirmation bias: 3+ supporting with 0 refuting (ACH unidirectional evidence)
 * - Staleness: 120s between interactions (re-anchor context)
 * - Elimination nudge: 2+ refuting with 0 supporting
 * - Tie detection: top-2 within 0.15 gap
 * - Diagnosticity: supports added with no siblings refuted (non-discriminating)
 * - Premature decomposition: parent has 0 evidence items
 * - Depth caution: children at depth >= 3 (Parnin & Orso 2011)
 * - Inference detection: 2+ keywords (suggests/implies/could/might/possibly/likely)
 */

import type { Hypothesis, StructuralCheck } from './types.js';
import type { TreeManager } from './tree-manager.js';

export function formatCreateTree(sessionId: string, rootId: string, problem: string): string {
  const lowerProblem = problem.toLowerCase();
  let domainHint = '';
  if (lowerProblem.match(/500|error|crash|fail|bug|exception/)) {
    domainHint = `Suggested frames: by layer (code/data/infra/external), by scope (all/subset), by time (before/after change)\n`;
  } else if (lowerProblem.match(/slow|latency|timeout|performance/)) {
    domainHint = `Suggested frames: by resource (CPU/memory/IO/network), by stage (request lifecycle), by scope\n`;
  } else if (lowerProblem.match(/intermittent|flaky|sometimes|random/)) {
    domainHint = `Suggested frames: by determinism (timing/data/state), by trigger (load/input/sequence)\n`;
  }

  return JSON.stringify({ sessionId, rootId }) + '\n\n' +
    `✓ Tree created: "${truncate(problem, 70)}"\n\n` +
    `── Domain Investigation ──\n` +
    `BEFORE decomposing, investigate the problem domain:\n` +
    `1. Gather context: What is the system architecture? What changed recently?\n` +
    `2. Characterize symptoms: When did it start? Who/what is affected? What is the scope?\n` +
    `3. Identify boundaries: What is IN scope vs OUT of scope for this investigation?\n` +
    `Fan out subagents to research the domain from multiple angles simultaneously.\n\n` +
    `── Decomposition ──\n` +
    `Once you understand the domain, decompose into 2-5 MECE hypotheses.\n` +
    (domainHint ? domainHint : '') +
    `MECE criteria:\n` +
    `  ME (Mutually Exclusive): Each hypothesis covers a DISTINCT failure mode — no overlaps.\n` +
    `  CE (Collectively Exhaustive): Together they cover ALL plausible explanations.\n` +
    `For EACH hypothesis, define what TEST would REFUTE it.\n` +
    `Execute the most discriminating test first (one that separates hypotheses).\n\n` +
    `── Tree ──\n` +
    `0 hypotheses | Session: ${sessionId.slice(0, 8)}`;
}

export function formatDecompose(children: Hypothesis[], check: StructuralCheck, tm: TreeManager): string {
  const ids = children.map((c) => c.id);
  const isRootDecomposition = children[0]?.depth === 1;
  let result = JSON.stringify({ childIds: ids }) + '\n\n' +
    `✓ Decomposed into ${children.length} sub-hypotheses\n\n`;

  if (isRootDecomposition) {
    result += `── Initial Structure (Critical) ──\n`;
    result += `This is the foundational decomposition. Its quality determines the entire investigation.\n`;
    result += `Review thoroughly: Did you investigate the domain BEFORE decomposing?\n`;
    const parentIdForDispatch = children[0]?.parentId ?? '';
    result += `Dispatch the \`mece-evaluator\` subagent to validate this decomposition: it checks mutual exclusivity, collective exhaustiveness, level alignment, and testability.\n`;
    result += `  Input — parent hypothesis ID: ${parentIdForDispatch} | child IDs: ${ids.join(', ')}\n\n`;
  }

  // Structural checks
  result += `── Checks ──\n`;
  if (check.childCount < 2) result += `⚠ Only ${check.childCount} child — consider adding more\n`;
  if (check.childCount > 7) result += `Note: ${check.childCount} children — consider whether some could be grouped at a higher abstraction level\n`;
  if (check.substringOverlaps.length > 0) result += `⚠ Overlap detected between ${check.substringOverlaps.length} pair(s)\n`;
  if (!check.hasCatchAll) result += `Note: No catch-all — is anything missing?\n`;

  // Abstraction level check
  const lengths = children.map((c) => c.content.split(/\s+/).length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  if (maxLen > minLen * 3) {
    result += `⚠ Abstraction mismatch: labels range from ${minLen} to ${maxLen} words\n`;
  }

  if (check.substringOverlaps.length === 0 && check.childCount >= 2 && maxLen <= minLen * 3) {
    result += `No structural issues detected.\n`;
  }

  // Premature decomposition guard: parent had no evidence
  const parent = tm.getHypothesis(children[0]?.parentId ?? '');
  if (parent && parent.evidence.length === 0 && parent.depth > 0) {
    result += `\n⚠ Parent has no evidence yet. A single observation at this level might eliminate it entirely, saving sub-investigation effort.\n`;
  }

  // Uninvestigated siblings warning
  if (parent) {
    const parentSiblings = tm.getSiblings(parent.id);
    const uninvestigated = parentSiblings.filter((s) => s.status === 'pending' && s.evidence.length === 0);
    if (uninvestigated.length > 0) {
      result += `\nNote: ${uninvestigated.length} sibling(s) at this level have no evidence. Testing broadly before drilling deep often reveals the answer faster.\n`;
    }
  }

  // Depth warning (Parnin & Orso 2011)
  if (children[0] && children[0].depth >= 3) {
    result += `\nDepth ${children[0].depth}: Deep decompositions risk fragmenting the problem. Consider whether the parent is specific enough to test directly.\n`;
  }

  // MECE review and protocol guidance
  result += `\n── MECE Review ──\n`;
  result += `STOP and review this decomposition before proceeding:\n`;
  result += `  ME: Could a single root cause belong to TWO of these categories? If yes, refine the boundaries.\n`;
  result += `  CE: Can you imagine a plausible cause NOT covered by ANY of these? If yes, add it.\n`;
  result += `  Level: Are all hypotheses at the same level of abstraction?\n`;
  result += `Dispatch the \`mece-evaluator\` subagent to validate this decomposition: it checks mutual exclusivity, collective exhaustiveness, level alignment, and testability.\n`;
  result += `  Input — parent hypothesis ID: ${children[0]?.parentId ?? ''} | child IDs: ${ids.join(', ')}\n`;
  result += `\n── Protocol ──\n`;
  result += `Crucial experiment: What SINGLE observation would yield DIFFERENT results depending on which sub-hypothesis is correct?\n`;
  result += `Prioritize this discriminating test before investigating each in isolation.\n`;

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatAddHypothesis(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const activeSiblings = siblings.filter((s) => s.status !== 'eliminated');

  let result = JSON.stringify({ hypothesisId: hypothesis.id }) + '\n\n' +
    `✓ Added hypothesis: "${truncate(hypothesis.content, 60)}"\n\n`;

  result += `── MECE Validation ──\n`;
  result += `Review the full set of ${activeSiblings.length + 1} siblings:\n`;
  result += `  ME: Does this new hypothesis overlap with any existing sibling?\n`;
  result += `  CE: Does adding this close a gap, or is there still something missing?\n`;
  result += `Fan out subagents to challenge whether this hypothesis is truly distinct from its siblings.\n\n`;

  result += `── Protocol ──\n`;
  result += `What is the fastest path to REFUTE this hypothesis? Define the test before investigating.\n`;

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatAddEvidence(hypothesisId: string, hypothesis: Hypothesis, tm: TreeManager): string {
  const supporting = hypothesis.evidence.filter((e) => e.type === 'supports').length;
  const refuting = hypothesis.evidence.filter((e) => e.type === 'refutes').length;

  const siblings = tm.getSiblings(hypothesisId);
  const activeSiblings = siblings.filter((s) => s.status !== 'eliminated');

  let result = JSON.stringify({ hypothesisId, evidenceCount: hypothesis.evidence.length }) + '\n\n' +
    `✓ Evidence added to "${truncate(hypothesis.content, 50)}"\n\n`;

  // Evidence matrix across siblings
  result += `── Evidence Matrix ──\n`;
  const allHypotheses = [hypothesis, ...siblings].filter((h) => h.status !== 'eliminated');
  for (const h of allHypotheses) {
    const s = h.evidence.filter((e) => e.type === 'supports').length;
    const r = h.evidence.filter((e) => e.type === 'refutes').length;
    const marker = h.id === hypothesisId ? ' ←' : '';
    result += `  ${truncate(h.content, 30)}: +${s} -${r}${marker}\n`;
  }

  // Baseline prompt: first evidence on this hypothesis
  const lastEvidence = hypothesis.evidence[hypothesis.evidence.length - 1];
  if (hypothesis.evidence.length === 1 && lastEvidence && lastEvidence.type !== 'refutes') {
    result += `\nHave you established the baseline? Knowing what 'normal' looks like before the problem makes this observation more diagnostic.\n`;
  }

  // Directness detection: inference-language in evidence content
  if (lastEvidence && (lastEvidence.type === 'supports' || lastEvidence.type === 'neutral')) {
    const inferenceKeywords = /\b(suggests?|impl(y|ies)|could|might|possibly|consistent with|indicates?|likely|appears?)\b/gi;
    const matches = lastEvidence.content.match(inferenceKeywords);
    if (matches && matches.length >= 2) {
      result += `\nThis reads as inference rather than direct observation. What specific command, log entry, or metric would DIRECTLY show the state you're inferring?\n`;
    }
  }

  // Confirmation bias detection + confounder check (Heuer 1999 ACH)
  if (supporting >= 3 && refuting === 0 && activeSiblings.length > 0) {
    result += `\n⚠ Confirmation bias: ${supporting} supporting, 0 refuting. What would REFUTE this?\n`;
    result += `Could a confounding variable explain these observations without this hypothesis being true?\n`;
  }

  // Source diversity check: all evidence from same source
  if (hypothesis.evidence.length >= 3) {
    const sources = hypothesis.evidence.filter((e) => e.source).map((e) => e.source);
    if (sources.length >= 2 && new Set(sources).size === 1) {
      result += `\nAll evidence cites the same source. Independent corroboration from a different data source would strengthen this.\n`;
    }
  }

  // Unexplored siblings warning
  const unexplored = activeSiblings.filter((s) => s.evidence.length === 0);
  if (unexplored.length > 0) {
    result += `\nUnexplored: ${unexplored.map((u) => truncate(u.content, 25)).join(', ')}\n`;
  }

  // Elimination nudge
  if (refuting >= 2 && supporting === 0) {
    result += `\n→ ${refuting} refuting, 0 supporting — consider elimination.\n`;
  }

  // Diagnosticity: evidence that doesn't discriminate (Heuer 1999, Popper 1959)
  if (lastEvidence && lastEvidence.type === 'supports' && activeSiblings.length > 0) {
    const noSiblingsRefuted = activeSiblings.every((s) => s.evidence.filter((e) => e.type === 'refutes').length === 0);
    if (noSiblingsRefuted && hypothesis.evidence.length >= 2) {
      // Diagnosticity amplification: name the top sibling
      const topSibling = activeSiblings.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      if (topSibling) {
        result += `\nDiagnosticity: Would this also hold if "${truncate(topSibling.content, 40)}" were the cause? Evidence consistent with multiple hypotheses does not discriminate.\n`;
      } else {
        result += `\nNo hypothesis has been refuted yet. A strong test is one whose outcome is predicted by THIS hypothesis but NOT by its siblings.\n`;
      }
    }
  }

  // Stale tree detection
  const secsSinceLastCall = tm.getSecondsSinceLastInteraction();
  if (secsSinceLastCall > 120) {
    const session = tm.getActiveSession();
    result += `\n── Context (${Math.floor(secsSinceLastCall / 60)}m since last update) ──\n`;
    if (session) result += `Problem: "${truncate(session.problem, 50)}"\n`;
    result += `You were testing: "${truncate(hypothesis.content, 40)}"\n`;
  }

  // Protocol — with specific named siblings for adversarial questions
  result += `\n── Protocol ──\n`;
  if (activeSiblings.length > 0 && hypothesis.evidence.length >= 2 && refuting === 0) {
    const topSibling = activeSiblings[0];
    result += `What observation would be TRUE if "${truncate(hypothesis.content, 25)}" but FALSE if "${truncate(topSibling.content, 25)}"?\n`;
  } else if (activeSiblings.length > 1) {
    result += `Does this evidence also bear on sibling hypotheses?\n`;
  }
  if (hypothesis.evidence.length >= 2 && refuting === 0) {
    result += `Seek REFUTING evidence: what test would prove this hypothesis WRONG?\n`;
  }

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatEliminate(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const remaining = siblings.filter((s) => s.status !== 'eliminated');

  let result = JSON.stringify({ hypothesisId: hypothesis.id, status: 'eliminated' }) + '\n\n' +
    `✓ Eliminated "${truncate(hypothesis.content, 50)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;

  result += `── Signals ──\n`;
  result += `Remaining: ${remaining.length} (${remaining.map((r) => truncate(r.content, 25)).join(', ')})\n`;

  if (remaining.length === 1) {
    result += `\n→ Only 1 hypothesis remains. Before confirming, apply a SEVERE TEST:\n`;
    result += `  Can you REPRODUCE the issue by triggering this cause?\n`;
    result += `  Fan out subagents to challenge this conclusion from different angles — what could you be missing?\n`;
  } else if (remaining.length === 0) {
    result += `\n⚠ All siblings eliminated — hypothesis space may be incomplete.\n`;
    result += `Fan out subagents to investigate what was missed. Add new hypotheses from fresh perspectives.\n`;
  } else {
    result += `\n── Protocol ──\n`;
    result += `What is the most discriminating test to distinguish the remaining ${remaining.length} hypotheses?\n`;
    result += `Fan out subagents to independently investigate each remaining hypothesis and challenge assumptions.\n`;
  }

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatConfirm(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const eliminated = siblings.filter((s) => s.status === 'eliminated');

  let result = JSON.stringify({ hypothesisId: hypothesis.id, status: 'confirmed' }) + '\n\n' +
    `✓ Confirmed "${truncate(hypothesis.content, 50)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;

  result += `── Verification ──\n`;
  result += `1. Does this explain ALL observed symptoms?\n`;
  result += `2. Can you REPRODUCE the issue by triggering this cause?\n`;
  result += `3. Were competing hypotheses eliminated with evidence (not just ignored)?\n`;
  result += `4. TEMPORALITY: Did this cause precede the failure in time?\n`;
  result += `5. SPECIFICITY: Does this explain THIS failure pattern specifically, not just failures in general?\n`;

  if (eliminated.length < siblings.length) {
    const unresolved = siblings.filter((s) => s.status !== 'eliminated' && s.id !== hypothesis.id);
    if (unresolved.length > 0) {
      result += `\n⚠ ${unresolved.length} sibling(s) not eliminated: ${unresolved.map((u) => truncate(u.content, 25)).join(', ')}\n`;
    }
  }

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatScore(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const ranked = [hypothesis, ...siblings]
    .filter((h) => h.score !== null && h.status !== 'eliminated')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const ranking = ranked.map((h, i) =>
    `  ${i + 1}. ${truncate(h.content, 35)} (${h.score!.toFixed(2)}) [${h.evidence.length} ev]`
  ).join('\n');

  // Compute evidence-based score
  const s = hypothesis.evidence.filter((e) => e.type === 'supports').length;
  const r = hypothesis.evidence.filter((e) => e.type === 'refutes').length;
  const total = hypothesis.evidence.length;
  const evidenceRatio = total > 0 ? `+${s} -${r}` : 'no evidence yet';

  let result = JSON.stringify({ hypothesisId: hypothesis.id, score: hypothesis.score }) + '\n\n' +
    `✓ Score: ${hypothesis.score!.toFixed(2)} | Evidence: ${evidenceRatio}\n\n`;

  if (total === 0) {
    result += `⚠ Scoring without evidence creates anchoring bias. Gather evidence first.\n\n`;
  }

  if (ranking) result += `── Ranking ──\n${ranking}\n`;

  // Tie detection: top-2 within 0.15
  if (ranked.length >= 2 && (ranked[0].score! - ranked[1].score!) < 0.15) {
    result += `\n⚠ Near-tie: "${truncate(ranked[0].content, 25)}" and "${truncate(ranked[1].content, 25)}" are within 0.15.\n`;
    result += `What test would SEPARATE them?\n`;
  }

  // Ready-for-confirmation signal
  if (hypothesis.score !== null && hypothesis.score >= 0.85) {
    const siblings = tm.getSiblings(hypothesis.id);
    const allSiblingsWeak = siblings.every((s) => s.status === 'eliminated' || (s.score !== null && s.score < 0.3));
    const someRefutationAttempted = siblings.some((s) => s.evidence.some((e) => e.type === 'refutes'));
    if (allSiblingsWeak && someRefutationAttempted) {
      result += `\n→ Evidence appears sufficient: strong support, alternatives eliminated, refutation attempted. Consider confirmation.\n`;
    }
  }

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatValidateDecomposition(parentId: string, check: StructuralCheck): string {
  let result = JSON.stringify({ parentId, check }) + '\n\n' +
    `── Structural Checks ──\n` +
    `Children: ${check.childCount}\n`;

  if (check.substringOverlaps.length > 0) {
    result += `⚠ Substring overlaps: ${check.substringOverlaps.length} pair(s)\n`;
  } else {
    result += `✓ No substring overlaps\n`;
  }

  if (check.duplicateLabels.length > 0) {
    result += `⚠ Duplicates: ${check.duplicateLabels.join(', ')}\n`;
  }

  result += check.hasCatchAll ? `✓ Has catch-all category\n` : `Note: No catch-all\n`;

  result += `\n── Validation Questions ──\n`;
  result += `ME: Could a single observation belong to two of these hypotheses?\n`;
  result += `CE: Is there a plausible cause not covered by any hypothesis?\n`;
  result += `Level: Are all hypotheses at the same level of abstraction?\n`;

  return result;
}

export function formatStatus(tm: TreeManager): string {
  const status = tm.getStatus();

  if (!status.session) {
    return `No active session. Call create_tree to start.`;
  }

  const { session, counts, stagnant, unexplored, bestLead } = status;
  const total = counts.pending + counts.exploring + counts.eliminated + counts.confirmed;

  let result = `Session: ${session.id.slice(0, 8)} (${session.status})\n` +
    `Problem: "${truncate(session.problem, 70)}"\n` +
    `Progress: ${counts.eliminated + counts.confirmed}/${total} resolved ` +
    `(${counts.eliminated} eliminated, ${counts.confirmed} confirmed, ${counts.exploring} exploring)\n`;

  if (unexplored.length > 0) {
    result += `Unexplored: ${unexplored.map((u) => truncate(u.content, 30)).join(', ')}\n`;
  }
  if (bestLead) {
    result += `Best lead: "${truncate(bestLead.content, 40)}" (score: ${bestLead.score!.toFixed(2)})\n`;
  }
  if (stagnant) {
    result += `\n⚠ STAGNATION: Multiple mutations without progress.\n`;
    result += `  Devil's advocate: Assume your LOWEST-scored active hypothesis is correct. What evidence would you expect to find?\n`;
    result += `  This reframing often reveals overlooked tests.\n`;
  }

  const activeSessions = tm.getAllSessions().filter((s) => s.status === 'active');
  if (activeSessions.length > 1) {
    result += `\nNote: ${activeSessions.length} active sessions. Use get_tree with sessionId to view others.`;
  }

  return result;
}

function formatTreeSummary(tm: TreeManager): string {
  const status = tm.getStatus();
  if (!status.session) return '';

  const { counts, stagnant, unexplored, bestLead } = status;
  const total = counts.pending + counts.exploring + counts.eliminated + counts.confirmed;

  let summary = `── Tree ──\n`;
  summary += `Progress: ${counts.eliminated + counts.confirmed}/${total} resolved`;
  if (counts.exploring > 0) summary += ` | Investigating: ${counts.exploring}`;
  if (unexplored.length > 0) summary += ` | Unexplored: ${unexplored.length}`;
  if (bestLead) summary += ` | Lead: "${truncate(bestLead.content, 20)}" (${bestLead.score!.toFixed(2)})`;
  if (stagnant) summary += `\n⚠ Stagnation — devil's advocate: what if your lowest-scored hypothesis is correct?`;

  return summary;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
