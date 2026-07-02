import { useEffect, useCallback, useReducer, useRef, useState } from 'react';
import { reducer, initialTreeState } from './treeReducer';
import { wireEventToAction, nextBackoff, INITIAL_BACKOFF_MS } from './sseProtocol';

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
  // The session the dashboard is currently viewing. The SSE stream re-requests
  // it on every (re)connect so a transient disconnect restores this session
  // rather than snapping back to the server's default.
  const viewedSessionIdRef = useRef<string | null>(null);

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
    let backoff = INITIAL_BACKOFF_MS;

    const connect = () => {
      if (connectionGenRef.current !== gen) return;
      // Re-request the viewed session so a reconnect restores it. EventSource
      // fixes its URL at construction, so the current ref value is read here on
      // every (re)connect.
      const sid = viewedSessionIdRef.current;
      const es = new EventSource(sid ? `/sse?sessionId=${encodeURIComponent(sid)}` : '/sse');
      esRef.current = es;

      es.onopen = () => {
        if (connectionGenRef.current !== gen) return;
        backoff = INITIAL_BACKOFF_MS; // reset after a successful connect
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
          backoff = nextBackoff(backoff);
        }
      };

      es.onmessage = (event) => {
        if (connectionGenRef.current !== gen) return;
        const action = wireEventToAction(event.data);
        if (!action) return;
        // Track whichever session the stream is actually showing — the initial
        // snapshot as well as an explicit switch — so a reconnect re-requests it
        // rather than falling back to the server default.
        if (action.type === 'snapshot' && action.session) {
          viewedSessionIdRef.current = action.session.id;
        }
        dispatch(action);
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
      const resp = await fetch(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await resp.json();
      if (data.session) {
        // Remember the viewed session so an SSE reconnect re-requests it.
        viewedSessionIdRef.current = data.session.id;
        dispatch({ type: 'snapshot', session: data.session, hypotheses: data.hypotheses });
      }
    } catch {}
  }, []);

  return { ...state, loadSession, persistenceHealthy };
}
