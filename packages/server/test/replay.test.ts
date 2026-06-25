import { describe, it, expect } from 'vitest';
import { applyEntry, deriveScanStatus, emptyReplayState, type JournalEntry } from '../src/replay.js';
import type { Hypothesis, Session } from '../src/types.js';

const ts = '2024-01-01T00:00:00.000Z';

function session(over: Partial<Session> = {}): Session {
  return { id: 's', problem: 'p', rootNodeId: 'root', status: 'open', createdAt: ts, ...over };
}
function hyp(id: string, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id, parentId: null, sessionId: 's', depth: 0, content: id, status: 'exploring',
    evidence: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [], ...over,
  };
}
const entry = (type: string, payload: unknown): JournalEntry => ({ timestamp: ts, type, payload });

function fold(...entries: JournalEntry[]) {
  const state = emptyReplayState();
  for (const e of entries) applyEntry(state, e);
  return state;
}

describe('applyEntry (shared event interpreter)', () => {
  it('reconstructs a session + hypotheses in order', () => {
    const s = fold(
      entry('session-created', session()),
      entry('hypothesis-added', hyp('root', { children: ['a'] })),
      entry('hypothesis-added', hyp('a', { parentId: 'root' })),
    );
    expect(s.sessions).toHaveLength(1);
    expect(s.hypotheses.map((h) => h.id)).toEqual(['root', 'a']);
  });

  it('hypothesis-updated replaces the existing node (no duplicate)', () => {
    const s = fold(
      entry('hypothesis-added', hyp('a', { status: 'exploring' })),
      entry('hypothesis-updated', hyp('a', { status: 'corroborated' })),
    );
    expect(s.hypotheses).toHaveLength(1);
    expect(s.hypotheses[0].status).toBe('corroborated');
  });

  it('replays an entry that carries an explicit schema version', () => {
    // Forward-compat: entries may carry a version field. The current schema
    // replays as today; the field exists so a future format change has a branch
    // point rather than an ambiguous bare type.
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: hyp('a'), v: 1 } as JournalEntry);
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a']);
  });

  it('replays a legacy entry with no version field (treated as v1)', () => {
    const s = fold(entry('hypothesis-added', hyp('a')));
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a']);
  });

  it('is order-tolerant: an update for a node with no prior add still lands it (total replay over a truncated log)', () => {
    // The writer never emits this order; the branch makes replay total over a
    // log whose hypothesis-added line was dropped/truncated.
    const s = fold(entry('hypothesis-updated', hyp('a', { status: 'eliminated' })));
    expect(s.hypotheses).toHaveLength(1);
    expect(s.hypotheses[0].status).toBe('eliminated');
  });

  it('replays a legacy evidence-added entry exactly once onto its hypothesis', () => {
    const ev = { id: 'e1', type: 'supports' as const, content: 'x', timestamp: ts };
    const s = fold(
      entry('hypothesis-added', hyp('a')),
      entry('evidence-added', { hypothesisId: 'a', evidence: ev }),
    );
    expect(s.hypotheses[0].evidence).toEqual([ev]);
  });

  it('does not lose an evidence-added that precedes its hypothesis (order-tolerant)', () => {
    // The replay contract is order-tolerant for hypothesis events; evidence must
    // be too. A legacy/hand-authored journal can order evidence-added before the
    // hypothesis-added that creates its target. The evidence must land once the
    // hypothesis appears, not be silently dropped.
    const ev = { id: 'e1', type: 'refutes' as const, content: 'counter', timestamp: ts };
    const s = fold(
      entry('evidence-added', { hypothesisId: 'a', evidence: ev }),
      entry('hypothesis-added', hyp('a')),
    );
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a']);
    expect(s.hypotheses[0].evidence).toEqual([ev]);
  });

  it('merges buffered out-of-order evidence ahead of evidence carried on the later snapshot', () => {
    // If the hypothesis-added/updated snapshot itself already carries evidence,
    // the buffered earlier evidence is appended without dropping the snapshot's.
    const early = { id: 'e1', type: 'refutes' as const, content: 'early', timestamp: ts };
    const carried = { id: 'e2', type: 'supports' as const, content: 'carried', timestamp: ts };
    const s = fold(
      entry('evidence-added', { hypothesisId: 'a', evidence: early }),
      entry('hypothesis-added', hyp('a', { evidence: [carried] })),
    );
    const ids = s.hypotheses[0].evidence.map((e) => e.id).sort();
    expect(ids).toEqual(['e1', 'e2']);
  });

  it('keeps hypothesisIndex consistent with the array across interleaved adds/updates', () => {
    const s = fold(
      entry('hypothesis-added', hyp('a')),
      entry('hypothesis-added', hyp('b')),
      entry('hypothesis-updated', hyp('a', { status: 'corroborated' })),
      entry('hypothesis-added', hyp('c')),
      entry('hypothesis-updated', hyp('c', { status: 'eliminated' })),
    );
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    // Every index entry resolves to the matching node — the O(1) lookup is sound.
    for (const [id, idx] of s.hypothesisIndex) {
      expect(s.hypotheses[idx].id).toBe(id);
    }
    expect(s.hypotheses[s.hypothesisIndex.get('a')!].status).toBe('corroborated');
    expect(s.hypotheses[s.hypothesisIndex.get('c')!].status).toBe('eliminated');
  });

  it('resolves update/evidence in O(1) — applyEntry performs no linear array scan', () => {
    // Guard the algorithmic invariant (not wall-clock): the reducer must not
    // reintroduce findIndex/find over the hypotheses array.
    const src = applyEntry.toString();
    expect(src).not.toMatch(/\.findIndex\(/);
    expect(src).not.toMatch(/hypotheses\.find\(/);
  });

  it('session-completed sets terminal status + completedAt; session-reopened reverts', () => {
    const completed = fold(
      entry('session-created', session()),
      entry('session-completed', { sessionId: 's', terminalStatus: 'resolved' }),
    );
    expect(completed.sessions[0].status).toBe('resolved');
    expect(completed.sessions[0].completedAt).toBe(ts);

    const reopened = fold(
      entry('session-created', session()),
      entry('session-completed', { sessionId: 's', terminalStatus: 'resolved' }),
      entry('session-reopened', { sessionId: 's' }),
    );
    expect(reopened.sessions[0].status).toBe('open');
    expect(reopened.sessions[0].completedAt).toBeUndefined();
  });
});

