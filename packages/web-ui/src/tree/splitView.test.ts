import { describe, it, expect } from 'vitest';
import { splitBadge, splitConflicts } from './splitView';
import type { Hypothesis, HypothesisStatus } from '../types';

const ts = '2024-01-01T00:00:00.000Z';

function node(id: string, status: HypothesisStatus, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id, parentId: 'p', sessionId: 's', depth: 1, title: id, status,
    evidence: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [], ...over,
  };
}

describe('splitBadge', () => {
  it('is absent for a leaf, which has no split to describe', () => {
    expect(splitBadge(node('a', 'exploring'))).toBeNull();
  });

  it('is absent for a parent whose split was never recorded', () => {
    expect(splitBadge(node('p', 'exploring', { children: ['a', 'b'] }))).toBeNull();
  });

  it('shows the gate and the axis it splits along', () => {
    const badge = splitBadge(node('p', 'exploring', {
      children: ['a', 'b'],
      decomposition: { axis: 'by subsystem', gate: 'one-of' },
    }));
    expect(badge).toEqual({ label: 'one of', axis: 'by subsystem', title: expect.stringMatching(/at most one/i) });
  });

  it('shows the axis alone when no relation was declared, rather than assuming one', () => {
    // Guessing a relation would put a claim on the canvas that nobody made.
    const badge = splitBadge(node('p', 'exploring', {
      children: ['a', 'b'],
      decomposition: { axis: 'by timing' },
    }));
    expect(badge?.axis).toBe('by timing');
    expect(badge?.label).toBeNull();
    expect(badge?.title).toMatch(/not declared|no relation/i);
  });

  it('describes a split whose children are not yet loaded, since the axis is on the node itself', () => {
    const badge = splitBadge(node('p', 'exploring', {
      children: ['a'],
      decomposition: { axis: 'by subsystem', gate: 'all-of' },
    }));
    expect(badge?.axis).toBe('by subsystem');
  });
});

describe('splitConflicts', () => {
  const hypotheses = (nodes: Hypothesis[]) => new Map(nodes.map((n) => [n.id, n]));

  it('is empty for a node whose children agree with its declared relation', () => {
    const p = node('p', 'exploring', { children: ['a', 'b'], decomposition: { axis: 'x', gate: 'one-of' } });
    expect(splitConflicts(p, hypotheses([p, node('a', 'corroborated'), node('b', 'eliminated')]))).toEqual([]);
  });

  it('surfaces a conflict between the declaration and the verdicts recorded', () => {
    const p = node('p', 'exploring', { children: ['a', 'b'], decomposition: { axis: 'x', gate: 'one-of' } });
    const conflicts = splitConflicts(p, hypotheses([p, node('a', 'corroborated'), node('b', 'corroborated')]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].message).toMatch(/\S/);
  });

  it('resolves each affected child to the label a reader sees, not its id', () => {
    const p = node('p', 'exploring', { children: ['a', 'b'], decomposition: { axis: 'x', gate: 'one-of' } });
    const conflicts = splitConflicts(p, hypotheses([
      p,
      node('a', 'corroborated', { title: 'the database' }),
      node('b', 'corroborated', { title: 'the network' }),
    ]));
    expect(conflicts[0].nodes).toEqual([
      { id: 'a', label: 'the database' },
      { id: 'b', label: 'the network' },
    ]);
  });

  it('is empty when a child is not loaded, so no conflict rests on an unknown verdict', () => {
    const p = node('p', 'exploring', { children: ['a', 'missing'], decomposition: { axis: 'x', gate: 'one-of' } });
    expect(splitConflicts(p, hypotheses([p, node('a', 'corroborated')]))).toEqual([]);
  });
});
