import { describe, it, expect } from 'vitest';
import { wireEventToAction, nextBackoff, readProjectInfo, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS } from './sseProtocol';
import type { Session, Hypothesis } from '../types';

const session = (id = 's'): Session => ({ id, problem: 'p', rootNodeId: 'r', status: 'open', createdAt: '' });
const hyp = (id = 'h'): Hypothesis => ({
  id, parentId: null, sessionId: 's', depth: 0, title: id, status: 'exploring',
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

describe('readProjectInfo', () => {
  // The dashboard raises a notice from these two readings. A notice raised on a
  // field the server never sent is permanent and tells the reader nothing they
  // can act on, so neither reading defaults to the alarming value.

  it('reports the count of records that could not be read back', () => {
    expect(readProjectInfo({ persistenceHealthy: true, unreadableLines: 7 }).unreadableLines).toBe(7);
  });

  it('reports no unread records when the server sent no count', () => {
    expect(readProjectInfo({ persistenceHealthy: true }).unreadableLines).toBe(0);
  });

  it('reports no unread records for a count that is not a usable number', () => {
    // A notice reading "NaN records could not be read" is worse than none: it
    // names a quantity nobody can check and cannot be dismissed.
    for (const bad of [null, 'many', {}, NaN, Infinity, -1]) {
      expect(readProjectInfo({ unreadableLines: bad }).unreadableLines, String(bad)).toBe(0);
    }
  });

  it('counts whole records, since a record is either read or it is not', () => {
    expect(readProjectInfo({ unreadableLines: 2.7 }).unreadableLines).toBe(2);
  });

  it('treats saved state as healthy until the server says otherwise', () => {
    expect(readProjectInfo({}).persistenceHealthy).toBe(true);
    expect(readProjectInfo({ persistenceHealthy: false }).persistenceHealthy).toBe(false);
  });

  it('survives a body that is not an object at all, so one bad reply raises nothing', () => {
    for (const body of [null, undefined, 'gateway timeout', 42]) {
      expect(readProjectInfo(body)).toEqual({ persistenceHealthy: true, unreadableLines: 0 });
    }
  });
});
