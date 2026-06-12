import { useState, useEffect, useCallback } from 'react';

type FollowState = 'following' | 'paused';

interface UseFollowModeOptions {
  lastAddedId: string | null;
  recentlyChanged: Set<string>;
}

interface UseFollowModeReturn {
  followMode: FollowState;
  followTarget: string | null;
  reportUserInteraction: () => void;
  toggleFollow: () => void;
}

export function useFollowMode({ lastAddedId, recentlyChanged }: UseFollowModeOptions): UseFollowModeReturn {
  const [followMode, setFollowMode] = useState<FollowState>('following');
  const [followTarget, setFollowTarget] = useState<string | null>(null);

  useEffect(() => {
    if (followMode !== 'following') return;
    if (lastAddedId) {
      setFollowTarget(null);
    } else if (recentlyChanged.size > 0) {
      const targetId = [...recentlyChanged][recentlyChanged.size - 1];
      setFollowTarget(targetId);
    } else {
      setFollowTarget(null);
    }
  }, [followMode, lastAddedId, recentlyChanged]);

  const reportUserInteraction = useCallback(() => {
    if (followMode === 'following') setFollowMode('paused');
  }, [followMode]);

  const toggleFollow = useCallback(() => {
    setFollowMode((prev) => prev === 'following' ? 'paused' : 'following');
  }, []);

  return { followMode, followTarget, reportUserInteraction, toggleFollow };
}
