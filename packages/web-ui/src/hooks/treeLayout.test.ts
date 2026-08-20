import { describe, it, expect } from 'vitest';
import { getPathToRoot, computeLayout } from './treeLayout';
import { HIGHLIGHT_COLORS } from '../theme';
import { NODE_WIDTH, NODE_HEIGHT } from '../geometry';
import type { Hypothesis, HypothesisStatus } from '../types';

function hyp(id: string, parentId: string | null, children: string[], status: HypothesisStatus = 'exploring'): Hypothesis {
  return {
    id, parentId, sessionId: 's', depth: 0, title: id, status,
    evidence: [], metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children,
  };
}

/** Build a Map from a list of hypotheses. */
function tree(...hs: Hypothesis[]): Map<string, Hypothesis> {
  return new Map(hs.map((h) => [h.id, h]));
}

describe('getPathToRoot', () => {
  it('returns the chain of ids from a node up to the root', () => {
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', ['b']), hyp('b', 'a', []));
    expect([...getPathToRoot('b', m)]).toEqual(['b', 'a', 'root']);
  });

  it('terminates on a parentId cycle instead of spinning forever', () => {
    // a -> b -> a is a corrupt cycle; the walk must stop on revisit.
    const m = tree(hyp('a', 'b', []), hyp('b', 'a', []));
    const path = getPathToRoot('a', m);
    expect(path.has('a')).toBe(true);
    expect(path.has('b')).toBe(true);
    expect(path.size).toBe(2);
  });

  it('omits a dangling parentId (path contains only existing nodes)', () => {
    // a.parentId='ghost' but ghost is absent: walkToRoot yields only nodes that
    // exist, so the path ends at 'a' and never includes the dangling id.
    const m = tree(hyp('a', 'ghost', []));
    expect([...getPathToRoot('a', m)]).toEqual(['a']);
  });
});

describe('computeLayout', () => {
  const NO_PATH = new Set<string>();
  const NO_COLLAPSE = new Set<string>();

  it('declares the box the layout reserved, so overview widgets can place a node', () => {
    // The layout spaces siblings by NODE_WIDTH/NODE_HEIGHT plus a gap, so the
    // reserved box is known before the DOM measures anything. A node that keeps
    // it to itself leaves every consumer that reads dimensions off the node —
    // the minimap among them — with nothing to draw.
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', []));
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    for (const n of nodes) {
      expect(n.width).toBe(NODE_WIDTH);
      expect(n.height).toBe(NODE_HEIGHT);
    }
  });

  it('lays out a simple tree: every node becomes a positioned node', () => {
    const m = tree(hyp('root', null, ['a', 'b']), hyp('a', 'root', []), hyp('b', 'root', []));
    const { nodes, edges } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'root']);
    // Two edges: root→a, root→b.
    expect(edges.map((e) => e.id).sort()).toEqual(['root-a', 'root-b']);
  });

  it('hides descendants of a collapsed node', () => {
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', ['b']), hyp('b', 'a', []));
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, new Set(['a']));
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'root']); // b hidden under collapsed a
  });

  it('marks the selected node and sets onPath from pathToRoot', () => {
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', []));
    const path = getPathToRoot('a', m);
    const { nodes } = computeLayout(m, 'root', 'a', path, NO_COLLAPSE);
    const a = nodes.find((n) => n.id === 'a')!;
    expect(a.data.selected).toBe(true);
    expect(a.data.onPath).toBe(true);
  });

  // ─── transient-orphan adoption (the subtlest, previously-untested logic) ───

  it('renders a transient orphan attached to its real parent, not root or dropped', () => {
    // 'child' carries parentId='root' but root.children does NOT list it yet
    // (the parent's hypothesis-updated has not arrived). It must still render,
    // attached to root via the parentId back-pointer.
    const m = tree(hyp('root', null, []), hyp('child', 'root', []));
    const { nodes, edges } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    expect(nodes.map((n) => n.id).sort()).toEqual(['child', 'root']);
    // The edge anchors the orphan to its real parent.
    expect(edges.find((e) => e.id === 'root-child')).toBeDefined();
  });

  it('keeps a transient orphan hidden when its nearest visible ancestor is collapsed', () => {
    // root has a (collapsed); 'gc' is an orphan whose chain gc→a hits collapsed a.
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', []), hyp('gc', 'a', []));
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, new Set(['a']));
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'root']); // gc stays hidden
  });

  it('does not hang on an orphan whose parentId chain cycles', () => {
    // root is the tree; x↔y form an orphan cycle unreachable from root.
    const m = tree(hyp('root', null, []), hyp('x', 'y', []), hyp('y', 'x', []));
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    // Cycle never reaches a visible anchor → x,y stay hidden, no infinite loop.
    expect(nodes.map((n) => n.id)).toEqual(['root']);
  });

  it('does not stack-overflow on a children[] cycle among visible nodes; lays each node once', () => {
    // root → a → b → a: a corrupt children cycle reachable from root. buildTree
    // must visit each node once and terminate rather than infinitely recurse.
    const m = tree(
      hyp('root', null, ['a']),
      hyp('a', 'root', ['b']),
      hyp('b', 'a', ['a']), // cycle back to a
    );
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'root']);
    // No duplicate nodes from re-descending the cycle.
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it('leaves clear space between siblings, so no face overlaps its neighbour', () => {
    // The layout reserves room for a face of NODE_WIDTH and positions each node
    // by that same width; a disagreement between the two shows up here as
    // overlapping siblings.
    const m = tree(
      hyp('root', null, ['a', 'b', 'c']),
      hyp('a', 'root', []), hyp('b', 'root', []), hyp('c', 'root', []),
    );
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    const xs = nodes.filter((n) => n.id !== 'root').map((n) => n.position.x).sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(NODE_WIDTH);
    }
  });

  it('separates each level by more than a face is tall, so a child never overlaps its parent', () => {
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', ['b']), hyp('b', 'a', []));
    const { nodes } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    const ys = nodes.map((n) => n.position.y).sort((p, q) => p - q);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(NODE_HEIGHT);
    }
  });

  it('styles an edge as on-path only when BOTH endpoints are on the path', () => {
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', ['b']), hyp('b', 'a', []));
    const path = getPathToRoot('b', m); // {b, a, root}
    const { edges } = computeLayout(m, 'root', 'b', path, NO_COLLAPSE);
    const rootA = edges.find((e) => e.id === 'root-a')!;
    expect(rootA.style?.stroke).toBe(HIGHLIGHT_COLORS.pathEdge); // both root & a on path
  });

  it('styles a pruned-status edge with the pruned color', () => {
    const m = tree(hyp('root', null, ['a']), hyp('a', 'root', [], 'eliminated'));
    const { edges } = computeLayout(m, 'root', null, NO_PATH, NO_COLLAPSE);
    const rootA = edges.find((e) => e.id === 'root-a')!;
    expect(rootA.style?.stroke).toBe(HIGHLIGHT_COLORS.prunedEdge);
  });
});
