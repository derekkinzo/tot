import { useState, useEffect, useCallback } from 'react';

type FollowState = 'following' | 'paused';

interface UseFollowModeOptions {
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
 * enabling follow during a quiet moment still focuses the active hypothesis.
 */
export function useFollowMode({ lastAddedId, recentlyChanged }: UseFollowModeOptions): UseFollowModeReturn {
  const [followMode, setFollowMode] = useState<FollowState>('following');
  const [followTarget, setFollowTarget] = useState<string | null>(null);

  useEffect(() => {
    if (lastAddedId) {
      setFollowTarget(lastAddedId);
    } else if (recentlyChanged.size > 0) {
      setFollowTarget([...recentlyChanged][recentlyChanged.size - 1]);
    }
  }, [lastAddedId, recentlyChanged]);

  const toggleFollow = useCallback(() => {
    setFollowMode((prev) => (prev === 'following' ? 'paused' : 'following'));
  }, []);

  return { followMode, followTarget, toggleFollow };
}
