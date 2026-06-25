import { describe, it, expect } from 'vitest';
import { nextFollowTarget } from './followTarget';

describe('nextFollowTarget', () => {
  it('tracks the last added node', () => {
    const next = nextFollowTarget(null, { sessionId: 's1', prevSessionId: 's1', lastAddedId: 'x', recentlyChanged: new Set() });
    expect(next).toBe('x');
  });

  it('falls back to the most recently changed node when nothing was just added', () => {
    const next = nextFollowTarget(null, { sessionId: 's1', prevSessionId: 's1', lastAddedId: null, recentlyChanged: new Set(['a', 'b']) });
    expect(next).toBe('b');
  });

  it('retains the prior target during a quiet moment (no add, no change)', () => {
    const next = nextFollowTarget('old', { sessionId: 's1', prevSessionId: 's1', lastAddedId: null, recentlyChanged: new Set() });
    expect(next).toBe('old');
  });

  it('clears the target when the displayed session changes', () => {
    // A session switch resets lastAddedId/recentlyChanged; the follow target
    // from the previous session no longer exists in the new tree and must be
    // dropped so follow does not pin selection to a stale, absent node.
    const next = nextFollowTarget('prev-session-node', {
      sessionId: 's2', prevSessionId: 's1', lastAddedId: null, recentlyChanged: new Set(),
    });
    expect(next).toBeNull();
  });

  it('on a session change, still adopts a fresh activity signal from the new session', () => {
    const next = nextFollowTarget('prev-session-node', {
      sessionId: 's2', prevSessionId: 's1', lastAddedId: 'new-node', recentlyChanged: new Set(),
    });
    expect(next).toBe('new-node');
  });
});
