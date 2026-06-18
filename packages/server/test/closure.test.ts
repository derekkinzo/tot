import { describe, it, expect } from 'vitest';
import { fullyTerminal, topLevelBranchesDisposed, undisposedNodes, subtreeContainsCorroborated } from '../src/closure.js';
import type { Hypothesis, HypothesisStatus } from '../src/types.js';

function hyp(id: string, status: HypothesisStatus, children: string[] = [], parentId: string | null = null): Hypothesis {
  return {
    id, parentId, sessionId: 's', depth: 0, content: id, status,
    evidence: [], metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children,
  };
}
function lookupOf(...hs: Hypothesis[]) {
  const m = new Map(hs.map((h) => [h.id, h]));
  return (id: string) => m.get(id);
}

describe('fullyTerminal (descends through pruned)', () => {
  it('false when a pending grandchild hides under an eliminated intermediate', () => {
    // root(corroborated) → a(eliminated) → b(pending): the pruned intermediate
    // must NOT short-circuit; the pending grandchild makes the subtree non-terminal.
    const lookup = lookupOf(
      hyp('root', 'corroborated', ['a']),
      hyp('a', 'eliminated', ['b'], 'root'),
      hyp('b', 'pending', [], 'a'),
    );
    expect(fullyTerminal('root', lookup)).toBe(false);
  });

  it('true for an all-terminal subtree including through an out-of-scope intermediate', () => {
    const lookup = lookupOf(
      hyp('root', 'corroborated', ['a']),
      hyp('a', 'out-of-scope', ['b'], 'root'),
      hyp('b', 'eliminated', [], 'a'),
    );
    expect(fullyTerminal('root', lookup)).toBe(true);
  });

  it('false on the first non-terminal node encountered', () => {
    expect(fullyTerminal('root', lookupOf(hyp('root', 'exploring')))).toBe(false);
  });
});

describe('topLevelBranchesDisposed', () => {
  it('false when the root is missing', () => {
    expect(topLevelBranchesDisposed('ghost', lookupOf())).toBe(false);
  });

  it('false when any top-level child is pending or exploring', () => {
    const lookup = lookupOf(
      hyp('root', 'exploring', ['a', 'b']),
      hyp('a', 'eliminated', [], 'root'),
      hyp('b', 'pending', [], 'root'),
    );
    expect(topLevelBranchesDisposed('root', lookup)).toBe(false);
  });

  it('skips a missing child rather than failing', () => {
    const lookup = lookupOf(
      hyp('root', 'exploring', ['a', 'gone']),
      hyp('a', 'eliminated', [], 'root'),
    );
    // 'gone' is absent → skipped; 'a' is pruned → disposed.
    expect(topLevelBranchesDisposed('root', lookup)).toBe(true);
  });

  it('true when every top-level branch is pruned or a fully-terminal corroborated subtree (INUS: multiple corroborated leaves)', () => {
    const lookup = lookupOf(
      hyp('root', 'exploring', ['a', 'b', 'c']),
      hyp('a', 'eliminated', [], 'root'),
      hyp('b', 'corroborated', [], 'root'),
      hyp('c', 'corroborated', [], 'root'),
    );
    expect(topLevelBranchesDisposed('root', lookup)).toBe(true);
  });

  it('false when a corroborated top-level sits over a pending grandchild through a pruned intermediate', () => {
    const lookup = lookupOf(
      hyp('root', 'exploring', ['a']),
      hyp('a', 'corroborated', ['x'], 'root'),
      hyp('x', 'eliminated', ['y'], 'a'),
      hyp('y', 'pending', [], 'x'),
    );
    expect(topLevelBranchesDisposed('root', lookup)).toBe(false);
  });
});

describe('undisposedNodes vs fullyTerminal divergence (stop-AT vs descend-THROUGH pruned)', () => {
  it('a pending node under a pruned ancestor is excluded by undisposedNodes but breaks fullyTerminal', () => {
    const lookup = lookupOf(
      hyp('root', 'corroborated', ['a']),
      hyp('a', 'eliminated', ['b'], 'root'),
      hyp('b', 'pending', [], 'a'),
    );
    // undisposedNodes stops AT the pruned 'a', so 'b' is moot → no blockers.
    expect(undisposedNodes('root', lookup).map((h) => h.id)).toEqual([]);
    // fullyTerminal descends THROUGH 'a' and sees the pending 'b' → not terminal.
    expect(fullyTerminal('root', lookup)).toBe(false);
  });

  it('subtreeContainsCorroborated stops at pruned: a corroborated node under a pruned ancestor does not count', () => {
    const lookup = lookupOf(
      hyp('root', 'exploring', ['a']),
      hyp('a', 'out-of-scope', ['b'], 'root'),
      hyp('b', 'corroborated', [], 'a'),
    );
    expect(subtreeContainsCorroborated('root', lookup)).toBe(false);
  });
});
