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
 *   they avoid concepts specific to any one client's feature surface.
 *   Client-specific guidance lives in `skills/` and `agents/`, loaded only by
 *   clients that recognize that surface.
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
import {
  countSupporting,
  countRefuting,
  needsBaselinePrompt,
  readsAsInference,
  isConfirmationBias,
  lacksSourceDiversity,
  suggestsElimination,
  lacksDiagnosticity,
  readsAsRetypedOutput,
} from './advisories.js';
import { nodeLabel, supportingWeight, refutingWeight, gateLabel, gateMeaning, gateFindings } from '@tot-mcp/shared';
import { pickActiveSession } from './persistence.js';
import type { Decomposition, DecompositionGate, Hypothesis, StructuralCheck } from './types.js';
import type { TreeManager } from './tree-manager.js';
import type { SessionSummary } from './project-state.js';

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

/** What a gate commits to, as one line. */
function gateLine(gate: DecompositionGate): string {
  return `${gateLabel(gate)}: ${gateMeaning(gate)}\n`;
}

/**
 * A recorded split: the dimension its children divide, then what the declared
 * relation commits to — or how to declare one, since a missing relation is the
 * reason a verdict on a child says nothing about its parent.
 */
function formatSplit(decomposition: Decomposition): string {
  return `Axis: ${decomposition.axis}\n` + (decomposition.gate
    ? gateLine(decomposition.gate)
    : `Relation not declared. State gate=one-of when the children are rivals, any-of when several may hold together, or all-of when every part is required.\n`);
}

export function formatDecompose(children: Hypothesis[], check: StructuralCheck, tm: TreeManager): string {
  const parent = tm.getHypothesis(children[0]?.parentId ?? '');
  const ids = children.map((c) => c.id);
  const isRootDecomposition = children[0]?.depth === 1;
  let result = JSON.stringify({ childIds: ids }) + '\n\n' +
    `✓ Decomposed into ${children.length} sub-hypotheses\n\n`;

  if (isRootDecomposition) {
    result += `── Initial Structure (Critical) ──\n`;
    result += `This is the foundational decomposition. Its quality determines the entire investigation.\n`;
    result += `Review thoroughly: Did you investigate the domain BEFORE decomposing?\n\n`;
  }

  // The declared split: what the children divide, and what follows from how
  // they relate. Restated because a gate governs which verdicts are consistent
  // with each other later.
  if (parent?.decomposition) {
    result += `── Split ──\n`;
    result += formatSplit(parent.decomposition);
    result += `\n`;
  }

  // Structural checks
  result += `── Checks ──\n`;
  if (check.childCount < 2) result += `⚠ Only ${check.childCount} child — consider adding more\n`;
  if (check.childCount > 7) result += `Note: ${check.childCount} children — consider whether some could be grouped at a higher abstraction level\n`;
  if (check.substringOverlaps.length > 0) {
    result += `⚠ ${check.substringOverlaps.length} label pair(s) where one contains the other — accidental redundancy, or real co-occurrence?\n`;
  }
  if (check.combinedLabels.length > 0) {
    result += `Note: "${check.combinedLabels.join('", "')}" reads as a combined child of two siblings — first-class where the co-occurrence is real.\n`;
  }
  if (check.catchAllLabels.length === 0) {
    result += `Note: no label reads as a residual — is anything missing?\n`;
  }

  // Names what was actually examined. An unqualified "no structural issues"
  // would assert a clean bill on sets this check cannot speak to — level of
  // abstraction among them — which is the same overclaim in the other direction.
  if (check.substringOverlaps.length === 0 && check.childCount >= 2) {
    result += `No label contains another, and no label repeats.\n`;
  }

  // Premature decomposition guard: parent had no evidence
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
    result += `  Parent: "${nodeLabel(parent)}"\n`;
    for (const c of children) {
      result += `  - ${c.id.slice(0, 8)}: "${nodeLabel(c)}"\n`;
    }
  }
  result += `\n── Protocol ──\n`;
  result += `Crucial experiment: What SINGLE observation would yield DIFFERENT results depending on which sub-hypothesis is correct?\n`;
  result += `Prioritize this discriminating test before investigating each in isolation.\n`;

  result += '\n' + formatTreeSummary(tm, children[0]?.sessionId);
  return result;
}

