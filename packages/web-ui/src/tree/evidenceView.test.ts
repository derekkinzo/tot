import { describe, it, expect } from 'vitest';
import { orderEvidenceRows, evidenceLedger, groundingMeter } from './evidenceView';
import type { Evidence, Hypothesis, HypothesisStatus } from '../types';

const ts = '2024-01-01T00:00:00.000Z';
let n = 0;
function ev(over: Partial<Evidence> & Pick<Evidence, 'type'>): Evidence {
  return { id: `e${n++}`, kind: 'transcription', content: 'x', timestamp: ts, ...over };
}
function hyp(evidence: Evidence[], over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h', parentId: null, sessionId: 's', depth: 0, title: 'h', status: 'exploring',
    evidence, metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [], ...over,
  };
}

describe('orderEvidenceRows', () => {
  // Refutation is read first: an auditor checking a verdict needs the
  // counter-instances before the support, and an item asserted not to
  // discriminate is retained but read last.

  it('groups refuters before neutral before supports, with the tray last', () => {
    const h = hyp([
      ev({ type: 'supports', content: 's1' }),
      ev({ type: 'neutral', content: 'n1' }),
      ev({ type: 'refutes', content: 'r1' }),
      ev({ type: 'supports', content: 'moot', nonDiagnostic: true }),
    ]);
    const rows = orderEvidenceRows(h);
    expect(rows.refuters.map((e) => e.content)).toEqual(['r1']);
    expect(rows.neutral.map((e) => e.content)).toEqual(['n1']);
    expect(rows.supports.map((e) => e.content)).toEqual(['s1']);
    expect(rows.tray.map((e) => e.content)).toEqual(['moot']);
  });

  it('puts a decisive record first within its group', () => {
    const h = hyp([
      ev({ type: 'refutes', content: 'ordinary' }),
      ev({ type: 'refutes', content: 'linchpin', decisive: true }),
      ev({ type: 'refutes', content: 'also ordinary' }),
    ]);
    expect(orderEvidenceRows(h).refuters.map((e) => e.content))
      .toEqual(['linchpin', 'ordinary', 'also ordinary']);
  });

  it('is stable within a group otherwise', () => {
    const h = hyp([
      ev({ type: 'supports', content: 'first' }),
      ev({ type: 'supports', content: 'second' }),
      ev({ type: 'supports', content: 'third' }),
    ]);
    expect(orderEvidenceRows(h).supports.map((e) => e.content)).toEqual(['first', 'second', 'third']);
  });

  it('routes a non-diagnostic record to the tray whatever its polarity', () => {
    const h = hyp([
      ev({ type: 'refutes', content: 'r', nonDiagnostic: true }),
      ev({ type: 'neutral', content: 'n', nonDiagnostic: true }),
    ]);
    const rows = orderEvidenceRows(h);
    expect(rows.refuters).toEqual([]);
    expect(rows.neutral).toEqual([]);
    expect(rows.tray).toHaveLength(2);
  });

  it('returns empty groups rather than omitting them', () => {
    const rows = orderEvidenceRows(hyp([]));
    expect(rows).toEqual({ refuters: [], neutral: [], supports: [], tray: [] });
  });

  it('partitions every record exactly once', () => {
    const h = hyp([
      ev({ type: 'refutes' }), ev({ type: 'supports' }), ev({ type: 'neutral' }),
      ev({ type: 'supports', nonDiagnostic: true }),
    ]);
    const rows = orderEvidenceRows(h);
    const all = [...rows.refuters, ...rows.neutral, ...rows.supports, ...rows.tray];
    expect(all).toHaveLength(h.evidence.length);
    expect(new Set(all.map((e) => e.id)).size).toBe(h.evidence.length);
  });
});

describe('evidenceLedger', () => {
  it('reports weights, not record counts', () => {
    const h = hyp([
      ev({ type: 'refutes', linkedGroupId: 'g' }),
      ev({ type: 'refutes', linkedGroupId: 'g' }),
      ev({ type: 'supports' }),
    ]);
    const l = evidenceLedger(h, { sessionGrounded: false });
    expect(l.refuting).toBe(1);
    expect(l.supporting).toBe(1);
  });

  it('names theme tokens rather than colour values, so the palette stays in one place', () => {
    const l = evidenceLedger(hyp([ev({ type: 'refutes' })]), { sessionGrounded: false });
    expect(l.refutingToken).toBe('refutes');
    expect(l.supportingToken).toBe('supports');
    // A token is a key, never a resolved colour.
    expect(l.refutingToken).not.toMatch(/^#/);
  });

  it('flags a decisive record on the node', () => {
    expect(evidenceLedger(hyp([ev({ type: 'refutes', decisive: true })]), { sessionGrounded: false }).hasDecisive).toBe(true);
    expect(evidenceLedger(hyp([ev({ type: 'refutes' })]), { sessionGrounded: false }).hasDecisive).toBe(false);
  });

  it('marks a settled verdict that rests on no verbatim record — but only once the session captures any', () => {
    const settled = hyp([ev({ type: 'supports' })], { status: 'corroborated' });
    // In a session that never captured an artifact the mark would fire on every
    // node, which says nothing about this one.
    expect(evidenceLedger(settled, { sessionGrounded: false }).ungrounded).toBe(false);
    expect(evidenceLedger(settled, { sessionGrounded: true }).ungrounded).toBe(true);
  });

  it('does not mark a node whose verdict rests on an artifact', () => {
    const grounded = hyp([ev({ type: 'refutes', kind: 'artifact' })], { status: 'eliminated' });
    expect(evidenceLedger(grounded, { sessionGrounded: true }).ungrounded).toBe(false);
  });

  it('counts neutral records for display without weighing them', () => {
    const l = evidenceLedger(hyp([ev({ type: 'neutral' }), ev({ type: 'neutral' })]), { sessionGrounded: false });
    expect(l.neutral).toBe(2);
  });
});

describe('groundingMeter', () => {
  const leaf = (status: HypothesisStatus, kind: Evidence['kind']) =>
    hyp([ev({ type: 'supports', kind })], { status });

  it('measures settled leaves that rest on a verbatim record', () => {
    const m = groundingMeter([
      leaf('corroborated', 'artifact'),
      leaf('eliminated', 'transcription'),
      leaf('out-of-scope', 'artifact'),
    ]);
    expect(m).toEqual({ grounded: 2, total: 3 });
  });

  it('ignores nodes still open — they have no verdict to ground', () => {
    const m = groundingMeter([leaf('exploring', 'transcription'), leaf('corroborated', 'artifact')]);
    expect(m).toEqual({ grounded: 1, total: 1 });
  });

  it('ignores a settled node that has children, since its verdict rests on theirs', () => {
    const parent = hyp([], { status: 'corroborated', children: ['c1'] });
    const m = groundingMeter([parent, leaf('eliminated', 'artifact')]);
    expect(m).toEqual({ grounded: 1, total: 1 });
  });

  it('reports zero of zero for a session with no settled leaves', () => {
    expect(groundingMeter([leaf('pending', 'transcription')])).toEqual({ grounded: 0, total: 0 });
  });
});