describe('deriveScanStatus (scan projection)', () => {
  it('returns open for a still-open session', () => {
    expect(deriveScanStatus(session({ status: 'open' }), [], false)).toBe('open');
  });

  it('trusts the explicit terminalStatus when one was seen on the wire', () => {
    expect(deriveScanStatus(session({ status: 'resolved' }), [], true)).toBe('resolved');
    expect(deriveScanStatus(session({ status: 'abandoned' }), [], true)).toBe('abandoned');
  });

  it('without an explicit terminalStatus, derives resolved when a corroborated node survives on a non-pruned lineage', () => {
    const hyps = [
      hyp('root', { children: ['a'], status: 'exploring' }),
      hyp('a', { parentId: 'root', status: 'corroborated' }),
    ];
    // session marked terminal (status != open) but no explicit terminalStatus seen.
    expect(deriveScanStatus(session({ status: 'resolved' }), hyps, false)).toBe('resolved');
  });

  it('without an explicit terminalStatus, derives abandoned when no corroborated node survives', () => {
    const hyps = [
      hyp('root', { children: ['a'], status: 'exploring' }),
      hyp('a', { parentId: 'root', status: 'eliminated' }),
    ];
    expect(deriveScanStatus(session({ status: 'abandoned' }), hyps, false)).toBe('abandoned');
  });

  it('a corroborated node buried under a pruned ancestor does NOT count as survival', () => {
    const hyps = [
      hyp('root', { children: ['a'], status: 'exploring' }),
      hyp('a', { parentId: 'root', status: 'out-of-scope', children: ['b'] }),
      hyp('b', { parentId: 'a', status: 'corroborated' }),
    ];
    expect(deriveScanStatus(session({ status: 'abandoned' }), hyps, false)).toBe('abandoned');
  });
});