export function formatAddHypothesis(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const activeSiblings = siblings.filter((s) => isLive(s.status));

  let result = JSON.stringify({ hypothesisId: hypothesis.id }) + '\n\n' +
    `✓ Added hypothesis: "${nodeLabel(hypothesis)}"\n\n`;

  result += `── Sibling Review ──\n`;
  // A sibling added later must divide the same dimension as the ones already
  // there, or the set no longer compares along one axis.
  const parentSplit = hypothesis.parentId ? tm.getHypothesis(hypothesis.parentId)?.decomposition : undefined;
  if (parentSplit) {
    result += `Axis: ${parentSplit.axis} — does this divide that same dimension?\n`;
    if (parentSplit.gate) result += gateLine(parentSplit.gate);
  }
  result += `Review the full set of ${activeSiblings.length + 1} siblings:\n`;
  result += `  Overlap: does this overlap acknowledge a domain co-occurrence (e.g., an INUS cluster), or is it accidental redundancy?\n`;
  result += `  Coverage: does adding this close a gap, or is there still something missing?\n`;
  result += `Challenge whether this hypothesis is genuinely distinct or whether it should be merged with a sibling.\n\n`;

  result += `── Protocol ──\n`;
  result += `What is the fastest path to REFUTE this hypothesis? Define the test before investigating.\n`;

  result += '\n' + formatTreeSummary(tm, hypothesis.sessionId);
  return result;
}

