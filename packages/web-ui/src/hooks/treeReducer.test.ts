import { describe, it, expect } from 'vitest';
import { reducer, initialTreeState, type Action, type TreeState } from './treeReducer';
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
  describe('which node the agent touched last', () => {
    // Follow mode pins the view to the node being worked on. Within one burst an
    // agent decomposes and then gathers evidence on the first child, so the most
    // recent activity is an act on an EARLIER node than the last one added;
    // preferring adds categorically leaves the view on the wrong sibling.
    const build = (actions: Action[]): TreeState =>
      actions.reduce(reducer, { ...initialTreeState(), session: session() });

    it('is the node just updated, not the last one added before it', () => {
      const state = build([
        { type: 'hypothesis-added', hypothesis: hyp('a') },
        { type: 'hypothesis-added', hypothesis: hyp('b') },
        { type: 'hypothesis-updated', hypothesis: hyp('a', { status: 'exploring' }) },
      ]);
      expect(state.lastActivityId).toBe('a');
    });

    it('is the node evidence just landed on', () => {
      // An evidence record on a node whose status does not change emits no
      // hypothesis-updated, so this is the only signal that the node was acted on.
      const state = build([
        { type: 'hypothesis-added', hypothesis: hyp('a') },
        { type: 'hypothesis-added', hypothesis: hyp('b') },
        { type: 'evidence-added', hypothesisId: 'a', evidence: ev('e1') },
      ]);
      expect(state.lastActivityId).toBe('a');
    });

    it('is the newly added node when the add is the most recent act', () => {
      const state = build([
        { type: 'hypothesis-updated', hypothesis: hyp('a', { status: 'exploring' }) },
        { type: 'hypothesis-added', hypothesis: hyp('b') },
      ]);
      expect(state.lastActivityId).toBe('b');
    });

    it('survives the highlight expiring, so enabling follow later still finds it', () => {
      const state = build([
        { type: 'hypothesis-added', hypothesis: hyp('a') },
        { type: 'clear-recent' },
      ]);
      expect(state.lastAddedId).toBeNull();
      expect(state.recentlyChanged.size).toBe(0);
      expect(state.lastActivityId).toBe('a');
    });

    it('is dropped by a snapshot, which replaces the tree it referred to', () => {
      const state = build([
        { type: 'hypothesis-added', hypothesis: hyp('a') },
        { type: 'snapshot', session: session({ id: 's2' }), hypotheses: [] },
      ]);
      expect(state.lastActivityId).toBeNull();
    });

    it('ignores activity in a session that is not on display', () => {
      const state = build([
        { type: 'hypothesis-added', hypothesis: hyp('a') },
        { type: 'hypothesis-added', hypothesis: hyp('other', { sessionId: 's-other' }) },
        { type: 'evidence-added', hypothesisId: 'nowhere', evidence: ev('e1') },
      ]);
      expect(state.lastActivityId).toBe('a');
    });
  });

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

    /** A session on screen, with one node in it. */
    const displaying = (id = 's1'): TreeState => ({
      ...initialTreeState(),
      session: session({ id }),
      hypotheses: new Map([['a', hyp('a', { sessionId: id })]]),
    });

    it('session-created for a different session does not switch the displayed session', () => {
      // A newly created session announced over the project-wide stream must not
      // yank the view off the session the user is looking at; otherwise the
      // hypothesis-event guard (which keys off the displayed session id) would
      // then admit the new session's nodes into the displayed tree.
      const s = displaying();
      const next = reducer(s, { type: 'session-created', session: session({ id: 's2', problem: 'Other' }) });
      expect(next.session?.id).toBe('s1');
      expect(next.hypotheses).toBe(s.hypotheses);
    });

    it('records the announcement rather than discarding it', () => {
      // Dropping it leaves the dashboard showing a stale session with no sign
      // that the agent has moved on, while the follow indicator still reads as
      // though it were keeping up.
      const next = reducer(displaying(), { type: 'session-created', session: session({ id: 's2', problem: 'Other' }) });
      expect(next.newerSession?.id).toBe('s2');
      expect(next.newerSession?.problem).toBe('Other');
    });

    it('still refuses nodes from the announced session until the view moves', () => {
      const announced = reducer(displaying(), { type: 'session-created', session: session({ id: 's2' }) });
      const next = reducer(announced, { type: 'hypothesis-added', hypothesis: hyp('foreign', { sessionId: 's2' }) });
      expect(next.hypotheses.has('foreign')).toBe(false);
      expect(next.hypotheses.size).toBe(1);
    });

    it('spends the announcement once the view moves', () => {
      const announced = reducer(displaying(), { type: 'session-created', session: session({ id: 's2' }) });
      const moved = reducer(announced, {
        type: 'snapshot', session: session({ id: 's2' }), hypotheses: [hyp('b', { sessionId: 's2' })],
      });
      expect(moved.session?.id).toBe('s2');
      expect(moved.newerSession).toBeNull();
    });

    it('keeps the announcement across a reconnect of the session on screen', () => {
      // Every (re)connect delivers a fresh snapshot of whatever session is being
      // displayed. Treating any snapshot as "the view moved" throws the
      // announcement away on a dropped connection, so the reader never learns the
      // agent has started something else.
      const announced = reducer(displaying('s1'), { type: 'session-created', session: session({ id: 's2' }) });
      const reconnected = reducer(announced, {
        type: 'snapshot', session: session({ id: 's1' }), hypotheses: [hyp('a', { sessionId: 's1' })],
      });
      expect(reconnected.session?.id).toBe('s1');
      expect(reconnected.newerSession?.id).toBe('s2');
    });

    it('stops announcing a tree once that tree is finished', () => {
      // The announcement claims work is under way. A completion for the announced
      // session arrives on the same project-wide stream, so keeping the claim
      // after it is asserting activity that has ended.
      const announced = reducer(displaying('s1'), { type: 'session-created', session: session({ id: 's2' }) });
      expect(announced.newerSession?.id).toBe('s2');
      const finished = reducer(announced, { type: 'session-completed', sessionId: 's2', terminalStatus: 'resolved' });
      expect(finished.newerSession).toBeNull();
      // The displayed session is untouched.
      expect(finished.session?.id).toBe('s1');
    });

    it('keeps announcing when a different session finishes', () => {
      const announced = reducer(displaying('s1'), { type: 'session-created', session: session({ id: 's2' }) });
      const other = reducer(announced, { type: 'session-completed', sessionId: 's9', terminalStatus: 'abandoned' });
      expect(other.newerSession?.id).toBe('s2');
    });

    it('does not announce the session already on screen', () => {
      const next = reducer(displaying('s1'), { type: 'session-created', session: session({ id: 's1' }) });
      expect(next.newerSession).toBeNull();
    });

    it('session-created is adopted when no session is displayed yet (bootstrap)', () => {
      const next = reducer(initialTreeState(), { type: 'session-created', session: session({ id: 's1' }) });
      expect(next.session?.id).toBe('s1');
      expect(next.newerSession).toBeNull();
    });
  });
});
