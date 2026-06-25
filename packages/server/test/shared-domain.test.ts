import { describe, it, expect } from 'vitest';
import {
  isPruned, isLive, isTerminal, isOpen,
  countSupporting, countRefuting,
  type Hypothesis, type HypothesisStatus,
} from '@tot-mcp/shared';

const ALL: HypothesisStatus[] = ['pending', 'exploring', 'eliminated', 'corroborated', 'out-of-scope'];

function hyp(types: Array<'supports' | 'refutes' | 'neutral'>): Hypothesis {
  return {
    id: 'h', parentId: null, sessionId: 's', depth: 0, content: 'h', status: 'exploring',
    evidence: types.map((type, i) => ({ id: `e${i}`, type, content: 'x', timestamp: '' })),
    metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children: [],
  };
}

describe('@tot-mcp/shared status predicates', () => {
  it('isPruned is exactly eliminated + out-of-scope', () => {
    expect(ALL.filter(isPruned)).toEqual(['eliminated', 'out-of-scope']);
  });

  it('isTerminal is exactly eliminated + corroborated + out-of-scope', () => {
    expect(ALL.filter(isTerminal)).toEqual(['eliminated', 'corroborated', 'out-of-scope']);
  });

  it('isOpen is exactly pending + exploring', () => {
    expect(ALL.filter(isOpen)).toEqual(['pending', 'exploring']);
  });

  it('isLive is the complement of isPruned', () => {
    for (const s of ALL) expect(isLive(s)).toBe(!isPruned(s));
  });
});

describe('@tot-mcp/shared evidence counts', () => {
  it('count each type independently', () => {
    const h = hyp(['supports', 'supports', 'refutes', 'neutral']);
    expect(countSupporting(h)).toBe(2);
    expect(countRefuting(h)).toBe(1);
  });

  it('are zero on an empty hypothesis', () => {
    const h = hyp([]);
    expect(countSupporting(h)).toBe(0);
    expect(countRefuting(h)).toBe(0);
  });
});
