import type { TreeEvent } from '../types';
import type { Action } from './treeReducer';

/**
 * Pure SSE-protocol helpers for useTreeStream, kept React-free so the wire
 * boundary and the reconnect policy can be unit-tested without mocking globals.
 */

export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;

/** Next reconnect delay: double the previous, clamped to MAX_BACKOFF_MS. */
export function nextBackoff(prev: number): number {
  return Math.min(prev * 2, MAX_BACKOFF_MS);
}

/**
 * Parses one raw SSE payload and maps the wire {@link TreeEvent} to its reducer
 * {@link Action}, or null for keepalive comments / unparseable input / unknown
 * types. This is a partial map: connected/disconnected/clear-recent Actions
 * have no wire source and are dispatched by the hook directly.
 */
export function wireEventToAction(raw: string): Action | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // JSON.parse succeeds for primitives too ('null' → null, '42' → 42), so guard
  // for a non-null object before reading .type — this keeps the function total
  // (always returns, never throws) so onmessage needs no try/catch of its own.
  if (typeof parsed !== 'object' || parsed === null) return null;
  const data = parsed as TreeEvent;
  switch (data.type) {
    case 'snapshot':
      return { type: 'snapshot', session: data.session, hypotheses: data.hypotheses };
    case 'session-created':
      return { type: 'session-created', session: data.session };
    case 'hypothesis-added':
      return { type: 'hypothesis-added', hypothesis: data.hypothesis };
    case 'hypothesis-updated':
      return { type: 'hypothesis-updated', hypothesis: data.hypothesis };
    case 'evidence-added':
      return { type: 'evidence-added', hypothesisId: data.hypothesisId, evidence: data.evidence };
    case 'session-completed':
      return { type: 'session-completed', sessionId: data.sessionId, terminalStatus: data.terminalStatus };
    case 'session-reopened':
      return { type: 'session-reopened', sessionId: data.sessionId };
    default:
      return null;
  }
}