export function formatAddEvidence(hypothesisId: string, hypothesis: Hypothesis, tm: TreeManager): string {
  // Reuse the advisory module's counts so the gate that fires and the number
  // printed in the warning string cannot drift apart.
  const supporting = countSupporting(hypothesis);
  const refuting = countRefuting(hypothesis);

  const siblings = tm.getSiblings(hypothesisId);
  const activeSiblings = siblings.filter((s) => isLive(s.status));
  // Genuine rivals to discriminate against are still-open (pending/exploring)
  // siblings — a corroborated sibling is a settled verdict, not a competitor.
  const openSiblings = siblings.filter((s) => isOpen(s.status));

  let result = JSON.stringify({ hypothesisId, evidenceCount: hypothesis.evidence.length }) + '\n\n' +
    `✓ Evidence added to "${nodeLabel(hypothesis)}"\n\n`;

  // Evidence matrix across siblings
  result += `── Evidence Matrix ──\n`;
  const allHypotheses = [hypothesis, ...siblings].filter((h) => isLive(h.status));
  for (const h of allHypotheses) {
    const s = h.evidence.filter((e) => e.type === 'supports').length;
    const r = h.evidence.filter((e) => e.type === 'refutes').length;
    const marker = h.id === hypothesisId ? ' ←' : '';
    result += `  ${nodeLabel(h)}: +${s} -${r}${marker}\n`;
  }

  // Baseline prompt: first evidence on this hypothesis
  if (needsBaselinePrompt(hypothesis)) {
    result += `\nHave you established the baseline? Knowing what 'normal' looks like before the problem makes this observation more diagnostic.\n`;
  }

  // Directness detection: inference-language in evidence content
  if (readsAsInference(hypothesis)) {
    result += `\nThis reads as inference rather than direct observation. What specific record, measurement, or test would DIRECTLY show the state you're inferring?\n`;
  }

  // Confirmation bias detection + confounder check (Popper asymmetry; Mill 1843)
  if (isConfirmationBias(hypothesis, siblings)) {
    result += `\n⚠ Confirmation bias: ${supporting} supporting, 0 refuting. What would REFUTE this?\n`;
    result += `Could a confounding variable explain these observations without this hypothesis being true?\n`;
  }

  // Text that lives only inside a record cannot be re-read; a file it came from
  // can be. What was observed is the shape of the record, not where it came from.
  if (readsAsRetypedOutput(hypothesis)) {
    result += `\nThis record spans several lines and cites no captured bytes. If that text came from a file or a command, pass artifactPath so the bytes themselves are stored and can be read back verbatim.\n`;
  }

  // Source independence (Heuer 1999)
  if (lacksSourceDiversity(hypothesis)) {
    result += `\nAll evidence cites the same source. Independent corroboration from a different data source would strengthen this.\n`;
  }

  // Unexplored siblings warning
  const unexplored = activeSiblings.filter((s) => s.evidence.length === 0);
  if (unexplored.length > 0) {
    result += `\nUnexplored: ${unexplored.map((u) => nodeLabel(u)).join(', ')}\n`;
  }

  // Elimination nudge (Bacon/Mill eliminative induction). Reported in the weights
  // that gated it: printing raw record counts would state a total the gate never
  // established, and a hardcoded zero would deny supporting records the ledger
  // holds but does not weigh.
  if (suggestsElimination(hypothesis)) {
    const refutingW = refutingWeight(hypothesis);
    const supportingW = supportingWeight(hypothesis);
    result += `\n→ weighed ${refutingW} refuting against ${supportingW} supporting — consider elimination.\n`;
  }

  // Diagnosticity: evidence that doesn't discriminate (Heuer 1999, Popper 1959)
  if (lacksDiagnosticity(hypothesis, siblings)) {
    // Name an open rival to make the discrimination concrete. openSiblings is
    // non-empty here (lacksDiagnosticity requires it), and excludes
    // corroborated siblings (settled verdicts, not competitors).
    const topSibling = openSiblings[0];
    result += `\nDiagnosticity: Would this also hold if "${nodeLabel(topSibling)}" were the cause? Evidence consistent with multiple hypotheses does not discriminate.\n`;
  }

  // Stale tree detection
  const secsSinceLastCall = tm.getSecondsSinceLastInteraction();
  if (secsSinceLastCall > 120) {
    const session = tm.getActiveSession();
    result += `\n── Context (${Math.floor(secsSinceLastCall / 60)}m since last update) ──\n`;
    if (session) result += `Problem: "${truncate(session.problem, 50)}"\n`;
    result += `You were testing: "${nodeLabel(hypothesis)}"\n`;
  }

  // Protocol — with specific named siblings for adversarial questions
  result += `\n── Protocol ──\n`;
  if (openSiblings.length > 0 && hypothesis.evidence.length >= 2 && refuting === 0) {
    const topSibling = openSiblings[0];
    result += `What observation would be TRUE if "${nodeLabel(hypothesis)}" but FALSE if "${nodeLabel(topSibling)}"?\n`;
  } else if (activeSiblings.length > 1) {
    result += `Does this evidence also bear on sibling hypotheses?\n`;
  }
  if (hypothesis.evidence.length >= 2 && refuting === 0) {
    result += `Seek REFUTING evidence: what test would prove this hypothesis WRONG?\n`;
  }

  result += '\n' + formatTreeSummary(tm, hypothesis.sessionId);
  return result;
}

/**
 * Conflicts a verdict on this node creates with the split it belongs to.
 *
 * A gate is the agent's declaration about how siblings relate, so what is
 * reported is the contradiction between that declaration and the verdicts now
 * recorded — never a judgement that a split is exclusive or exhaustive in fact.
 * Empty when the node has no parent, or its parent declared no relation.
 */
function formatGateConflicts(hypothesis: Hypothesis, tm: TreeManager): string {
  const parent = hypothesis.parentId ? tm.getHypothesis(hypothesis.parentId) : undefined;
  if (!parent?.decomposition?.gate) return '';
  const siblings = parent.children
    .map((id) => tm.getHypothesis(id))
    .filter((c): c is Hypothesis => c !== undefined);
  const findings = gateFindings(parent, siblings);
  if (findings.length === 0) return '';

  let out = `\n── Split: "${nodeLabel(parent)}" (${gateLabel(parent.decomposition.gate)}, ${parent.decomposition.axis}) ──\n`;
  for (const finding of findings) {
    out += `⚠ ${finding.message}\n`;
    const affected = finding.nodeIds.map((id) => {
      const node = tm.getHypothesis(id);
      return node ? nodeLabel(node) : id;
    });
    out += `  Affected: ${affected.join(', ')}\n`;
  }
  return out;
}

