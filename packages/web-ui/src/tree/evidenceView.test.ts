import { describe, it, expect } from 'vitest';
import { orderEvidenceRows, evidenceLedger, groundingMeter, linkedGroupSizes } from './evidenceView';
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

  it('carries only what a node face reads, so nothing on it can go stale unnoticed', () => {
    // A field no renderer reads is still recomputed for every node on every
    // layout, and a test that compares it to the literal it was built from would
    // not notice if it stopped being right.
    const l = evidenceLedger(hyp([ev({ type: 'refutes' })]), { sessionGrounded: false });
    expect(Object.keys(l).sort())
      .toEqual(['hasDecisive', 'neutral', 'refuting', 'setAside', 'supporting', 'ungrounded']);
  });

  it('does not call a set-aside record decisive', () => {
    // A record declared not to discriminate weighs nothing, so the verdict cannot
    // turn on it. Marking the face otherwise is the same inconsistency the neutral
    // count had: one flag meaning different things by field.
    const l = evidenceLedger(hyp([ev({ type: 'refutes', decisive: true, nonDiagnostic: true })]), { sessionGrounded: false });
    expect(l.hasDecisive).toBe(false);
    expect(l.setAside).toBe(1);
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

  it('does not mark a settled parent, whose verdict rests on its children', () => {
    // The session meter skips a settled parent for exactly this reason. A face
    // that marks one anyway contradicts the meter beside it, and an advisory that
    // fires where it cannot apply teaches a reader to ignore it.
    const parent = hyp([], { status: 'corroborated', children: ['c1'] });
    expect(evidenceLedger(parent, { sessionGrounded: true }).ungrounded).toBe(false);
  });

  it('does not mark a branch set aside, which claims no verdict to ground', () => {
    const setAside = hyp([ev({ type: 'neutral' })], { status: 'out-of-scope' });
    expect(evidenceLedger(setAside, { sessionGrounded: true }).ungrounded).toBe(false);
  });

  it('shows that a node holds records even when none of them weigh anything', () => {
    // Every record here was declared not to discriminate. The weights are zero,
    // so with only weights on the face the node is indistinguishable from one
    // that has no evidence at all — and a reader cannot tell that the question
    // was investigated and set aside.
    const h = hyp([
      ev({ type: 'refutes', nonDiagnostic: true }),
      ev({ type: 'supports', nonDiagnostic: true }),
    ]);
    const l = evidenceLedger(h, { sessionGrounded: false });
    expect(l.refuting).toBe(0);
    expect(l.supporting).toBe(0);
    expect(l.setAside).toBe(2);
  });

  it('leaves a node with no records showing nothing at all', () => {
    const l = evidenceLedger(hyp([]), { sessionGrounded: false });
    expect(l.setAside).toBe(0);
    expect(l.refuting + l.supporting + l.neutral).toBe(0);
  });

  it('keeps a set-aside neutral record out of the neutral count it does not weigh', () => {
    // refuting and supporting are weights; neutral must be measured the same way
    // or the same flag has opposite effects depending on record type.
    const l = evidenceLedger(hyp([
      ev({ type: 'neutral' }),
      ev({ type: 'neutral', nonDiagnostic: true }),
    ]), { sessionGrounded: false });
    expect(l.neutral).toBe(1);
    expect(l.setAside).toBe(1);
  });

  it('counts neutral records for display without weighing them', () => {
    const l = evidenceLedger(hyp([ev({ type: 'neutral' }), ev({ type: 'neutral' })]), { sessionGrounded: false });
    expect(l.neutral).toBe(2);
  });
});

describe('groundingMeter', () => {
  const leaf = (status: HypothesisStatus, kind: Evidence['kind']) =>
    hyp([ev({ type: 'supports', kind })], { status });

  it('measures settled leaves that carry a verbatim record', () => {
    const m = groundingMeter([
      leaf('corroborated', 'artifact'),
      leaf('eliminated', 'transcription'),
    ]);
    expect(m).toEqual({ grounded: 1, total: 2 });
  });

  it('leaves a branch set aside out of the count entirely', () => {
    // Out-of-scope asserts no refutation and claims no verdict, so counting it
    // as a verdict that lacks grounding reports a gap that does not exist.
    const m = groundingMeter([
      leaf('corroborated', 'artifact'),
      leaf('out-of-scope', 'transcription'),
      leaf('out-of-scope', 'artifact'),
    ]);
    expect(m).toEqual({ grounded: 1, total: 1 });
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

describe('linkedGroupSizes', () => {
  // A panel listing five records beside a tally of three is unreadable unless the
  // grouping is stated: the reader has no way to see which records weigh once.

  it('reports the size of each group that holds more than one record', () => {
    const h = hyp([
      ev({ type: 'supports', linkedGroupId: 'g1' }),
      ev({ type: 'supports', linkedGroupId: 'g1' }),
      ev({ type: 'supports', linkedGroupId: 'g1' }),
      ev({ type: 'refutes', linkedGroupId: 'g2' }),
      ev({ type: 'refutes', linkedGroupId: 'g2' }),
      ev({ type: 'supports' }),
    ]);
    expect(linkedGroupSizes(h)).toEqual(new Map([['g1', 3], ['g2', 2]]));
  });

  it('omits a group of one, which already weighs once', () => {
    const h = hyp([ev({ type: 'supports', linkedGroupId: 'solo' }), ev({ type: 'supports' })]);
    expect(linkedGroupSizes(h)).toEqual(new Map());
  });

  it('accounts for exactly the difference between the record count and the weight', () => {
    // The arithmetic a reader has to be able to do: records minus the records
    // hidden inside groups equals the weight the node face shows.
    const h = hyp([
      ev({ type: 'supports', linkedGroupId: 'g1' }),
      ev({ type: 'supports', linkedGroupId: 'g1' }),
      ev({ type: 'supports', linkedGroupId: 'g1' }),
      ev({ type: 'supports' }),
    ]);
    const collapsed = [...linkedGroupSizes(h).values()].reduce((sum, size) => sum + (size - 1), 0);
    expect(h.evidence.length - collapsed).toBe(evidenceLedger(h, { sessionGrounded: false }).supporting);
  });

  it('has nothing to report when no record was linked', () => {
    expect(linkedGroupSizes(hyp([ev({ type: 'supports' }), ev({ type: 'refutes' })]))).toEqual(new Map());
  });
});
