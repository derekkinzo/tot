import { describe, it, expect } from 'vitest';
import { reducer, initialTreeState, type TreeState } from './treeReducer';
import type { Hypothesis, Session, Evidence } from '../types';

function hyp(id: string, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id,
    parentId: null,
    sessionId: 's1',
    depth: 0,
    title: `content ${id}`,
    status: 'pending',
    evidence: [],
    metadata: { createdAt: 't', updatedAt: 't', source: 'agent' },
    children: [],
    ...over,
  };
}
function session(over: Partial<Session> = {}): Session {
  return { id: 's1', problem: 'P', rootNodeId: 'r', status: 'open', createdAt: 't', ...over };
}
function ev(id: string, type: Evidence['type'] = 'supports'): Evidence {
  return { id, type, kind: 'transcription', content: `ev ${id}`, timestamp: 't' };
}

describe('treeReducer', () => {
  it('snapshot replaces session + hypotheses and resets recentlyChanged/lastAddedId', () => {
    // Start from a dirty state to prove snapshot is a full reset of tree data.
    const dirty: TreeState = {
      ...initialTreeState(),
      recentlyChanged: new Set(['old']),
      lastAddedId: 'old',
      hypotheses: new Map([['old', hyp('old')]]),
    };
    const next = reducer(dirty, { type: 'snapshot', session: session(), hypotheses: [hyp('a'), hyp('b')] });
    expect(next.session?.id).toBe('s1');
    expect([...next.hypotheses.keys()]).toEqual(['a', 'b']);
    expect(next.hypotheses.has('old')).toBe(false);
    expect(next.recentlyChanged.size).toBe(0);
    expect(next.lastAddedId).toBeNull();
  });

  it('snapshot preserves the connected flag', () => {
    const connected: TreeState = { ...initialTreeState(), connected: true };
    const next = reducer(connected, { type: 'snapshot', session: session(), hypotheses: [] });
    expect(next.connected).toBe(true);
  });

  it('hypothesis-added inserts the node and records it as lastAddedId', () => {
    const next = reducer(initialTreeState(), { type: 'hypothesis-added', hypothesis: hyp('x') });
    expect(next.hypotheses.get('x')?.title).toBe('content x');
    expect(next.lastAddedId).toBe('x');
  });

  it('hypothesis-updated re-appends the id so the most-recently-changed is LAST in recentlyChanged', () => {
    // Contract (follow mode): the last entry must be the node that just changed,
    // even when it was changed earlier too. Update A, then B, then A again → A last.
    let s = initialTreeState();
    s = reducer(s, { type: 'hypothesis-updated', hypothesis: hyp('A') });
    s = reducer(s, { type: 'hypothesis-updated', hypothesis: hyp('B') });
    s = reducer(s, { type: 'hypothesis-updated', hypothesis: hyp('A') });
    expect([...s.recentlyChanged]).toEqual(['B', 'A']);
    expect([...s.recentlyChanged][s.recentlyChanged.size - 1]).toBe('A');
  });

  it('hypothesis-updated overwrites the stored node', () => {
    let s = reducer(initialTreeState(), { type: 'hypothesis-added', hypothesis: hyp('x', { status: 'pending' }) });
    s = reducer(s, { type: 'hypothesis-updated', hypothesis: hyp('x', { status: 'exploring' }) });
    expect(s.hypotheses.get('x')?.status).toBe('exploring');
  });

  it('evidence-added appends to the named hypothesis', () => {
    let s = reducer(initialTreeState(), { type: 'hypothesis-added', hypothesis: hyp('x') });
    s = reducer(s, { type: 'evidence-added', hypothesisId: 'x', evidence: ev('e1') });
    expect(s.hypotheses.get('x')?.evidence.map((e) => e.id)).toEqual(['e1']);
  });

  it('evidence-added is a no-op (unchanged state) for an unknown hypothesis id', () => {
    const s = reducer(initialTreeState(), { type: 'hypothesis-added', hypothesis: hyp('x') });
    const next = reducer(s, { type: 'evidence-added', hypothesisId: 'nope', evidence: ev('e1') });
    expect(next).toBe(s); // identity unchanged
  });

  it('session-completed sets the terminal status only when the sessionId matches', () => {
    const s: TreeState = { ...initialTreeState(), session: session({ id: 's1' }) };
    const matched = reducer(s, { type: 'session-completed', sessionId: 's1', terminalStatus: 'resolved' });
    expect(matched.session?.status).toBe('resolved');
    const mismatched = reducer(s, { type: 'session-completed', sessionId: 'other', terminalStatus: 'resolved' });
    expect(mismatched).toBe(s); // no change on mismatch
  });

  it('session-reopened sets status open and clears completedAt only on matching sessionId', () => {
    const s: TreeState = {
      ...initialTreeState(),
      session: session({ id: 's1', status: 'resolved', completedAt: 't2' }),
    };
    const reopened = reducer(s, { type: 'session-reopened', sessionId: 's1' });
    expect(reopened.session?.status).toBe('open');
    expect(reopened.session?.completedAt).toBeUndefined();
    const mismatched = reducer(s, { type: 'session-reopened', sessionId: 'other' });
    expect(mismatched).toBe(s);
  });

  it('clear-recent empties recentlyChanged and lastAddedId without touching hypotheses', () => {
    let s = reducer(initialTreeState(), { type: 'hypothesis-added', hypothesis: hyp('x') });
    s = reducer(s, { type: 'hypothesis-updated', hypothesis: hyp('x') });
    expect(s.lastAddedId).toBe('x');
    expect(s.recentlyChanged.size).toBe(1);
    const cleared = reducer(s, { type: 'clear-recent' });
    expect(cleared.recentlyChanged.size).toBe(0);
    expect(cleared.lastAddedId).toBeNull();
    expect(cleared.hypotheses.get('x')).toBeDefined();
  });

  it('connected/disconnected toggle only the connected flag', () => {
    const c = reducer(initialTreeState(), { type: 'connected' });
    expect(c.connected).toBe(true);
    const d = reducer(c, { type: 'disconnected' });
    expect(d.connected).toBe(false);
  });

  // The SSE stream is project-wide and carries events for every session in the
  // project; the dashboard displays one session at a time. Hypothesis events for
  // a session other than the displayed one must be ignored, or they inject
  // orphan nodes into the viewed tree.
  describe('cross-session event isolation', () => {
    it('hypothesis-added for a different session is ignored', () => {
      const s: TreeState = { ...initialTreeState(), session: session({ id: 's1' }) };
      const next = reducer(s, { type: 'hypothesis-added', hypothesis: hyp('x', { sessionId: 's2' }) });
      expect(next).toBe(s); // identity unchanged
      expect(next.hypotheses.has('x')).toBe(false);
      expect(next.lastAddedId).toBeNull();
    });

    it('hypothesis-updated for a different session is ignored', () => {
      const s: TreeState = {
        ...initialTreeState(),
        session: session({ id: 's1' }),
        hypotheses: new Map([['a', hyp('a', { sessionId: 's1' })]]),
      };
      const next = reducer(s, { type: 'hypothesis-updated', hypothesis: hyp('a', { sessionId: 's2', status: 'eliminated' }) });
      expect(next).toBe(s);
      expect(next.hypotheses.get('a')?.status).toBe('pending');
    });

    it('hypothesis-added for the displayed session is applied', () => {
      const s: TreeState = { ...initialTreeState(), session: session({ id: 's1' }) };
      const next = reducer(s, { type: 'hypothesis-added', hypothesis: hyp('x', { sessionId: 's1' }) });
      expect(next.hypotheses.has('x')).toBe(true);
      expect(next.lastAddedId).toBe('x');
    });

    it('hypothesis-added is applied when no session is displayed yet (no reference to filter against)', () => {
      // Before the first snapshot, session is null; a session-created/snapshot
      // sets it. Until then there is nothing to filter against, so the event
      // applies (the existing single-session bootstrap path).
      const next = reducer(initialTreeState(), { type: 'hypothesis-added', hypothesis: hyp('x', { sessionId: 's9' }) });
      expect(next.hypotheses.has('x')).toBe(true);
    });

    it('session-created for a different session does not switch the displayed session', () => {
      // A newly created session announced over the project-wide stream must not
      // yank the view off the session the user is looking at; otherwise the
      // hypothesis-event guard (which keys off the displayed session id) would
      // then admit the new session's nodes into the displayed tree.
      const s: TreeState = {
        ...initialTreeState(),
        session: session({ id: 's1' }),
        hypotheses: new Map([['a', hyp('a', { sessionId: 's1' })]]),
      };
      const next = reducer(s, { type: 'session-created', session: session({ id: 's2', problem: 'Other' }) });
      expect(next).toBe(s); // identity unchanged
      expect(next.session?.id).toBe('s1');
    });

    it('session-created is adopted when no session is displayed yet (bootstrap)', () => {
      const next = reducer(initialTreeState(), { type: 'session-created', session: session({ id: 's1' }) });
      expect(next.session?.id).toBe('s1');
    });
  });
});
