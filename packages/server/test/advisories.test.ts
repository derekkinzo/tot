import { describe, it, expect } from 'vitest';
import {
  countSupporting, countRefuting,
  needsBaselinePrompt, readsAsInference, isConfirmationBias,
  lacksSourceDiversity, suggestsElimination, lacksDiagnosticity,
} from '../src/advisories.js';
import type { Evidence, Hypothesis, HypothesisStatus } from '../src/types.js';

let n = 0;
function ev(type: Evidence['type'], content = 'x', source?: string): Evidence {
  return { id: `e${n++}`, type, content, source, timestamp: '' };
}
function hyp(evidence: Evidence[], status: HypothesisStatus = 'exploring'): Hypothesis {
  return {
    id: 'h', parentId: 'root', sessionId: 's', depth: 1, title: 'h', status,
    evidence, metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children: [],
  };
}
function sib(id: string, status: HypothesisStatus, evidence: Evidence[] = []): Hypothesis {
  return {
    id, parentId: 'root', sessionId: 's', depth: 1, title: id, status,
    evidence, metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children: [],
  };
}

describe('countSupporting / countRefuting (shared source of truth)', () => {
  it('count each evidence type independently', () => {
    const h = hyp([ev('supports'), ev('supports'), ev('refutes'), ev('neutral')]);
    expect(countSupporting(h)).toBe(2);
    expect(countRefuting(h)).toBe(1);
  });
  it('are zero on an empty hypothesis', () => {
    expect(countSupporting(hyp([]))).toBe(0);
    expect(countRefuting(hyp([]))).toBe(0);
  });
});

describe('needsBaselinePrompt', () => {
  it('true on the first non-refuting evidence item', () => {
    expect(needsBaselinePrompt(hyp([ev('supports')]))).toBe(true);
  });
  it('false when the first item is refuting', () => {
    expect(needsBaselinePrompt(hyp([ev('refutes')]))).toBe(false);
  });
  it('false once there is more than one evidence item', () => {
    expect(needsBaselinePrompt(hyp([ev('supports'), ev('neutral')]))).toBe(false);
  });
});

describe('readsAsInference', () => {
  it('true when the latest supports/neutral item has >=2 hedge words', () => {
    expect(readsAsInference(hyp([ev('supports', 'this likely suggests a leak')]))).toBe(true);
  });
  it('false with fewer than 2 hedge words', () => {
    expect(readsAsInference(hyp([ev('supports', 'this likely happened')]))).toBe(false);
  });
  it('false when the latest item is refuting (direct disproof, not inference)', () => {
    expect(readsAsInference(hyp([ev('refutes', 'could possibly indicate')]))).toBe(false);
  });
});

describe('isConfirmationBias (Popper asymmetry / Heuer ACH)', () => {
  it('FIRES at >=3 supporting, 0 refuting, with a live rival — the classic red flag', () => {
    const h = hyp([ev('supports'), ev('supports'), ev('supports')]);
    expect(isConfirmationBias(h, [sib('a', 'exploring')])).toBe(true);
  });
  it('does NOT fire once any refuting evidence exists (the agent sought disconfirmation)', () => {
    const h = hyp([ev('supports'), ev('supports'), ev('supports'), ev('refutes')]);
    expect(isConfirmationBias(h, [sib('a', 'exploring')])).toBe(false);
  });
  it('does NOT fire with no live sibling (scoped to competitive contexts — ratified)', () => {
    const h = hyp([ev('supports'), ev('supports'), ev('supports')]);
    expect(isConfirmationBias(h, [sib('a', 'eliminated')])).toBe(false);
    expect(isConfirmationBias(h, [])).toBe(false);
  });
  it('does NOT fire below the 3-supporting threshold', () => {
    const h = hyp([ev('supports'), ev('supports')]);
    expect(isConfirmationBias(h, [sib('a', 'exploring')])).toBe(false);
  });
});

describe('lacksSourceDiversity (Heuer independence)', () => {
  it('true when >=3 items and all sourced items cite one origin', () => {
    expect(lacksSourceDiversity(hyp([ev('supports', 'x', 'logs'), ev('supports', 'y', 'logs'), ev('neutral', 'z')]))).toBe(true);
  });
  it('false when sources differ', () => {
    expect(lacksSourceDiversity(hyp([ev('supports', 'x', 'logs'), ev('supports', 'y', 'metrics'), ev('neutral', 'z')]))).toBe(false);
  });
  it('false below 3 evidence items', () => {
    expect(lacksSourceDiversity(hyp([ev('supports', 'x', 'logs'), ev('supports', 'y', 'logs')]))).toBe(false);
  });
  it('false when fewer than 2 items carry a source', () => {
    expect(lacksSourceDiversity(hyp([ev('supports', 'x', 'logs'), ev('supports'), ev('neutral')]))).toBe(false);
  });
  it('ignores refuting-evidence sources — the nudge is about corroboration diversity', () => {
    // Three refutes from one source are not a corroboration-independence problem
    // (refutation does not "strengthen" a hypothesis); only the diversity of
    // SUPPORTING sources is relevant. With no repeated supporting source, the
    // advisory must not fire.
    expect(lacksSourceDiversity(hyp([
      ev('refutes', 'x', 'logs'), ev('refutes', 'y', 'logs'), ev('refutes', 'z', 'logs'),
    ]))).toBe(false);
  });
  it('fires on >=2 supporting items sharing one source even amid diverse refuting sources', () => {
    expect(lacksSourceDiversity(hyp([
      ev('supports', 'x', 'logs'), ev('supports', 'y', 'logs'),
      ev('refutes', 'z', 'metrics'),
    ]))).toBe(true);
  });
});

describe('suggestsElimination (Bacon/Mill)', () => {
  it('true at >=2 refuting and 0 supporting', () => {
    expect(suggestsElimination(hyp([ev('refutes'), ev('refutes')]))).toBe(true);
  });
  it('false when any supporting evidence exists', () => {
    expect(suggestsElimination(hyp([ev('refutes'), ev('refutes'), ev('supports')]))).toBe(false);
  });
});

describe('lacksDiagnosticity (Heuer ACH)', () => {
  it('true when latest supports, this has >=2 items, and no open rival has been refuted', () => {
    const h = hyp([ev('supports'), ev('supports')]);
    expect(lacksDiagnosticity(h, [sib('a', 'exploring')])).toBe(true);
  });
  it('false when an open rival already has refuting evidence (the evidence does discriminate)', () => {
    const h = hyp([ev('supports'), ev('supports')]);
    expect(lacksDiagnosticity(h, [sib('a', 'exploring', [ev('refutes')])])).toBe(false);
  });
  it('false when there is no open rival', () => {
    const h = hyp([ev('supports'), ev('supports')]);
    expect(lacksDiagnosticity(h, [sib('a', 'corroborated')])).toBe(false);
  });
  it('false when the latest evidence is not supporting', () => {
    const h = hyp([ev('supports'), ev('refutes')]);
    expect(lacksDiagnosticity(h, [sib('a', 'exploring')])).toBe(false);
  });
});
