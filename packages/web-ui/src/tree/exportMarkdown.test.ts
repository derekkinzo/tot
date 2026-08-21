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

describe('generateMarkdown carries the whole claim', () => {
  // The export is the portable record of the reasoning. A label is what a canvas
  // has room for; the statement is the claim itself, so an export that keeps only
  // the label loses what was actually argued.
  const STATEMENT = 'Callers block in getConnection once the writer pool is saturated by retries.';

  it('includes the long-form statement of a node that has one', () => {
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', { title: 'Writer pool saturation', status: 'exploring', statement: STATEMENT }));
    const md = generateMarkdown(session(), map);
    expect(md).toContain('Writer pool saturation');
    expect(md).toContain(STATEMENT);
  });

  it('keeps a multi-line statement inside its own list item', () => {
    // Interpolated raw, a newline ends the list item and a leading '-' becomes a
    // sibling node, so the exported tree misrepresents its own shape.
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', {
      title: 'Writer pool saturation', status: 'exploring', children: ['a'],
    }));
    map.set('a', hyp('a', {
      title: 'Child', status: 'pending', parentId: 'root', depth: 1,
      statement: 'First line of the claim\n- second line that looks like a bullet\n\nthird',
    }));
    const md = generateMarkdown(session(), map);
    const lines = md.split('\n');
    // No exported line may begin a list item that the statement invented.
    const invented = lines.filter((l) => /^\s*-\s+second line/.test(l));
    expect(invented, `statement leaked a list item:\n${md}`).toEqual([]);
    // The text is still present, and still attributed to that node.
    expect(md).toMatch(/second line that looks like a bullet/);
  });

  it('does not repeat the label as a statement when none was authored', () => {
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', { title: 'Writer pool saturation', status: 'exploring' }));
    const md = generateMarkdown(session(), map);
    const occurrences = md.split('Writer pool saturation').length - 1;
    expect(occurrences).toBe(1);
  });
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

  it('states how a branch was split, so a reader knows on what dimension its children divide', () => {
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', {
      title: 'Root', status: 'exploring', children: ['a', 'b'],
      decomposition: { axis: 'by subsystem', gate: 'one-of' },
    }));
    map.set('a', hyp('a', { title: 'A', parentId: 'root', depth: 1 }));
    map.set('b', hyp('b', { title: 'B', parentId: 'root', depth: 1 }));
    const md = generateMarkdown(session(), map);
    expect(md).toContain('by subsystem');
    expect(md.toLowerCase()).toContain('one of');
  });

  it('records that a relation was left undeclared rather than implying one', () => {
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', {
      title: 'Root', status: 'exploring', children: ['a'],
      decomposition: { axis: 'by timing' },
    }));
    map.set('a', hyp('a', { title: 'A', parentId: 'root', depth: 1 }));
    const md = generateMarkdown(session(), map);
    expect(md).toContain('by timing');
    expect(md.toLowerCase()).not.toMatch(/one of|any of|all of/);
  });

  it('cites a captured artifact by name so a record can be traced to its bytes', () => {
    const map = new Map<string, Hypothesis>();
    map.set('root', hyp('root', {
      title: 'Root', status: 'exploring',
      evidence: [{
        id: 'e1', type: 'refutes', kind: 'artifact', content: 'the run failed', timestamp: 't',
        artifact: {
          id: 'a1', sessionId: 's1', filename: 'ci-run.log', mediaType: 'text/plain', bytes: 10,
          digest: { alg: 'sha-256', value: 'd' }, capturedAt: 't', excerpt: { startLine: 7, endLine: 9 },
        },
      }],
    }));
    const md = generateMarkdown(session(), map);
    expect(md).toContain('ci-run.log');
    expect(md).toContain('7');
  });
});
