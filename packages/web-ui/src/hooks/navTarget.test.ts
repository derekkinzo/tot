import { describe, it, expect } from 'vitest';
import { nextNavTarget } from './navTarget';
import type { Hypothesis } from '../types';

function hyp(id: string, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id,
    parentId: null,
    sessionId: 's1',
    depth: 0,
    title: `content ${id}`,
    status: 'pending',
    evidence: [],
    metadata: { createdAt: 't', updatedAt: 't', source: 'agent' },
    children: [],
    ...over,
  };
}

/** root → [a, b, c]; a → [a1] */
function tree(): Map<string, Hypothesis> {
  return new Map<string, Hypothesis>([
    ['root', hyp('root', { children: ['a', 'b', 'c'] })],
    ['a', hyp('a', { parentId: 'root', depth: 1, children: ['a1'] })],
    ['b', hyp('b', { parentId: 'root', depth: 1 })],
    ['c', hyp('c', { parentId: 'root', depth: 1 })],
    ['a1', hyp('a1', { parentId: 'a', depth: 2 })],
  ]);
}

describe('nextNavTarget', () => {
  it('ArrowUp moves to the parent', () => {
    expect(nextNavTarget('ArrowUp', 'a', tree())).toBe('root');
  });

  it('ArrowUp on the root stays put (no target)', () => {
    expect(nextNavTarget('ArrowUp', 'root', tree())).toBeNull();
  });

  it('ArrowDown moves to the first child', () => {
    expect(nextNavTarget('ArrowDown', 'root', tree())).toBe('a');
    expect(nextNavTarget('ArrowDown', 'a', tree())).toBe('a1');
  });

  it('ArrowDown on a leaf has no target', () => {
    expect(nextNavTarget('ArrowDown', 'b', tree())).toBeNull();
  });

  it('ArrowLeft/ArrowRight move between siblings in declared order', () => {
    expect(nextNavTarget('ArrowRight', 'a', tree())).toBe('b');
    expect(nextNavTarget('ArrowRight', 'b', tree())).toBe('c');
    expect(nextNavTarget('ArrowLeft', 'c', tree())).toBe('b');
    expect(nextNavTarget('ArrowLeft', 'b', tree())).toBe('a');
  });

  it('sibling movement stops at both ends rather than wrapping', () => {
    expect(nextNavTarget('ArrowLeft', 'a', tree())).toBeNull();
    expect(nextNavTarget('ArrowRight', 'c', tree())).toBeNull();
  });

  it('sibling movement from the root has no target (no parent)', () => {
    expect(nextNavTarget('ArrowLeft', 'root', tree())).toBeNull();
    expect(nextNavTarget('ArrowRight', 'root', tree())).toBeNull();
  });

  it('an unhandled key has no target', () => {
    for (const key of ['Escape', 'Enter', 'a', 'Tab', ' ']) {
      expect(nextNavTarget(key, 'a', tree())).toBeNull();
    }
  });

  it('a selection absent from the map has no target', () => {
    expect(nextNavTarget('ArrowUp', 'ghost', tree())).toBeNull();
    expect(nextNavTarget('ArrowDown', 'ghost', tree())).toBeNull();
  });

  it('a null selection has no target', () => {
    expect(nextNavTarget('ArrowDown', null, tree())).toBeNull();
  });

  it('a dangling parentId does not resolve to a target', () => {
    // A corrupt or partially-streamed tree can name a parent that is absent.
    const m = new Map<string, Hypothesis>([['x', hyp('x', { parentId: 'missing' })]]);
    expect(nextNavTarget('ArrowLeft', 'x', m)).toBeNull();
    expect(nextNavTarget('ArrowRight', 'x', m)).toBeNull();
    // Moving up to a named-but-absent parent is not a valid target either.
    expect(nextNavTarget('ArrowUp', 'x', m)).toBeNull();
  });

  it('only ever returns an id present in the map', () => {
    const m = tree();
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      for (const id of [...m.keys()]) {
        const target = nextNavTarget(key, id, m);
        if (target !== null) expect(m.has(target)).toBe(true);
      }
    }
  });
});
