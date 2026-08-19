import { gateFindings, gateLabel, gateMeaning, nodeLabel, type Hypothesis } from '../types';

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
  /** Hover text explaining what the declaration commits to. */
  title: string;
}

/** What a parent's node face shows about how it was split, or null when it has
 *  no children or no recorded split. */
export function splitBadge(h: Hypothesis): SplitBadge | null {
  const split = h.decomposition;
  if (!split || h.children.length === 0) return null;
  return {
    label: split.gate ? gateLabel(split.gate) : null,
    axis: split.axis,
    title: split.gate
      ? `${gateLabel(split.gate)} — ${gateMeaning(split.gate)}`
      : `Split ${split.axis}. How these children relate was not declared.`,
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
