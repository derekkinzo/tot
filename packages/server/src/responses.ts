/**
 * Response formatting with embedded cognitive-bias detection.
 *
 * Threshold rationale:
 *
 * - Confirmation bias: 3+ supporting evidence with 0 refuting triggers a warning.
 *   Based on Analysis of Competing Hypotheses (ACH): unidirectional evidence is
 *   a reliable signal that the agent is only seeking confirming data.
 *
 * - Staleness: 120s (2 minutes) between interactions suggests the agent "forgot"
 *   the tree exists. The response re-states context (problem + current hypothesis)
 *   to re-anchor the agent without requiring a separate get_tree call.
 *
 * - Elimination nudge: 2+ refuting evidence with 0 supporting suggests the
 *   hypothesis should be eliminated. The prompt nudges rather than auto-eliminates
 *   because the agent may have unstated context.
 *
 * - Tie detection: 0.15 gap between top-2 scored hypotheses means insufficient
 *   discrimination. The agent is prompted to find a differentiating test.
 *
 * - Domain hints: keyword-based (error/slow/intermittent) for decomposition frame
 *   suggestions. These are heuristic starting points, not prescriptive frameworks.
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
    `── Next Step ──\n` +
    `Decompose into 2-5 MECE hypotheses.\n` +
    (domainHint ? domainHint : '') +
    `For EACH hypothesis, define what TEST would REFUTE it.\n` +
    `Execute the most discriminating test first (one that separates hypotheses).\n\n` +
    `── Tree ──\n` +
    `0 hypotheses | Session: ${sessionId.slice(0, 8)}`;
}

export function formatDecompose(children: Hypothesis[], check: StructuralCheck, tm: TreeManager): string {
  const ids = children.map((c) => c.id);
  let result = JSON.stringify({ childIds: ids }) + '\n\n' +
    `✓ Decomposed into ${children.length} sub-hypotheses\n\n`;

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

  // Protocol guidance
  result += `\n── Protocol ──\n`;
  result += `ME check: Could a single cause belong to two of these?\n`;
  result += `CE check: Can you imagine a cause NOT covered by any of these?\n`;
  result += `Next: For each hypothesis, what test would REFUTE it? Start with the most discriminating test.\n`;

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatAddHypothesis(hypothesis: Hypothesis, tm: TreeManager): string {
  return JSON.stringify({ hypothesisId: hypothesis.id }) + '\n\n' +
    `✓ Added hypothesis: "${truncate(hypothesis.content, 60)}"\n\n` +
    `── Protocol ──\n` +
    `Siblings may need MECE re-validation. What test would REFUTE this new hypothesis?\n\n` +
    formatTreeSummary(tm);
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

  // Confirmation bias detection
  if (supporting >= 3 && refuting === 0 && activeSiblings.length > 0) {
    result += `\n⚠ Confirmation bias: ${supporting} supporting, 0 refuting. What would REFUTE this?\n`;
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

  // Diagnosticity warning: evidence that doesn't discriminate between hypotheses
  const lastEvidence = hypothesis.evidence[hypothesis.evidence.length - 1];
  if (lastEvidence && lastEvidence.type !== 'refutes' && activeSiblings.length > 0) {
    const allConsistent = activeSiblings.every((s) => s.evidence.filter((e) => e.type === 'refutes').length === 0);
    if (allConsistent && hypothesis.evidence.length >= 2) {
      result += `\nNote: No hypothesis has been refuted yet. Seek a test that would ELIMINATE at least one.\n`;
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
  } else if (remaining.length === 0) {
    result += `\n⚠ All siblings eliminated — hypothesis space may be incomplete. Add new hypotheses.\n`;
  } else {
    result += `\n── Protocol ──\n`;
    result += `What is the most discriminating test to distinguish the remaining ${remaining.length} hypotheses?\n`;
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
    result += `  Consider: Is evidence discriminating? Should you restructure?\n`;
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
  if (stagnant) summary += `\n⚠ Stagnation — seek discriminating evidence or restructure`;

  return summary;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
