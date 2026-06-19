import { describe, it, expect } from 'vitest';
import { conclusionStatus } from './conclusion';
import type { Hypothesis, HypothesisStatus } from '../types';

function hyp(status: HypothesisStatus, conclusion?: Hypothesis['conclusion']): Hypothesis {
  return {
    id: 'h', parentId: null, sessionId: 's', depth: 0, content: 'h', status,
    evidence: [], metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children: [],
    conclusion,
  };
}

describe('conclusionStatus', () => {
  it('returns null when there is no conclusion record', () => {
    expect(conclusionStatus(hyp('exploring'))).toBeNull();
  });

  it('is not historical when live status matches the verdict and no supersededBy', () => {
    const s = conclusionStatus(hyp('corroborated', { verdict: 'corroborated', reason: 'r', timestamp: '' }))!;
    expect(s.isHistorical).toBe(false);
    expect(s.verdict).toBe('corroborated');
    expect(s.supersededByDescendant).toBe(false);
  });

  it('is historical via the explicit supersededBy=self signal even if status still matches', () => {
    // supersededBy='self' is the direct-refute reopen marker; it forces historical.
    const s = conclusionStatus(hyp('exploring', { verdict: 'corroborated', reason: 'r', timestamp: '', supersededBy: 'self' }))!;
    expect(s.isHistorical).toBe(true);
    expect(s.supersededByDescendant).toBe(false);
  });

  it('flags supersededByDescendant for a cascade-demote reopen', () => {
    const s = conclusionStatus(hyp('exploring', { verdict: 'corroborated', reason: 'r', timestamp: '', supersededBy: 'descendant' }))!;
    expect(s.isHistorical).toBe(true);
    expect(s.supersededByDescendant).toBe(true);
  });

  it('is historical via the legacy fallback (status != verdict, no supersededBy field)', () => {
    // Older reopen records carry status='exploring', verdict='corroborated', no field.
    const s = conclusionStatus(hyp('exploring', { verdict: 'corroborated', reason: 'r', timestamp: '' }))!;
    expect(s.isHistorical).toBe(true);
    expect(s.supersededByDescendant).toBe(false);
  });
});
