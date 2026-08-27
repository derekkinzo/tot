import { describe, it, expect } from 'vitest';
import { nextFollowTarget } from './followTarget';

describe('nextFollowTarget', () => {
  it('tracks the node the agent touched last', () => {
    const next = nextFollowTarget(null, { sessionId: 's1', prevSessionId: 's1', lastActivityId: 'x' });
    expect(next).toBe('x');
  });

  it('retains the prior target during a quiet moment', () => {
    const next = nextFollowTarget('old', { sessionId: 's1', prevSessionId: 's1', lastActivityId: null });
    expect(next).toBe('old');
  });

  it('clears the target when the displayed session changes', () => {
    // The follow target from the previous session does not exist in the new tree
    // and must be dropped, so follow cannot pin selection to an absent node.
    const next = nextFollowTarget('prev-session-node', {
      sessionId: 's2', prevSessionId: 's1', lastActivityId: null,
    });
    expect(next).toBeNull();
  });

  it('on a session change, still adopts a fresh activity signal from the new session', () => {
    const next = nextFollowTarget('prev-session-node', {
      sessionId: 's2', prevSessionId: 's1', lastActivityId: 'new-node',
    });
    expect(next).toBe('new-node');
  });
});
