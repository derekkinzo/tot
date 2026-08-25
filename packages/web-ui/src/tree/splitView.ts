import { gateFindings, gateLabel, gateMeaning, nodeLabel, type GateFindingKind, type Hypothesis } from '../types';

/**
 * Pure projections of a recorded split for display.
 *
 * The axis and the relation are the agent's declarations, so both are shown as
 * stated and neither is inferred: a canvas that guessed a relation would put a
 * claim on screen that nobody made.
 */

export interface SplitBadge {
  /** Short gate label, or null when the relation was left undeclared. */
  label: string | null;
  axis: string;
  /** What the declared relation commits to — or, undeclared, that nobody said. */
  meaning: string;
  /** Hover text: the whole declaration on one line. */
  title: string;
}

/**
 * What a display shows about how a node was split, or null when it has no
 * children or no recorded split.
 *
 * Carries the parts as well as the joined line, so a panel with room for prose
 * and a node face with room for a badge render one composition rather than each
 * assembling its own.
 */
export function splitBadge(h: Hypothesis): SplitBadge | null {
  const split = h.decomposition;
  if (!split || h.children.length === 0) return null;
  const label = split.gate ? gateLabel(split.gate) : null;
  const meaning = split.gate
    ? gateMeaning(split.gate)
    : 'How these children relate was not declared.';
  return {
    label,
    axis: split.axis,
    meaning,
    title: label ? `${label} — ${meaning}` : `Split ${split.axis}. ${meaning}`,
  };
}

export interface SplitConflict {
  message: string;
  /** The children the conflict rests on, labelled as the canvas labels them. */
  nodes: { id: string; label: string }[];
}

/**
 * Conflicts between a node's declared relation and the verdicts its children
 * carry.
 *
 * Reuses the engine's rules rather than restating them, so the dashboard and a
 * tool response cannot disagree about what conflicts with what.
 */
export function splitConflicts(h: Hypothesis, hypotheses: Map<string, Hypothesis>): SplitConflict[] {
  const children = h.children
    .map((id) => hypotheses.get(id))
    .filter((c): c is Hypothesis => c !== undefined);
  return gateFindings(h, children).map((finding) => ({
    message: finding.message,
    nodes: finding.nodeIds.map((id) => {
      const child = hypotheses.get(id);
      return { id, label: child ? nodeLabel(child) : id };
    }),
  }));
}

/**
 * What a node face should draw attention to about its split, or null when the
 * recorded verdicts sit comfortably under the declaration.
 *
 * - `contradiction`: a verdict is incompatible with what the split declared.
 * - `gap`: nothing contradicts it, but part of the space was set aside untested.
 *
 * Kept apart because they call for opposite things. Naming a set-aside branch a
 * contradiction would assert a refutation nobody recorded; naming a real
 * contradiction a gap would understate it. A face carrying both reports the
 * contradiction, which is the stronger claim.
 */
export type SplitAttention = 'contradiction' | 'gap';

/** Findings that report untested space rather than an incompatible verdict. */
const GAP_KINDS: ReadonlySet<GateFindingKind> = new Set<GateFindingKind>([
  'required-part-untested',
  'alternatives-abandoned',
]);

export function splitAttention(h: Hypothesis, hypotheses: Map<string, Hypothesis>): SplitAttention | null {
  const children = h.children
    .map((id) => hypotheses.get(id))
    .filter((c): c is Hypothesis => c !== undefined);
  const kinds = gateFindings(h, children).map((f) => f.kind);
  if (kinds.length === 0) return null;
  return kinds.some((k) => !GAP_KINDS.has(k)) ? 'contradiction' : 'gap';
}
