/**
 * Adaptive response formatters for tool results.
 *
 * Signals are grounded in established reasoning methodologies:
 * - Eliminative induction: tables of presence/absence, exclusion of alternatives
 *   as the engine of inference (Bacon, Novum Organum, 1620)
 * - Methods of Agreement and Difference: comparative evidence across cases to
 *   isolate causal factors (Mill, A System of Logic, 1843)
 * - Multiple working hypotheses: parallel hypothesis families guard against
 *   premature commitment to a single explanation (cf. Chamberlin, 1890)
 * - Falsificationism: severity of tests, asymmetry of refutation, corroboration
 *   as provisional retention (Popper, The Logic of Scientific Discovery, 1959)
 * - Strong inference: crucial experiment design, recycling discipline
 *   (cf. Platt, 1964)
 * - Compound causation: real causes are often clusters of jointly sufficient
 *   conditions (Mackie, "Causes and Conditions", 1965)
 * - Analysis of Competing Hypotheses: diagnosticity, red team, sensitivity
 *   (Heuer, Psychology of Intelligence Analysis, 1999; revised 2005)
 *
 * Design principles:
 * - Signals fire conditionally based on tree state (avoid prompt fatigue)
 * - Advisory, never blocking (agents retain autonomy)
 * - Grounded in quantitative signals (evidence counts, depths)
 * - Client-agnostic vocabulary: these strings ship to every MCP client, so
 *   they avoid client-specific concepts (subagent dispatch, slash commands).
 *   Client-specific guidance lives in `skills/` and `agents/`, which are
 *   loaded only by clients that recognize that surface.
 *
 * Threshold rationale:
 * - Confirmation bias: 3+ supporting with 0 refuting (ACH unidirectional evidence)
 * - Staleness: 120s between interactions (re-anchor context)
 * - Elimination nudge: 2+ refuting with 0 supporting
 * - Diagnosticity: supports added with no siblings refuted (non-discriminating)
 * - Premature decomposition: parent has 0 evidence items
 * - Depth caution: children at depth >= 3 (heuristic; deeper trees fragment
 *   investigation across many shallow leaves rather than pursuing few testable ones)
 * - Inference detection: 2+ keywords (suggests/implies/could/might/possibly/likely)
 */

import { isLive, isOpen, undisposedNodes } from './closure.js';
import type { Hypothesis, StructuralCheck } from './types.js';
import type { TreeManager } from './tree-manager.js';

