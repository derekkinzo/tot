import { useEffect, useCallback, useReducer, useRef, useState } from 'react';
import type { TreeEvent } from '../types';
import { reducer, initialTreeState } from './treeReducer';

export interface ProjectInfo {
  dir: string;
  activeProblem: string | null;
  sessionCount: number;
}

export function useTreeStream(projectDir?: string) {
  const [state, dispatch] = useReducer(reducer, undefined, initialTreeState);
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
  // parameter) is not yet registered with the server — typically when
  // a fresh session has not made any MCP tool calls — fall back to the
  // server's active project so the dashboard isn't stuck on an
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;

    const connect = () => {
      if (connectionGenRef.current !== gen) return;
      const es = new EventSource(sseUrl);
      esRef.current = es;

      es.onopen = () => {
        if (connectionGenRef.current !== gen) return;
        backoff = 1000; // reset after a successful connect
        dispatch({ type: 'connected' });
      };
      es.onerror = () => {
        if (connectionGenRef.current !== gen) return;
        dispatch({ type: 'disconnected' });
        // EventSource auto-reconnects while the connection stays in CONNECTING;
        // once it gives up (CLOSED, e.g. the server went away) drive a manual
        // reconnect with bounded exponential backoff so the dashboard recovers
        // without a page reload.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          retryTimer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
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
    };

    connect();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      esRef.current?.close();
      esRef.current = null;
    };
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
