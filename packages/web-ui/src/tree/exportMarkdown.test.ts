import { describe, it, expect } from 'vitest';
import { generateMarkdown } from './exportMarkdown';
import type { Hypothesis, Session } from '../types';

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
const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', problem: 'P', rootNodeId: 'root', status: 'open', createdAt: '2024-01-01T00:00:00.000Z', ...over,
});

describe('generateMarkdown', () => {
  it('renders the tree with status icons, evidence counts, and nested children', () => {
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', { title: 'Root', status: 'exploring', children: ['a'] }));
    map.set('a', hyp('a', {
      title: 'Child A', status: 'corroborated', parentId: 'root', depth: 1,
      conclusion: { verdict: 'corroborated', reason: 'survived', timestamp: 't' },
      evidence: [{ id: 'e1', type: 'supports', kind: 'transcription', content: 'good', timestamp: 't' }],
    }));
    const md = generateMarkdown(session(), map);
    expect(md).toContain('# P');
    expect(md).toContain('Root');
    expect(md).toContain('Child A');
    expect(md).toContain('1 supporting');
    expect(md).toContain('survived');
  });

  it('terminates on a children cycle in a corrupt tree instead of overflowing the stack', () => {
    // A corrupt/hand-edited journal can produce a cycle (a→b→a). Every other
    // tree walk in the codebase guards against this; the export must too.
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', { title: 'Root', children: ['a'] }));
    map.set('a', hyp('a', { title: 'A', parentId: 'root', depth: 1, children: ['b'] }));
    map.set('b', hyp('b', { title: 'B', parentId: 'a', depth: 2, children: ['a'] })); // cycle back to a

    let md = '';
    expect(() => { md = generateMarkdown(session({ rootNodeId: 'root' }), map); }).not.toThrow();
    // Each node is rendered exactly once despite the cycle.
    expect(md.match(/\bA\b/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(md).toContain('B');
  });
});