export function formatEliminate(hypothesis: Hypothesis, tm: TreeManager): string {
  const siblings = tm.getSiblings(hypothesis.id);
  const remaining = siblings.filter((s) => isLive(s.status));
  // Of the live siblings, only the still-open ones are candidates the agent
  // would corroborate next; a corroborated sibling is already settled.
  const remainingOpen = siblings.filter((s) => isOpen(s.status));

  let result = JSON.stringify({ hypothesisId: hypothesis.id, status: 'eliminated' }) + '\n\n' +
    `✓ Eliminated "${nodeLabel(hypothesis)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;

  result += `── Signals ──\n`;
  result += `Remaining: ${remaining.length} (${remaining.map((r) => nodeLabel(r)).join(', ')})\n`;

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

  result += formatGateConflicts(hypothesis, tm);
  result += '\n' + formatTreeSummary(tm, hypothesis.sessionId);
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
    `✓ Corroborated "${nodeLabel(hypothesis)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;

  if (sessionResolved) {
    const corroboratedLeaves = state ? Array.from(state.hypotheses.values()).filter(
      (h) => h.status === 'corroborated' && h.children.length === 0,
    ) : [];
    result += `── Session resolved ──\n`;
    if (corroboratedLeaves.length > 1) {
      result += `${corroboratedLeaves.length} corroborated leaves (multiple co-instantiated contributors are admissible — Mackie INUS):\n`;
      for (const h of corroboratedLeaves) {
        result += `  - ${h.id.slice(0, 8)}: "${nodeLabel(h)}"\n`;
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
      result += `  - ${h.id.slice(0, 8)} [${h.status}]: "${nodeLabel(h)}"\n`;
    }
    result += `\nEach must be eliminated (with refuting evidence), corroborated, or set_out_of_scope before the session resolves.\n`;
  }

  // A verdict that contradicts the declared relation is a property of the
  // verdicts, not of closure: it reaches the agent while the split is still open
  // and something can be done about it.
  result += formatGateConflicts(hypothesis, tm);

  result += `\n── Verification ──\n`;
  result += `1. Does this account for ALL the relevant observations?\n`;
  result += `2. Can you REPRODUCE the outcome by instantiating this cause, or predict a new consequence and check it?\n`;
  result += `3. Were competing hypotheses disposed of with evidence (not just ignored)?\n`;
  result += `4. TEMPORALITY: Did this cause precede the outcome in time?\n`;
  result += `5. SPECIFICITY: Does this explain THIS observed pattern specifically, not just outcomes of this kind in general?\n`;

  result += '\n' + formatTreeSummary(tm, hypothesis.sessionId);
  return result;
}

export function formatSetOutOfScope(hypothesis: Hypothesis, tm: TreeManager): string {
  let result = JSON.stringify({ hypothesisId: hypothesis.id, status: 'out-of-scope' }) + '\n\n' +
    `⊘ Out-of-scope "${nodeLabel(hypothesis)}"\n` +
    `  Reason: ${truncate(hypothesis.conclusion!.reason, 80)}\n\n`;
  result += `Branch set aside without investigation. The audit trail records the choice; closure treats this as pruning.\n`;
  result += formatGateConflicts(hypothesis, tm);
  result += '\n' + formatTreeSummary(tm, hypothesis.sessionId);
  return result;
}

export function formatValidateDecomposition(
  parentId: string,
  check: StructuralCheck,
  decomposition?: Decomposition,
): string {
  // Advisory output, not pass/fail. Strict mutual exclusivity is rejected
  // for hypothesis sets (Heuer 2005); siblings can overlap when they
  // reflect domain co-occurrence (Mackie INUS).
  const advisories: string[] = [];
  if (check.substringOverlaps.length > 0) advisories.push('overlap-advisory');
  if (check.duplicateLabels.length > 0) advisories.push('overlap-advisory');
  if (check.catchAllLabels.length === 0) advisories.push('coverage-gap-advisory');
  // Names what was examined rather than declaring the decomposition sound. This
  // check speaks to overlap and coverage; whether siblings sit at one level of
  // abstraction is not something it can establish, so an unqualified all-clear
  // would assert more here than the prose beside it does.
  if (advisories.length === 0) advisories.push('no-overlap-or-coverage-issues-detected');

  let result = JSON.stringify({
    parentId,
    advisories: Array.from(new Set(advisories)),
    check,
    ...(decomposition === undefined ? {} : { decomposition }),
  }) + '\n\n';

  // The axis is what the overlap and coverage questions below are asked
  // against; without it they have no stated dimension to be judged on.
  if (decomposition) {
    result += `── Split ──\n`;
    result += formatSplit(decomposition) + `\n`;
  }

  result += `── Structural Checks ──\n` +
    `Children: ${check.childCount}\n`;

  if (check.substringOverlaps.length > 0) {
    result += `overlap-advisory: ${check.substringOverlaps.length} substring pair(s) — accidental redundancy, or domain co-occurrence (INUS)?\n`;
  } else {
    result += `No sibling label contains another.\n`;
  }

  if (check.combinedLabels.length > 0) {
    result += `Combined child: "${check.combinedLabels.join('", "')}" states two siblings jointly. `
      + `First-class where the co-occurrence is real (Mackie INUS); it contains its conjuncts by construction, so that containment is not reported as redundancy.\n`;
  }

  if (check.duplicateLabels.length > 0) {
    result += `overlap-advisory: duplicate labels: ${check.duplicateLabels.join(', ')}\n`;
  }

  // A lexical read of the labels, reported as one: whether a branch actually
  // holds the residual is a claim about what it denotes, which the wording
  // cannot settle in either direction.
  result += check.catchAllLabels.length > 0
    ? `"${check.catchAllLabels.join('", "')}" reads as a residual branch — is that what it holds?\n`
    : `coverage-gap-advisory: no label reads as a residual, so this set states closure by enumeration.\n`;


  result += `\n── Review Questions ──\n`;
  result += `\n(testability-advisory cases — unfalsifiable hypotheses — require semantic review of each child's refutability.)\n`;
  result += `Overlap: could a single observation belong to two of these by accident?\n`;
  result += `Coverage: is there a plausible cause not covered by any sibling or catch-all?\n`;
  result += `Level: are all hypotheses at the same level of abstraction?\n`;

  return result;
}

/** Confirms a re-label and restates the resulting weights, so the caller sees
 *  what the change did to the tally rather than only that it was accepted. */
export function formatQualifyEvidence(hypothesis: Hypothesis, evidenceId: string, tm: TreeManager): string {
  const record = hypothesis.evidence.find((e) => e.id === evidenceId);
  const marks = [
    record?.decisive ? 'decisive' : null,
    record?.nonDiagnostic ? 'not discriminating' : null,
    record?.linkedGroupId ? `linked to group ${record.linkedGroupId}` : null,
  ].filter(Boolean);
  return `✓ Evidence ${evidenceId.slice(0, 8)} on "${nodeLabel(hypothesis)}" is now ${marks.join(', ') || 'unqualified'}\n\n` +
    `Weight: ${supportingWeight(hypothesis)} supporting, ${refutingWeight(hypothesis)} refuting ` +
    `(${countSupporting(hypothesis)} and ${countRefuting(hypothesis)} records)\n` +
    `A record that does not discriminate is retained and still listed; it stops counting toward a verdict.\n\n` +
    formatTreeSummary(tm, hypothesis.sessionId);
}

/**
 * What a read reports when the project holds no tree at all.
 *
 * Shared by every read surface: an absent tree is one condition, so a caller
 * (or a skill quoting the text) has one string to recognize. It does not say
 * "open", because neither read requires an open session.
 */
export const NO_SESSION_MESSAGE = 'No session yet for this project. Call create_tree to start.';

/** How many other sessions the status read-out names before deferring to the dashboard. */
const SESSIONS_LISTED = 5;

/**
 * The "other sessions" block: full ids, newest first, so a caller can pass one
 * to get_tree.
 *
 * Ids are given in full rather than the 8-char display form because that is
 * what get_tree takes. The list is bounded and says how many it is naming out
 * of how many exist, so a long project history neither floods the read-out nor
 * hides sessions behind a silent cut.
 */
function formatOtherSessions(all: SessionSummary[], currentId: string): string {
  const others = all.filter((s) => s.id !== currentId);
  if (others.length === 0) return '';
  const shown = others.slice(0, SESSIONS_LISTED);
  const scope = shown.length === others.length
    ? `${others.length} other session${others.length === 1 ? '' : 's'}`
    : `${shown.length} of ${others.length} other sessions, newest first`;
  return `\nAlso in this project (${scope}); pass a full id to get_tree(sessionId):\n`
    + shown.map((s) => `  ${s.id} (${s.status}) "${truncate(s.problem, 50)}"`).join('\n') + '\n';
}

/** What the status read-out needs beyond the engine itself. */
export interface StatusContext {
  /** Where the dashboard is serving, when it started. */
  dashboardUrl?: string | null;
  /** Every session of the project, so the read-out can name the others. */
  listSessions?: () => SessionSummary[];
  /** Session to summarize; defaults to the most recent open, else most recent. */
  sessionId?: string;
}

export function formatStatus(tm: TreeManager, context: StatusContext = {}): string {
  const { dashboardUrl = null, listSessions, sessionId } = context;
  // Summarize the same session the dashboard renders: the active one when an
  // investigation is in progress, otherwise the most recent. This keeps the
  // status read-out — and the dashboard URL it carries — available for a tree
  // whose branches have all reached a terminal state, not just a live one.
  const allSessions = tm.getAllSessions();
  const session = sessionId !== undefined
    ? allSessions.find((s) => s.id === sessionId)
    : pickActiveSession(allSessions);
  if (!session) {
    // A named session that is absent is a different condition from a project
    // with no tree, and saying the latter would deny trees this project has.
    if (sessionId !== undefined) return `No such session: ${sessionId}`;
    // The dashboard is already serving, and shows an empty state until a tree
    // exists, so the URL is reported here too — it is the only place the
    // ephemeral port is published, and withholding it would leave a caller
    // told to open the dashboard with no address to open.
    return dashboardUrl ? `${NO_SESSION_MESSAGE}\nVisualization: ${dashboardUrl}` : NO_SESSION_MESSAGE;
  }

  const { counts, stagnant, unexplored } = tm.getStatus(session.id);
  const breakdown = computeProgressBreakdown(counts);

  let result = `Session: ${session.id.slice(0, 8)} (${session.status})\n` +
    `Problem: "${truncate(session.problem, 70)}"\n` +
    `Progress: ${breakdown.terminal}/${breakdown.total} resolved (${breakdown.resolvedParts.join(', ')})\n`;

  // Live-work clauses (active counts, unexplored branches, stagnation) apply
  // only while the session is open. A terminal session can still carry pending
  // descendants under a pruned branch, but closure has mooted them, so
  // reporting them as work would misrepresent a completed investigation.
  if (session.status === 'open') {
    if (breakdown.activeParts.length > 0) result += `Active: ${breakdown.activeParts.join(', ')}\n`;
    if (unexplored.length > 0) {
      result += `Unexplored: ${unexplored.map((u) => nodeLabel(u)).join(', ')}\n`;
    }
    if (stagnant) {
      result += `\n⚠ STAGNATION: Multiple mutations without progress.\n`;
      result += `  Devil's advocate: Assume a hypothesis you have challenged least is correct. What evidence would you expect to find?\n`;
      result += `  This reframing often reveals overlooked tests.\n`;
    }
  }

  // Sessions this project holds beyond the one summarized above. Drawn from the
  // catalog rather than from memory, because only one session is loaded at
  // start-up: without it, a finished investigation has no id a caller could
  // discover, and nothing to pass to get_tree.
  result += formatOtherSessions(
    listSessions?.() ?? allSessions.map((s) => ({
      id: s.id, problem: s.problem, status: s.status, createdAt: s.createdAt, nodeCount: 0,
    })),
    session.id,
  );

  if (dashboardUrl) {
    result += `\nVisualization: ${dashboardUrl}`;
  }

  return result;
}

function formatTreeSummary(tm: TreeManager, sessionId?: string): string {
  // Scoped to the session the caller just mutated. Eliminating or setting a
  // branch out of scope deliberately does not promote its session, so reading
  // the active one here would print a different tree's tally beside this
  // response.
  const status = tm.getStatus(sessionId);
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
