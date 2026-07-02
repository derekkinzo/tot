/**
 * Pure derivation of the follow-mode target node, factored out of useFollowMode
 * so the transition (including the session-change reset) is unit-testable.
 */
export interface FollowTargetInputs {
  /** The displayed session. */
  sessionId: string | null;
  /** The session displayed on the prior derivation. */
  prevSessionId: string | null;
  lastAddedId: string | null;
  recentlyChanged: Set<string>;
}

/**
 * Returns the next follow target given the prior one and the activity signals.
 *
 * - A just-added node wins; otherwise the most-recently-changed node.
 * - With no fresh signal the prior target is retained, so enabling follow during
 *   a quiet moment still focuses the active hypothesis.
 * - When the displayed session changes, the prior target (a node from the old
 *   session that is absent from the new tree) is dropped first, so a stale
 *   signal cannot pin selection to a node that no longer exists.
 */
export function nextFollowTarget(prevTarget: string | null, inputs: FollowTargetInputs): string | null {
  const { sessionId, prevSessionId, lastAddedId, recentlyChanged } = inputs;
  const base = sessionId !== prevSessionId ? null : prevTarget;
  if (lastAddedId) return lastAddedId;
  if (recentlyChanged.size > 0) return [...recentlyChanged][recentlyChanged.size - 1];
  return base;
}
