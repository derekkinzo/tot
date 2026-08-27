/**
 * Pure derivation of the follow-mode target node, factored out of useFollowMode
 * so the transition (including the session-change reset) is unit-testable.
 */
export interface FollowTargetInputs {
  /** The displayed session. */
  sessionId: string | null;
  /** The session displayed on the prior derivation. */
  prevSessionId: string | null;
  /** The node the agent touched last, whatever the kind of activity. */
  lastActivityId: string | null;
}

/**
 * Returns the next follow target given the prior one and the activity signals.
 *
 * - The node the agent touched last wins, whether it was added, updated, or
 *   given evidence. Recency decides, not the kind of activity: an agent that
 *   decomposes and then gathers evidence on the first child has most recently
 *   acted on a node added before the last one.
 * - With no fresh signal the prior target is retained, so enabling follow during
 *   a quiet moment still focuses the active hypothesis.
 * - When the displayed session changes, the prior target (a node from the old
 *   session that is absent from the new tree) is dropped first, so a stale
 *   signal cannot pin selection to a node that no longer exists.
 */
export function nextFollowTarget(prevTarget: string | null, inputs: FollowTargetInputs): string | null {
  const { sessionId, prevSessionId, lastActivityId } = inputs;
  const base = sessionId !== prevSessionId ? null : prevTarget;
  return lastActivityId ?? base;
}
