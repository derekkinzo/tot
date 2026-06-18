import { describe, it, expect } from 'vitest';
import { walkToRoot } from './walk';
import type { Hypothesis } from '../types';

function hyp(id: string, parentId: string | null): Hypothesis {
  return {
    id, parentId, sessionId: 's', depth: 0, content: id, status: 'exploring',
    evidence: [], metadata: { createdAt: '', updatedAt: '', source: 'agent' }, children: [],
  };
}
const tree = (...hs: Hypothesis[]) => new Map(hs.map((h) => [h.id, h]));

describe('walkToRoot', () => {
  it('yields nodes from start up to the root, ancestor-first', () => {
    const m = tree(hyp('root', null), hyp('a', 'root'), hyp('b', 'a'));
    expect([...walkToRoot('b', m)].map((h) => h.id)).toEqual(['b', 'a', 'root']);
  });

  it('stops at a parentId pointing to a missing node (does not yield the missing id)', () => {
    const m = tree(hyp('a', 'ghost'));
    expect([...walkToRoot('a', m)].map((h) => h.id)).toEqual(['a']);
  });

  it('terminates on a parentId cycle instead of spinning forever', () => {
    const m = tree(hyp('a', 'b'), hyp('b', 'a'));
    const ids = [...walkToRoot('a', m)].map((h) => h.id);
    expect(ids).toEqual(['a', 'b']); // each visited once, then stop on revisit
  });

  it('yields nothing for an unknown start id', () => {
    expect([...walkToRoot('nope', tree(hyp('a', null)))]).toEqual([]);
  });
});
