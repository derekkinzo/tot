import { describe, it, expect } from 'vitest';
import { wireEventToAction, nextBackoff, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS } from './sseProtocol';
import type { Session, Hypothesis } from '../types';

const session = (id = 's'): Session => ({ id, problem: 'p', rootNodeId: 'r', status: 'open', createdAt: '' });
const hyp = (id = 'h'): Hypothesis => ({
  id, parentId: null, sessionId: 's', depth: 0, content: id, status: 'exploring',
  evidence: [], metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children: [],
});

describe('wireEventToAction', () => {
  it('returns null for unparseable input (keepalive comment / garbage)', () => {
    expect(wireEventToAction(': keepalive')).toBeNull();
    expect(wireEventToAction('not json')).toBeNull();
  });

  it('is total: parseable-but-non-object JSON returns null and never throws', () => {
    // JSON.parse succeeds for these (null/number/string/bool/array); reading
    // .type off them must not throw — the function maps them all to null.
    for (const raw of ['null', '42', '"snapshot"', 'true', '[]']) {
      expect(() => wireEventToAction(raw)).not.toThrow();
      expect(wireEventToAction(raw)).toBeNull();
    }
  });

  it('returns null for an unknown event type', () => {
    expect(wireEventToAction(JSON.stringify({ type: 'mystery' }))).toBeNull();
  });

  it('maps each of the 7 wire event types to its reducer Action', () => {
    expect(wireEventToAction(JSON.stringify({ type: 'snapshot', session: session(), hypotheses: [] })))
      .toEqual({ type: 'snapshot', session: session(), hypotheses: [] });
    expect(wireEventToAction(JSON.stringify({ type: 'session-created', session: session() })))
      .toEqual({ type: 'session-created', session: session() });
    expect(wireEventToAction(JSON.stringify({ type: 'hypothesis-added', hypothesis: hyp() })))
      .toEqual({ type: 'hypothesis-added', hypothesis: hyp() });
    expect(wireEventToAction(JSON.stringify({ type: 'hypothesis-updated', hypothesis: hyp() })))
      .toEqual({ type: 'hypothesis-updated', hypothesis: hyp() });
    const evt = { id: 'e', type: 'supports', content: 'x', timestamp: '' };
    expect(wireEventToAction(JSON.stringify({ type: 'evidence-added', hypothesisId: 'h', evidence: evt })))
      .toEqual({ type: 'evidence-added', hypothesisId: 'h', evidence: evt });
    expect(wireEventToAction(JSON.stringify({ type: 'session-completed', sessionId: 's', terminalStatus: 'resolved' })))
      .toEqual({ type: 'session-completed', sessionId: 's', terminalStatus: 'resolved' });
    expect(wireEventToAction(JSON.stringify({ type: 'session-reopened', sessionId: 's' })))
      .toEqual({ type: 'session-reopened', sessionId: 's' });
  });

  it('preserves a null session on an empty-project snapshot (no falsy-guard regression)', () => {
    const action = wireEventToAction(JSON.stringify({ type: 'snapshot', session: null, hypotheses: [] }));
    expect(action).toEqual({ type: 'snapshot', session: null, hypotheses: [] });
  });
});

describe('nextBackoff', () => {
  it('doubles the previous delay', () => {
    expect(nextBackoff(INITIAL_BACKOFF_MS)).toBe(2000);
    expect(nextBackoff(2000)).toBe(4000);
  });
  it('clamps at MAX_BACKOFF_MS', () => {
    expect(nextBackoff(20_000)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoff(MAX_BACKOFF_MS)).toBe(MAX_BACKOFF_MS);
  });
});
