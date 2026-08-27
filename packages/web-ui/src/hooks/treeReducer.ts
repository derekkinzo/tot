import type { Evidence, Hypothesis, Session } from '../types';

/**
 * The dashboard's live tree state and the SSE-event reducer that maintains it.
 * Kept free of React so the state transitions can be unit-tested directly.
 */
export interface TreeState {
  session: Session | null;
  hypotheses: Map<string, Hypothesis>;
  connected: boolean;
  recentlyChanged: Set<string>;
  lastAddedId: string | null;
  /** The node the agent touched last — added, updated, or given evidence.
   *  Follow mode pins the view to it. Ordering matters and category does not: an
   *  act on an earlier node is more recent than the add that preceded it. Unlike
   *  the highlight signals it is not cleared when the highlight expires, so
   *  enabling follow during a quiet moment still lands on the worked-on node. */
  lastActivityId: string | null;
  /** A session the agent started while another was on screen. Held so the
   *  dashboard can say the work has moved on, rather than showing a stale tree
   *  as though it were current. Null once the view moves. */
  newerSession: Session | null;
}

export type Action =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'snapshot'; session: Session | null; hypotheses: Hypothesis[] }
  | { type: 'hypothesis-added'; hypothesis: Hypothesis }
  | { type: 'hypothesis-updated'; hypothesis: Hypothesis }
  | { type: 'clear-recent' }
  | { type: 'evidence-added'; hypothesisId: string; evidence: Evidence }
  | { type: 'session-created'; session: Session }
  | { type: 'session-completed'; sessionId: string; terminalStatus: 'resolved' | 'abandoned' }
  | { type: 'session-reopened'; sessionId: string };

export function initialTreeState(): TreeState {
  return {
    session: null,
    hypotheses: new Map(),
    connected: false,
    recentlyChanged: new Set<string>(),
    lastAddedId: null,
    lastActivityId: null,
    newerSession: null,
  };
}

export function reducer(state: TreeState, action: Action): TreeState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true };
    case 'disconnected':
      return { ...state, connected: false };
    case 'snapshot': {
      const map = new Map<string, Hypothesis>();
      for (const h of action.hypotheses) map.set(h.id, h);
      // An announcement is spent when the view MOVES, not on every snapshot: each
      // (re)connect re-delivers the displayed session, so clearing it here would
      // let a dropped connection erase the only sign that the agent moved on.
      const moved = state.session?.id !== action.session?.id;
      const newerSession = moved ? null : state.newerSession;
      return {
        ...state, session: action.session, hypotheses: map, connected: state.connected,
        recentlyChanged: new Set(), lastAddedId: null, lastActivityId: null, newerSession,
      };
    }
    case 'session-created':
      // The SSE stream is project-wide; a session announced while another is
      // already displayed must not switch the view (which would then let the
      // new session's hypothesis events past the displayed-session guard).
      // Adopt it only during bootstrap, before any session is shown; otherwise
      // hold the announcement so the dashboard can offer the move instead of
      // showing a stale tree in silence.
      if (!state.session) return { ...state, session: action.session, newerSession: null };
      if (state.session.id === action.session.id) return state;
      return { ...state, newerSession: action.session };
    case 'hypothesis-added': {
      // The SSE stream is project-wide; ignore a node belonging to a session
      // other than the one on display so it cannot inject an orphan into the
      // viewed tree. When no session is displayed yet there is nothing to filter
      // against, so the event applies (single-session bootstrap).
      if (state.session && action.hypothesis.sessionId !== state.session.id) return state;
      const next = new Map(state.hypotheses);
      next.set(action.hypothesis.id, action.hypothesis);
      return { ...state, hypotheses: next, lastAddedId: action.hypothesis.id, lastActivityId: action.hypothesis.id };
    }
    case 'hypothesis-updated': {
      if (state.session && action.hypothesis.sessionId !== state.session.id) return state;
      const next = new Map(state.hypotheses);
      next.set(action.hypothesis.id, action.hypothesis);
      // Re-append on re-update so the most-recently-changed id is always last
      // (a plain Set.add keeps the original insertion position). Follow mode
      // reads the last entry to focus the node that just changed.
      const recent = new Set(state.recentlyChanged);
      recent.delete(action.hypothesis.id);
      recent.add(action.hypothesis.id);
      return { ...state, hypotheses: next, recentlyChanged: recent, lastActivityId: action.hypothesis.id };
    }
    case 'evidence-added': {
      const h = state.hypotheses.get(action.hypothesisId);
      if (!h) return state;
      const updated = { ...h, evidence: [...h.evidence, action.evidence] };
      const next = new Map(state.hypotheses);
      next.set(h.id, updated);
      return { ...state, hypotheses: next, lastActivityId: h.id };
    }
    case 'session-completed': {
      // A completion for the announced session retires the announcement: it
      // offers to open a tree "being built", and that tree is no longer being
      // built. The offer to open it is withdrawn rather than left overstating.
      if (state.newerSession?.id === action.sessionId) {
        const settled = { ...state, newerSession: null };
        return state.session?.id === action.sessionId
          ? { ...settled, session: { ...state.session, status: action.terminalStatus } }
          : settled;
      }
      if (!state.session || state.session.id !== action.sessionId) return state;
      return { ...state, session: { ...state.session, status: action.terminalStatus } };
    }
    case 'session-reopened': {
      if (!state.session || state.session.id !== action.sessionId) return state;
      const next = { ...state.session, status: 'open' as const };
      delete next.completedAt;
      return { ...state, session: next };
    }
    case 'clear-recent':
      return { ...state, recentlyChanged: new Set(), lastAddedId: null };
    default:
      return state;
  }
}
