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
      return { ...state, session: action.session, hypotheses: map, connected: state.connected, recentlyChanged: new Set(), lastAddedId: null };
    }
    case 'session-created':
      return { ...state, session: action.session };
    case 'hypothesis-added': {
      // The SSE stream is project-wide; ignore a node belonging to a session
      // other than the one on display so it cannot inject an orphan into the
      // viewed tree. When no session is displayed yet there is nothing to filter
      // against, so the event applies (single-session bootstrap).
      if (state.session && action.hypothesis.sessionId !== state.session.id) return state;
      const next = new Map(state.hypotheses);
      next.set(action.hypothesis.id, action.hypothesis);
      return { ...state, hypotheses: next, lastAddedId: action.hypothesis.id };
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
      return { ...state, hypotheses: next, recentlyChanged: recent };
    }
    case 'evidence-added': {
      const h = state.hypotheses.get(action.hypothesisId);
      if (!h) return state;
      const updated = { ...h, evidence: [...h.evidence, action.evidence] };
      const next = new Map(state.hypotheses);
      next.set(h.id, updated);
      return { ...state, hypotheses: next };
    }
    case 'session-completed': {
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
