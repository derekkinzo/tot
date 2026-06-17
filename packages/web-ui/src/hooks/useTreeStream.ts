import { useEffect, useCallback, useReducer, useRef, useState } from 'react';
import type { TreeEvent } from '../types';
import { reducer, initialTreeState } from './treeReducer';

/**
 * Subscribes the dashboard to its server's live tree: an SSE stream that
 * delivers a snapshot on connect then incremental events, reduced into tree
 * state. The server serves exactly one project, so there is no project
 * selection — the stream is always `/sse`.
 */
export function useTreeStream() {
  const [state, dispatch] = useReducer(reducer, undefined, initialTreeState);
  const [persistenceHealthy, setPersistenceHealthy] = useState(true);
  const esRef = useRef<EventSource | null>(null);
  const connectionGenRef = useRef(0);

  // Poll the server's persistence health so the dashboard can warn the user
  // when journal writes are failing (disk full / permissions) and their tree
  // is not being saved.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch('/api/info')
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setPersistenceHealthy(d.persistenceHealthy !== false); })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Clear recently changed after animation duration
  useEffect(() => {
    if (state.recentlyChanged.size > 0 || state.lastAddedId) {
      const timer = setTimeout(() => dispatch({ type: 'clear-recent' }), 1200);
      return () => clearTimeout(timer);
    }
  }, [state.recentlyChanged, state.lastAddedId]);

  // Connect to the SSE stream.
  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const gen = ++connectionGenRef.current;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;

    const connect = () => {
      if (connectionGenRef.current !== gen) return;
      const es = new EventSource('/sse');
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
          // Clear any prior pending reconnect so repeated CLOSED errors cannot
          // stack timers and race two EventSources open.
          if (retryTimer) clearTimeout(retryTimer);
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
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const resp = await fetch(`/api/state?sessionId=${sessionId}`);
      const data = await resp.json();
      if (data.session) {
        dispatch({ type: 'snapshot', session: data.session, hypotheses: data.hypotheses });
      }
    } catch {}
  }, []);

  return { ...state, loadSession, persistenceHealthy };
}
