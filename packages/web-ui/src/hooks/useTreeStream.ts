import { useEffect, useCallback, useReducer, useRef, useState } from 'react';
import type { Evidence, Hypothesis, Session, TreeEvent } from '../types';

interface TreeState {
  session: Session | null;
  hypotheses: Map<string, Hypothesis>;
  connected: boolean;
  recentlyChanged: Set<string>;
  lastAddedId: string | null;
}

type Action =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'snapshot'; session: Session; hypotheses: Hypothesis[] }
  | { type: 'hypothesis-added'; hypothesis: Hypothesis }
  | { type: 'hypothesis-updated'; hypothesis: Hypothesis }
  | { type: 'clear-recent' }
  | { type: 'evidence-added'; hypothesisId: string; evidence: Evidence }
  | { type: 'session-created'; session: Session }
  | { type: 'session-completed'; sessionId: string; terminalStatus: 'resolved' | 'abandoned' }
  | { type: 'session-reopened'; sessionId: string };

function reducer(state: TreeState, action: Action): TreeState {
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
      const next = new Map(state.hypotheses);
      next.set(action.hypothesis.id, action.hypothesis);
      return { ...state, hypotheses: next, lastAddedId: action.hypothesis.id };
    }
    case 'hypothesis-updated': {
      const next = new Map(state.hypotheses);
      next.set(action.hypothesis.id, action.hypothesis);
      const recent = new Set(state.recentlyChanged);
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

export interface ProjectInfo {
  dir: string;
  activeProblem: string | null;
  sessionCount: number;
}

export function useTreeStream(projectDir?: string) {
  const initialState: TreeState = {
    session: null,
    hypotheses: new Map(),
    connected: false,
    recentlyChanged: new Set<string>(),
    lastAddedId: null,
  };
  const [state, dispatch] = useReducer(reducer, initialState);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [currentProject, setCurrentProject] = useState<string>(projectDir || '');
  const esRef = useRef<EventSource | null>(null);
  const connectionGenRef = useRef(0);

  // Clear recently changed after animation duration
  useEffect(() => {
    if (state.recentlyChanged.size > 0 || state.lastAddedId) {
      const timer = setTimeout(() => dispatch({ type: 'clear-recent' }), 1200);
      return () => clearTimeout(timer);
    }
  }, [state.recentlyChanged, state.lastAddedId]);

  // Fetch projects list. If the requested project (e.g. from a URL
  // parameter) is not yet registered with the daemon — typically when
  // a fresh session has not made any MCP tool calls — fall back to the
  // daemon's last-active project so the dashboard isn't stuck on an
  // empty SSE stream.
  const refreshProjects = useCallback(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        const list: ProjectInfo[] = d.projects ?? [];
        setProjects(list);
        if (currentProject) {
          const known = list.some((p) => p.dir === currentProject);
          if (!known && d.lastActive) {
            setCurrentProject(d.lastActive);
          }
        } else if (d.lastActive) {
          setCurrentProject(d.lastActive);
        }
      })
      .catch(() => {});
  }, [currentProject]);

  useEffect(() => {
    refreshProjects();
    // Re-poll projects periodically
    const interval = setInterval(refreshProjects, 10_000);
    return () => clearInterval(interval);
  }, [refreshProjects]);

  // Connect to SSE for the selected project
  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const gen = ++connectionGenRef.current;
    const sseUrl = currentProject ? `/sse?project=${encodeURIComponent(currentProject)}` : '/sse';
    const es = new EventSource(sseUrl);
    esRef.current = es;

    es.onopen = () => {
      if (connectionGenRef.current !== gen) return;
      dispatch({ type: 'connected' });
    };
    es.onerror = () => {
      if (connectionGenRef.current !== gen) return;
      dispatch({ type: 'disconnected' });
    };

    es.onmessage = (event) => {
      if (connectionGenRef.current !== gen) return;
      try {
        const data: TreeEvent = JSON.parse(event.data);
        switch (data.type) {
          case 'snapshot':
            dispatch({ type: 'snapshot', session: data.session, hypotheses: data.hypotheses });
            break;
          case 'session-created':
            dispatch({ type: 'session-created', session: data.session });
            break;
          case 'hypothesis-added':
            dispatch({ type: 'hypothesis-added', hypothesis: data.hypothesis });
            break;
          case 'hypothesis-updated':
            dispatch({ type: 'hypothesis-updated', hypothesis: data.hypothesis });
            break;
          case 'evidence-added':
            dispatch({ type: 'evidence-added', hypothesisId: data.hypothesisId, evidence: data.evidence });
            break;
          case 'session-completed':
            dispatch({ type: 'session-completed', sessionId: data.sessionId, terminalStatus: data.terminalStatus });
            break;
          case 'session-reopened':
            dispatch({ type: 'session-reopened', sessionId: data.sessionId });
            break;
        }
      } catch {
        // Ignore unparseable events (keepalive comments, etc.)
      }
    };

    return () => es.close();
  }, [currentProject]);

  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const projectParam = currentProject ? `&project=${encodeURIComponent(currentProject)}` : '';
      const resp = await fetch(`/api/state?sessionId=${sessionId}${projectParam}`);
      const data = await resp.json();
      if (data.session) {
        dispatch({ type: 'snapshot', session: data.session, hypotheses: data.hypotheses });
      }
    } catch {}
  }, [currentProject]);

  const switchProject = useCallback((dir: string) => {
    setCurrentProject(dir);
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const url = new URL(window.location.href);
      if (dir) {
        url.searchParams.set('project', dir);
      } else {
        url.searchParams.delete('project');
      }
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  return { ...state, loadSession, projects, currentProject, switchProject };
}
