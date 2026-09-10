import { describe, it, expect } from 'vitest';
import {
  countSupporting, countRefuting,
  supportingWeight, refutingWeight,
  hasUngroundedVerdict, sessionIsGrounded,
  type Evidence, type Hypothesis, type HypothesisStatus,
} from '@tot-mcp/shared';

const ts = '2024-01-01T00:00:00.000Z';

function ev(over: Partial<Evidence> & Pick<Evidence, 'type'>): Evidence {
  return { id: `e${Math.abs(hashCode(JSON.stringify(over)))}`, kind: 'transcription', content: 'x', timestamp: ts, ...over };
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function hyp(evidence: Evidence[], status: HypothesisStatus = 'exploring'): Hypothesis {
  return {
    id: 'h', parentId: null, sessionId: 's', depth: 0, title: 'h', status,
    evidence, metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [],
  };
}

describe('cardinality vs weight', () => {
  // Two distinct quantities: how many records were filed, and how much
  // independent discriminating force they carry. Naming them separately keeps a
  // caller from silently getting the other one.

  it('counts every record, including linked ones', () => {
    const g = 'group-1';
    const h = hyp([
      ev({ type: 'refutes', linkedGroupId: g }),
      ev({ type: 'refutes', linkedGroupId: g }),
      ev({ type: 'refutes', linkedGroupId: g }),
    ]);
    expect(countRefuting(h)).toBe(3);
  });

  it('weighs a linked group as one independent refutation', () => {
    const g = 'group-1';
    const h = hyp([
      ev({ type: 'refutes', linkedGroupId: g }),
      ev({ type: 'refutes', linkedGroupId: g }),
      ev({ type: 'refutes', linkedGroupId: g }),
    ]);
    expect(refutingWeight(h)).toBe(1);
  });

  it('weighs unlinked records independently', () => {
    const h = hyp([ev({ type: 'refutes' }), ev({ type: 'refutes', content: 'other' })]);
    expect(refutingWeight(h)).toBe(2);
  });

  it('weighs distinct groups separately and mixes with unlinked records', () => {
    const h = hyp([
      ev({ type: 'supports', linkedGroupId: 'a' }),
      ev({ type: 'supports', linkedGroupId: 'a', content: 'a2' }),
      ev({ type: 'supports', linkedGroupId: 'b' }),
      ev({ type: 'supports', content: 'lone' }),
    ]);
    expect(countSupporting(h)).toBe(4);
    expect(supportingWeight(h)).toBe(3); // group a + group b + the lone record
  });

  it('excludes an explicitly non-diagnostic record from weight but not from the count', () => {
    // Retained, not deleted: the record stays visible and countable, but an item
    // asserted not to discriminate adds no force to a verdict.
    const h = hyp([ev({ type: 'refutes' }), ev({ type: 'refutes', content: 'moot', nonDiagnostic: true })]);
    expect(countRefuting(h)).toBe(2);
    expect(refutingWeight(h)).toBe(1);
  });

  it('does not let a group survive on non-diagnostic members alone', () => {
    const h = hyp([
      ev({ type: 'refutes', linkedGroupId: 'g', nonDiagnostic: true }),
      ev({ type: 'refutes', linkedGroupId: 'g', content: 'b', nonDiagnostic: true }),
    ]);
    expect(refutingWeight(h)).toBe(0);
  });

  it('never counts the other polarity', () => {
    const h = hyp([ev({ type: 'supports' }), ev({ type: 'neutral' })]);
    expect(refutingWeight(h)).toBe(0);
    expect(supportingWeight(h)).toBe(1);
  });
});

describe('hasUngroundedVerdict', () => {
  // A settled verdict resting on no verbatim record is exactly computable and
  // needs no judgement, which is what makes it honest to surface.

  it('is true for a terminal verdict with only transcribed evidence', () => {
    for (const status of ['corroborated', 'eliminated', 'out-of-scope'] as const) {
      expect(hasUngroundedVerdict(hyp([ev({ type: 'supports', kind: 'transcription' })], status))).toBe(true);
    }
  });

  it('is false once any record on the node is a verbatim artifact', () => {
    const h = hyp([
      ev({ type: 'supports', kind: 'transcription' }),
      ev({ type: 'refutes', kind: 'artifact', content: 'captured' }),
    ], 'eliminated');
    expect(hasUngroundedVerdict(h)).toBe(false);
  });

  it('is false while the node is still open, however it is evidenced', () => {
    for (const status of ['pending', 'exploring'] as const) {
      expect(hasUngroundedVerdict(hyp([ev({ type: 'supports' })], status))).toBe(false);
    }
  });

  it('is true for a terminal verdict with no evidence at all', () => {
    expect(hasUngroundedVerdict(hyp([], 'out-of-scope'))).toBe(true);
  });
});

describe('sessionIsGrounded', () => {
  it('is false when no node anywhere carries a verbatim artifact', () => {
    expect(sessionIsGrounded([hyp([ev({ type: 'supports' })]), hyp([])])).toBe(false);
  });

  it('is true as soon as one node does', () => {
    expect(sessionIsGrounded([
      hyp([ev({ type: 'supports' })]),
      hyp([ev({ type: 'refutes', kind: 'artifact' })]),
    ])).toBe(true);
  });

  it('is false for an empty session', () => {
    expect(sessionIsGrounded([])).toBe(false);
  });
});

describe('qualifyEvidence', () => {
  // Re-labelling an existing record can hollow out a tally a verdict already
  // rested on, so it is only permitted while the session is open — unlike new
  // refuting evidence, which is new information and may reopen a closed session.
  it('marks a record non-diagnostic without removing it', async () => {
    const { TreeManager } = await import('../src/tree-manager.js');
    const tm = new TreeManager({});
    const { root } = tm.createSession('P');
    const { evidence } = tm.addEvidence(root.id, 'refutes', 'ambiguous');
    tm.qualifyEvidence(root.id, evidence.id, { nonDiagnostic: true });
    expect(root.evidence).toHaveLength(1);
    expect(root.evidence[0].nonDiagnostic).toBe(true);
    expect(countRefuting(root)).toBe(1);
    expect(refutingWeight(root)).toBe(0);
  });

  it('links records so they weigh as one observation', async () => {
    const { TreeManager } = await import('../src/tree-manager.js');
    const tm = new TreeManager({});
    const { root } = tm.createSession('P');
    const a = tm.addEvidence(root.id, 'refutes', 'half').evidence;
    const b = tm.addEvidence(root.id, 'refutes', 'other half').evidence;
    tm.qualifyEvidence(root.id, a.id, { linkedGroupId: 'pair' });
    tm.qualifyEvidence(root.id, b.id, { linkedGroupId: 'pair' });
    expect(refutingWeight(root)).toBe(1);
  });

  it('emits a hypothesis-updated so the change is journaled and streamed', async () => {
    const { TreeManager } = await import('../src/tree-manager.js');
    const tm = new TreeManager({});
    const { root } = tm.createSession('P');
    const { evidence } = tm.addEvidence(root.id, 'supports', 'x');
    const seen: string[] = [];
    tm.on('event', (e: { type: string }) => seen.push(e.type));
    tm.qualifyEvidence(root.id, evidence.id, { decisive: true });
    expect(seen).toContain('hypothesis-updated');
  });

  it('rejects an unknown evidence id rather than silently doing nothing', async () => {
    const { TreeManager } = await import('../src/tree-manager.js');
    const tm = new TreeManager({});
    const { root } = tm.createSession('P');
    expect(() => tm.qualifyEvidence(root.id, 'nope', { decisive: true })).toThrow(/evidence/i);
  });

  it('refuses to re-label a record once the session is closed', async () => {
    const { TreeManager } = await import('../src/tree-manager.js');
    const tm = new TreeManager({});
    const { session, root } = tm.createSession('P');
    const [a, b] = tm.decompose(root.id, [{ title: 'A' }, { title: 'B' }], { axis: 'by cause' });
    tm.addEvidence(a.id, 'refutes', 'no');
    tm.eliminateHypothesis(a.id, 'gone');
    const supporting = tm.addEvidence(b.id, 'supports', 'yes').evidence;
    tm.corroborateHypothesis(b.id, 'survives');
    expect(session.status).toBe('resolved');
    expect(() => tm.qualifyEvidence(b.id, supporting.id, { nonDiagnostic: true }))
      .toThrow(/resolved|closed/i);
  });
});

describe('grounding a verdict that is already settled', () => {
  // The canvas marks a settled leaf that carries no verbatim record, and counts it
  // against the project's grounded tally. The record the verdict rests on agrees
  // with that verdict, so re-filing it with a capture is refused, and filing the
  // bytes as the opposite type would tear the verdict down in order to attach its
  // own evidence. Attaching them to the record already on the ledger is what
  // leaves the verdict standing and the flag answered.
  const artifact = (filename: string) => ({
    id: `art-${filename}`,
    sessionId: 'irrelevant-here',
    digest: { alg: 'sha-256' as const, value: 'd'.repeat(64) },
    filename,
    mediaType: 'text/plain',
    byteLength: 42,
    capturedAt: '2024-01-01T00:00:00.000Z',
  });

  /** A settled leaf whose verdict rests on a paraphrase, beside a live sibling. */
  async function settledOnAParaphrase() {
    const { TreeManager } = await import('../src/tree-manager.js');
    const tm = new TreeManager({});
    const { root } = tm.createSession('why the deploy stalls', 'Deploy stalls');
    const kids = tm.decompose(root.id, [{ title: 'Cache miss' }, { title: 'Slow tests' }], { axis: 'by stage' });
    const { evidence } = tm.addEvidence(kids[0].id, 'refutes', 'the cache is warm on every run');
    tm.eliminateHypothesis(kids[0].id, 'the cache is warm');
    return { tm, nodeId: kids[0].id, evidenceId: evidence.id };
  }

  it('is flagged until the bytes are attached', async () => {
    const { tm, nodeId } = await settledOnAParaphrase();
    expect(hasUngroundedVerdict(tm.getHypothesis(nodeId)!)).toBe(true);
  });

  it('is answered by attaching the bytes to the record it rests on', async () => {
    const { tm, nodeId, evidenceId } = await settledOnAParaphrase();
    tm.qualifyEvidence(nodeId, evidenceId, { artifact: artifact('cache-stats.log') });
    const node = tm.getHypothesis(nodeId)!;
    expect(hasUngroundedVerdict(node)).toBe(false);
    expect(node.evidence[0].kind).toBe('artifact');
    expect(node.evidence[0].artifact?.filename).toBe('cache-stats.log');
  });

  it('leaves the verdict standing, which is the whole point of attaching rather than re-filing', async () => {
    const { tm, nodeId, evidenceId } = await settledOnAParaphrase();
    tm.qualifyEvidence(nodeId, evidenceId, { artifact: artifact('cache-stats.log') });
    const node = tm.getHypothesis(nodeId)!;
    expect(node.status).toBe('eliminated');
    expect(node.conclusion?.reason).toBe('the cache is warm');
  });

  it('refuses a second capture on one record, rather than replacing the first', async () => {
    // A record cites one capture: the excerpt and the digest describe those bytes,
    // and replacing them would leave both describing something nothing points at.
    const { tm, nodeId, evidenceId } = await settledOnAParaphrase();
    tm.qualifyEvidence(nodeId, evidenceId, { artifact: artifact('cache-stats.log') });
    expect(() => tm.qualifyEvidence(nodeId, evidenceId, { artifact: artifact('other.log') }))
      .toThrow(/already cites captured bytes \(cache-stats\.log\)/);
    expect(tm.getHypothesis(nodeId)!.evidence[0].artifact?.filename).toBe('cache-stats.log');
  });

  it('leaves a record with no capture a paraphrase, so the mark is only cleared when earned', async () => {
    const { tm, nodeId, evidenceId } = await settledOnAParaphrase();
    tm.qualifyEvidence(nodeId, evidenceId, { decisive: true });
    const node = tm.getHypothesis(nodeId)!;
    expect(node.evidence[0].kind).toBe('transcription');
    expect(hasUngroundedVerdict(node)).toBe(true);
  });
});