export function formatCreateTree(sessionId: string, rootId: string, problem: string): string {
  return JSON.stringify({ sessionId, rootId }) + '\n\n' +
    `✓ Tree created: "${truncate(problem, 70)}"\n\n` +
    `── Domain Investigation ──\n` +
    `BEFORE decomposing, investigate the problem domain:\n` +
    `1. Gather context: What is the relevant background? What is already known?\n` +
    `2. Characterize the question: What observations are being explained or what decision is being made? What is the scope?\n` +
    `3. Identify boundaries: What is IN scope vs OUT of scope for this investigation?\n\n` +
    `── Decomposition ──\n` +
    `Once you understand the domain, decompose into 2-5 sibling hypotheses.\n` +
    `Choose a framing axis that suits the domain — by mechanism, by location, by stage, by actor, by time, or by population. Whichever axis you pick, make the siblings comparable along it.\n` +
    `Aim for (the underlying set-partition property — overlap is acceptable when it reflects domain co-occurrence):\n` +
    `  Non-overlapping siblings: each hypothesis covers a distinct possibility unless the domain genuinely co-instantiates them.\n` +
    `  Collective coverage: together they cover the plausible space; an explicit catch-all branch is first-class.\n` +
    `For EACH hypothesis, define what observation would REFUTE it.\n` +
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
    result += `Review thoroughly: Did you investigate the domain BEFORE decomposing?\n\n`;
  }

  // Structural checks
  result += `── Checks ──\n`;
  if (check.childCount < 2) result += `⚠ Only ${check.childCount} child — consider adding more\n`;
  if (check.childCount > 7) result += `Note: ${check.childCount} children — consider whether some could be grouped at a higher abstraction level\n`;
  if (check.substringOverlaps.length > 0) result += `⚠ Overlap detected between ${check.substringOverlaps.length} pair(s)\n`;
  if (!check.hasCatchAll) result += `Note: No catch-all — is anything missing?\n`;

  if (check.abstractionMismatch) {
    // Reuse the engine's word counts so the printed range can never drift from
    // the boolean that gated it.
    result += `level-mismatch-advisory: labels range from ${check.minWords} to ${check.maxWords} words — uneven abstraction\n`;
  }

  if (check.substringOverlaps.length === 0 && check.childCount >= 2 && !check.abstractionMismatch) {
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

  // Depth warning: deeper than three levels often indicates fragmentation
  // rather than productive drilling.
  if (children[0] && children[0].depth >= 3) {
    result += `\nDepth ${children[0].depth}: Deep decompositions risk fragmenting the problem. Consider whether the parent is specific enough to test directly.\n`;
  }

  // Decomposition advisory and protocol guidance
  result += `\n── Decomposition Review ──\n`;
  result += `Stop and review this decomposition before proceeding:\n`;
  result += `  Overlap: could a single root cause belong to two of these? If accidental, refine the boundaries; if it reflects domain co-occurrence, consider an explicit "A and B" combined child.\n`;
  result += `  Coverage: imagine a plausible cause NOT covered by ANY of these. If yes, add it (catch-all branches are first-class).\n`;
  result += `  Level: are all hypotheses at the same level of abstraction?\n`;
  // Inline the parent and children content (not bare UUIDs) so the structural
  // review can be performed without an extra get_tree call. Each child is
  // prefixed with an 8-char ID so findings can be mapped back to a specific
  // node on follow-up.
  if (parent) {
    result += `\nStructural review (overlap, coverage, level, testability):\n`;
    result += `  Parent: "${truncate(parent.content, 80)}"\n`;
    for (const c of children) {
      result += `  - ${c.id.slice(0, 8)}: "${truncate(c.content, 80)}"\n`;
    }
  }
  result += `\n── Protocol ──\n`;
  result += `Crucial experiment: What SINGLE observation would yield DIFFERENT results depending on which sub-hypothesis is correct?\n`;
  result += `Prioritize this discriminating test before investigating each in isolation.\n`;

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatAddHypothesis(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const activeSiblings = siblings.filter((s) => isLive(s.status));

  let result = JSON.stringify({ hypothesisId: hypothesis.id }) + '\n\n' +
    `✓ Added hypothesis: "${truncate(hypothesis.content, 60)}"\n\n`;

  result += `── Sibling Review ──\n`;
  result += `Review the full set of ${activeSiblings.length + 1} siblings:\n`;
  result += `  Overlap: does this overlap acknowledge a domain co-occurrence (e.g., an INUS cluster), or is it accidental redundancy?\n`;
  result += `  Coverage: does adding this close a gap, or is there still something missing?\n`;
  result += `Challenge whether this hypothesis is genuinely distinct or whether it should be merged with a sibling.\n\n`;

  result += `── Protocol ──\n`;
  result += `What is the fastest path to REFUTE this hypothesis? Define the test before investigating.\n`;

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatAddEvidence(hypothesisId: string, hypothesis: Hypothesis, tm: TreeManager): string {
  const supporting = hypothesis.evidence.filter((e) => e.type === 'supports').length;
  const refuting = hypothesis.evidence.filter((e) => e.type === 'refutes').length;

  const siblings = tm.getSiblings(hypothesisId);
  const activeSiblings = siblings.filter((s) => isLive(s.status));
  // Genuine rivals to discriminate against are still-open (pending/exploring)
  // siblings — a corroborated sibling is a settled verdict, not a competitor.
  const openSiblings = siblings.filter((s) => isOpen(s.status));

  let result = JSON.stringify({ hypothesisId, evidenceCount: hypothesis.evidence.length }) + '\n\n' +
    `✓ Evidence added to "${truncate(hypothesis.content, 50)}"\n\n`;

  // Evidence matrix across siblings
  result += `── Evidence Matrix ──\n`;
  const allHypotheses = [hypothesis, ...siblings].filter((h) => isLive(h.status));
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
      result += `\nThis reads as inference rather than direct observation. What specific record, measurement, or test would DIRECTLY show the state you're inferring?\n`;
    }
  }

  // Confirmation bias detection + confounder check (Mill 1843)
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
  if (lastEvidence && lastEvidence.type === 'supports' && openSiblings.length > 0) {
    const noSiblingsRefuted = openSiblings.every((s) => s.evidence.filter((e) => e.type === 'refutes').length === 0);
    if (noSiblingsRefuted && hypothesis.evidence.length >= 2) {
      // Name an open rival to make the discrimination concrete. openSiblings is
      // non-empty here, and excludes corroborated siblings (settled verdicts,
      // not competitors).
      const topSibling = openSiblings[0];
      result += `\nDiagnosticity: Would this also hold if "${truncate(topSibling.content, 40)}" were the cause? Evidence consistent with multiple hypotheses does not discriminate.\n`;
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
  if (openSiblings.length > 0 && hypothesis.evidence.length >= 2 && refuting === 0) {
    const topSibling = openSiblings[0];
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
  const remaining = siblings.filter((s) => isLive(s.status));
  // Of the live siblings, only the still-open ones are candidates the agent
  // would corroborate next; a corroborated sibling is already settled.
  const remainingOpen = siblings.filter((s) => isOpen(s.status));

  let result = JSON.stringify({ hypothesisId: hypothesis.id, status: 'eliminated' }) + '\n\n' +
    `✓ Eliminated "${truncate(hypothesis.content, 50)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;

  result += `── Signals ──\n`;
  result += `Remaining: ${remaining.length} (${remaining.map((r) => truncate(r.content, 25)).join(', ')})\n`;

  if (remaining.length === 1 && remainingOpen.length === 1) {
    result += `\n→ Only 1 hypothesis remains. Before corroborating, apply a SEVERE TEST:\n`;
    result += `  Can you REPRODUCE the outcome by instantiating this cause, or predict a previously unobserved consequence and check it?\n`;
    result += `  Challenge this conclusion from different angles — what could you be missing?\n`;
  } else if (remaining.length === 0) {
    const allEliminated = siblings.length > 0 && siblings.every((s) => s.status === 'eliminated');
    if (allEliminated) {
      result += `\n⚠ All siblings eliminated — hypothesis space may be incomplete.\n`;
      result += `Investigate what was missed. Add new hypotheses from fresh perspectives.\n`;
    } else {
      result += `\n⚠ No live siblings remain (every sibling is eliminated or out-of-scope).\n`;
      result += `If the out-of-scope branches were set aside without refutation, consider whether the answer might lie there before closing the investigation.\n`;
    }
  } else {
    result += `\n── Protocol ──\n`;
    result += `What is the most discriminating test to distinguish the remaining ${remaining.length} hypotheses?\n`;
    result += `Investigate each remaining hypothesis independently and challenge assumptions.\n`;
  }

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatCorroborate(hypothesis: Hypothesis, tm: TreeManager): string {
  const state = tm.getTree(hypothesis.sessionId);
  const sessionResolved = state?.session.status === 'resolved';

  let result = JSON.stringify({
    hypothesisId: hypothesis.id,
    status: 'corroborated',
    sessionStatus: state?.session.status ?? 'open',
  }) + '\n\n' +
    `✓ Corroborated "${truncate(hypothesis.content, 50)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;

  if (sessionResolved) {
    const corroboratedLeaves = state ? Array.from(state.hypotheses.values()).filter(
      (h) => h.status === 'corroborated' && h.children.length === 0,
    ) : [];
    result += `── Session resolved ──\n`;
    if (corroboratedLeaves.length > 1) {
      result += `${corroboratedLeaves.length} corroborated leaves (multiple co-instantiated contributors are admissible — Mackie INUS):\n`;
      for (const h of corroboratedLeaves) {
        result += `  - ${h.id.slice(0, 8)}: "${truncate(h.content, 60)}"\n`;
      }
    }
    result += `\nCorroboration is provisional retention (Popper). add_evidence(type='refutes') against any corroborated leaf reopens the session for further investigation; the historical verdict stays in the audit trail.\n`;
  } else {
    // List only the open nodes that actually block resolution, matching the
    // engine's closure walk: nodes under an eliminated/out-of-scope ancestor
    // are moot and excluded, so the count never overstates what the agent
    // must still dispose of.
    const open = state
      ? undisposedNodes(state.session.rootNodeId, (id) => state.hypotheses.get(id))
      : [];
    result += `── Resolution pending ──\n`;
    result += `${open.length} hypothes${open.length === 1 ? 'is' : 'es'} still open:\n`;
    for (const h of open) {
      result += `  - ${h.id.slice(0, 8)} [${h.status}]: "${truncate(h.content, 60)}"\n`;
    }
    result += `\nEach must be eliminated (with refuting evidence), corroborated, or set_out_of_scope before the session resolves.\n`;
  }

  result += `\n── Verification ──\n`;
  result += `1. Does this account for ALL the relevant observations?\n`;
  result += `2. Can you REPRODUCE the outcome by instantiating this cause, or predict a new consequence and check it?\n`;
  result += `3. Were competing hypotheses disposed of with evidence (not just ignored)?\n`;
  result += `4. TEMPORALITY: Did this cause precede the outcome in time?\n`;
  result += `5. SPECIFICITY: Does this explain THIS observed pattern specifically, not just outcomes of this kind in general?\n`;

  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatSetOutOfScope(hypothesis: Hypothesis, tm: TreeManager): string {
  let result = JSON.stringify({ hypothesisId: hypothesis.id, status: 'out-of-scope' }) + '\n\n' +
    `⊘ Out-of-scope "${truncate(hypothesis.content, 50)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;
  result += `Branch set aside without investigation. The audit trail records the choice; closure treats this as pruning.\n`;
  result += '\n' + formatTreeSummary(tm);
  return result;
}

export function formatValidateDecomposition(parentId: string, check: StructuralCheck): string {
  // Advisory output, not pass/fail. Strict mutual exclusivity is rejected
  // for hypothesis sets (Heuer 2005); siblings can overlap when they
  // reflect domain co-occurrence (Mackie INUS).
  const advisories: string[] = [];
  if (check.substringOverlaps.length > 0) advisories.push('overlap-advisory');
  if (check.duplicateLabels.length > 0) advisories.push('overlap-advisory');
  if (!check.hasCatchAll) advisories.push('coverage-gap-advisory');
  if (check.abstractionMismatch) advisories.push('level-mismatch-advisory');
  if (advisories.length === 0) advisories.push('no-issues-detected');

  let result = JSON.stringify({ parentId, advisories: Array.from(new Set(advisories)), check }) + '\n\n' +
    `── Structural Checks ──\n` +
    `Children: ${check.childCount}\n`;

  if (check.substringOverlaps.length > 0) {
    result += `overlap-advisory: ${check.substringOverlaps.length} substring pair(s) — accidental redundancy, or domain co-occurrence (INUS)?\n`;
  } else {
    result += `No substring overlaps detected.\n`;
  }

  if (check.duplicateLabels.length > 0) {
    result += `overlap-advisory: duplicate labels: ${check.duplicateLabels.join(', ')}\n`;
  }

  result += check.hasCatchAll
    ? `Has explicit catch-all branch.\n`
    : `coverage-gap-advisory: no explicit catch-all — closure of the cause space is being claimed by enumeration.\n`;

  if (check.abstractionMismatch) {
    result += `level-mismatch-advisory: child labels span uneven word-count ranges, suggesting mixed abstraction.\n`;
  }

  result += `\n── Review Questions ──\n`;
  result += `\n(testability-advisory cases — unfalsifiable hypotheses — require semantic review of each child's refutability.)\n`;
  result += `Overlap: could a single observation belong to two of these by accident?\n`;
  result += `Coverage: is there a plausible cause not covered by any sibling or catch-all?\n`;
  result += `Level: are all hypotheses at the same level of abstraction?\n`;

  return result;
}

export function formatStatus(tm: TreeManager): string {
  const status = tm.getStatus();

  if (!status.session) {
    return `No open session. Call create_tree to start.`;
  }

  const { session, counts, stagnant, unexplored } = status;
  const breakdown = computeProgressBreakdown(counts);

  let result = `Session: ${session.id.slice(0, 8)} (${session.status})\n` +
    `Problem: "${truncate(session.problem, 70)}"\n` +
    `Progress: ${breakdown.terminal}/${breakdown.total} resolved (${breakdown.resolvedParts.join(', ')})\n`;
  if (breakdown.activeParts.length > 0) result += `Active: ${breakdown.activeParts.join(', ')}\n`;

  if (unexplored.length > 0) {
    result += `Unexplored: ${unexplored.map((u) => truncate(u.content, 30)).join(', ')}\n`;
  }
  if (stagnant) {
    result += `\n⚠ STAGNATION: Multiple mutations without progress.\n`;
    result += `  Devil's advocate: Assume a hypothesis you have challenged least is correct. What evidence would you expect to find?\n`;
    result += `  This reframing often reveals overlooked tests.\n`;
  }

  const openSessions = tm.getAllSessions().filter((s) => s.status === 'open');
  if (openSessions.length > 1) {
    const others = openSessions.filter((s) => s.id !== session.id);
    result += `\nNote: ${openSessions.length} open sessions. View another by passing its full id to get_tree(sessionId): ` +
      others.map((s) => s.id).join(', ');
  }

  return result;
}

function formatTreeSummary(tm: TreeManager): string {
  const status = tm.getStatus();
  if (!status.session) return '';

  const { counts, stagnant } = status;
  const breakdown = computeProgressBreakdown(counts);

  let summary = `── Tree ──\n`;
  summary += `Progress: ${breakdown.terminal}/${breakdown.total} resolved`;
  if (breakdown.activeParts.length > 0) summary += ` | ${breakdown.activeParts.join(', ')}`;
  if (stagnant) summary += `\n⚠ Stagnation — devil's advocate: what if a hypothesis you have challenged least is correct?`;

  return summary;
}

/**
 * Counts of resolved-vs-active hypotheses, decomposed for status renderers.
 * The resolved sub-counts (eliminated, corroborated, out-of-scope) feed the
 * "${terminal}/${total} resolved (...)" parenthetical; the active sub-counts
 * (exploring, pending) feed a separate clause so the breakdown does not mix
 * pruning verdicts with live work.
 */
function computeProgressBreakdown(counts: Record<Hypothesis['status'], number>): {
  terminal: number;
  total: number;
  resolvedParts: string[];
  activeParts: string[];
} {
  const outOfScope = counts['out-of-scope'] ?? 0;
  const terminal = counts.eliminated + counts.corroborated + outOfScope;
  const total = counts.pending + counts.exploring + terminal;
  const resolvedParts = [`${counts.eliminated} eliminated`, `${counts.corroborated} corroborated`];
  if (outOfScope > 0) resolvedParts.push(`${outOfScope} out-of-scope`);
  const activeParts: string[] = [];
  if (counts.exploring > 0) activeParts.push(`${counts.exploring} exploring`);
  if (counts.pending > 0) activeParts.push(`${counts.pending} pending`);
  return { terminal, total, resolvedParts, activeParts };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
