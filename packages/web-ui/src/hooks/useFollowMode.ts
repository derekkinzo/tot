import { useState, useEffect, useCallback, useRef } from 'react';
import { nextFollowTarget } from './followTarget';

type FollowState = 'following' | 'paused';

interface UseFollowModeOptions {
  /** The displayed session; a change resets the follow target. */
  sessionId: string | null;
  lastAddedId: string | null;
  recentlyChanged: Set<string>;
}

interface UseFollowModeReturn {
  followMode: FollowState;
  followTarget: string | null;
  toggleFollow: () => void;
}

/**
 * Tracks the most recent agent activity so the view can pin to it while
 * following. Follow mode is toggled only by the user (button or F key); it
 * is never paused by selection or viewport changes. `followTarget` retains
 * the last active node id even after the transient highlight clears, so
 * enabling follow during a quiet moment still focuses the active hypothesis —
 * except across a session switch, which drops the prior session's target so
 * follow cannot pin to a node absent from the new tree.
 */
export function useFollowMode({ sessionId, lastAddedId, recentlyChanged }: UseFollowModeOptions): UseFollowModeReturn {
  const [followMode, setFollowMode] = useState<FollowState>('following');
  const [followTarget, setFollowTarget] = useState<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(sessionId);

  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    setFollowTarget((prev) => nextFollowTarget(prev, { sessionId, prevSessionId, lastAddedId, recentlyChanged }));
  }, [sessionId, lastAddedId, recentlyChanged]);

  const toggleFollow = useCallback(() => {
    setFollowMode((prev) => (prev === 'following' ? 'paused' : 'following'));
  }, []);

  return { followMode, followTarget, toggleFollow };
}
