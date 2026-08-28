import { describe, it, expect } from 'vitest';
import {
  isPruned, isLive, isTerminal, isOpen,
  countSupporting, countRefuting,
  deriveTitle, TITLE_MAX_LENGTH, nodeLabel, readsAsClause, splitProse, titleProblem,
  type Hypothesis, type HypothesisStatus,
} from '@tot-mcp/shared';

const ALL: HypothesisStatus[] = ['pending', 'exploring', 'eliminated', 'corroborated', 'out-of-scope'];

function hyp(types: Array<'supports' | 'refutes' | 'neutral'>): Hypothesis {
  return {
    id: 'h', parentId: null, sessionId: 's', depth: 0, title: 'h', status: 'exploring',
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

describe('nodeLabel', () => {
  it('renders the authored title', () => {
    expect(nodeLabel({ title: 'Writer pool exhaustion' })).toBe('Writer pool exhaustion');
  });

  it('falls back to a label derived from the statement when the title is blank', () => {
    // A corrupt or partially-written payload should still render identifiably.
    expect(nodeLabel({ title: '', statement: 'The pool exhausts. Details follow.' }))
      .toBe('The pool exhausts');
  });

  it('falls back to a placeholder when there is no text at all', () => {
    expect(nodeLabel({ title: '' })).toBe('(untitled)');
    expect(nodeLabel({ title: '', statement: '   ' })).toBe('(untitled)');
  });
});

describe('splitProse', () => {
  it('returns only a title when the prose is already label-length', () => {
    expect(splitProse('Writer pool exhaustion')).toEqual({ title: 'Writer pool exhaustion' });
  });

  it('keeps the full prose as the statement when the label is shorter', () => {
    const prose = 'The pool exhausts. Every retry allocates a fresh writer and never returns it.';
    expect(splitProse(prose)).toEqual({ title: 'The pool exhausts', statement: prose });
  });

  it('trims but does not otherwise alter a retained statement', () => {
    expect(splitProse('  Writer pool exhaustion  ')).toEqual({ title: 'Writer pool exhaustion' });
  });

  it('produces a title within the length bound for any prose', () => {
    const { title } = splitProse('word '.repeat(200));
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });
});

describe('deriveTitle projects prose onto a label that is always usable', () => {
  // Every node the canvas draws shows this label and nothing else, and the
  // engine persists it, so a projection that yields a fragment or nothing at all
  // leaves a node no reader can identify.

  const PROSE = [
    'Writer pool exhausts under retry storms',
    '1. Dashboard freezes when many nodes are added',
    'Step 1. Investigate the writer pool',
    'v1. Deploy fails on the second attempt',
    '2026-08-19. Deploys fail after the rollout',
    'Q. Why does the build hang?',
    '. Leading punctuation and then a real sentence',
    'e.g. the planner picks a sequential scan',
    'Disk full. Writes fail downstream.',
    'The writer pool is exhausted. Callers block in getConnection.',
    'Cache stampede on price lookups; reads pile up behind it',
    'A single-word problem',
    'x',
    'A'.repeat(400),
  ];

  it('never yields a label the engine would reject', () => {
    for (const prose of PROSE) {
      const title = deriveTitle(prose);
      expect(titleProblem(title), `deriveTitle(${JSON.stringify(prose)}) = ${JSON.stringify(title)}`).toBeNull();
    }
  });

  it('does not mistake an enumerator, a version, or a date for a whole clause', () => {
    // '1. Dashboard freezes...' is one sentence with a list marker, not a clause
    // followed by another; keeping only the marker discards the entire claim.
    expect(deriveTitle('1. Dashboard freezes when many nodes are added')).toContain('Dashboard freezes');
    expect(deriveTitle('Step 1. Investigate the writer pool')).toContain('Investigate');
    expect(deriveTitle('v1. Deploy fails on the second attempt')).toContain('Deploy fails');
    expect(deriveTitle('2026-08-19. Deploys fail after the rollout')).toContain('Deploys fail');
    expect(deriveTitle('Q. Why does the build hang?')).toContain('build hang');
  });

  it('still keeps the first clause when it is a clause', () => {
    expect(deriveTitle('The writer pool is exhausted. Callers block in getConnection.'))
      .toBe('The writer pool is exhausted');
    expect(deriveTitle('Disk full. Writes fail downstream.')).toBe('Disk full');
  });
});

describe('deriveTitle', () => {
  // A short label is authored going forward, but a hypothesis recorded as one
  // long prose field still has to render on a canvas. deriveTitle projects such
  // prose to a label at read time; it never rewrites the stored text.

  it('returns a already-short claim unchanged', () => {
    expect(deriveTitle('Writer pool exhausts under retry storms'))
      .toBe('Writer pool exhausts under retry storms');
  });

  it('drops a trailing sentence period so labels read as noun phrases', () => {
    expect(deriveTitle('Writer pool exhausts.')).toBe('Writer pool exhausts');
    // Ellipsis and other terminators are not sentence periods to strip.
    expect(deriveTitle('Is the pool exhausted?')).toBe('Is the pool exhausted?');
  });

  it('keeps only the first sentence of multi-sentence prose', () => {
    expect(deriveTitle('The pool exhausts. This happens because every retry allocates a fresh writer.'))
      .toBe('The pool exhausts');
  });

  it('cuts at the first clause boundary, so a trailing elaboration is dropped', () => {
    expect(deriveTitle('Writer pool exhausts under retry storms; callers block in getConnection.'))
      .toBe('Writer pool exhausts under retry storms');
    expect(deriveTitle('Pool exhausts — every retry allocates a fresh writer'))
      .toBe('Pool exhausts');
    expect(deriveTitle('Pool exhausts - every retry allocates a fresh writer'))
      .toBe('Pool exhausts');
  });

  it('does not treat a comma as a clause boundary, so enumerations survive', () => {
    // Splitting on commas would reduce a list of alternatives to its first item,
    // which is exactly the meaning a label needs to keep.
    expect(deriveTitle('Network, disk, or CPU contention'))
      .toBe('Network, disk, or CPU contention');
  });

  it('does not split a hyphenated word or a decimal', () => {
    expect(deriveTitle('Write-ahead log grows without bound')).toBe('Write-ahead log grows without bound');
    expect(deriveTitle('Latency exceeds 1.5 seconds under load')).toBe('Latency exceeds 1.5 seconds under load');
  });

  it('truncates an over-long single sentence at a word boundary with an ellipsis', () => {
    const prose = 'The connection pool becomes exhausted whenever the upstream service begins '
      + 'returning retryable errors at a rate the client cannot absorb';
    const title = deriveTitle(prose);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(true);
    // Cut on whitespace, never mid-word.
    expect(prose.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('never exceeds TITLE_MAX_LENGTH for any input', () => {
    for (const s of ['x'.repeat(500), 'word '.repeat(200), 'a. '.repeat(100)]) {
      expect(deriveTitle(s).length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    }
  });

  it('truncates a single unbroken token that has no word boundary', () => {
    const title = deriveTitle('x'.repeat(500));
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('returns an empty string for blank input rather than throwing', () => {
    expect(deriveTitle('')).toBe('');
    expect(deriveTitle('   \n\t ')).toBe('');
  });

  it('collapses interior whitespace so a label never renders as multiple lines', () => {
    expect(deriveTitle('Writer   pool\n\texhausts')).toBe('Writer pool exhausts');
  });

  it('is idempotent — deriving from an already-derived title is a no-op', () => {
    for (const s of ['Short claim', 'x'.repeat(500), 'One. Two. Three.', 'word '.repeat(200)]) {
      const once = deriveTitle(s);
      expect(deriveTitle(once)).toBe(once);
    }
  });
});

describe('readsAsClause', () => {
  // The tools ask for a noun phrase because the label is the only text the canvas
  // renders. Whether a phrase is a noun phrase is a claim about what it means, so
  // this reports only what it can see: a closed-class copula or auxiliary standing
  // as its own word, or a sentence break inside the label. Both mark a clause.

  it('accepts the noun phrases the tools ask for', () => {
    for (const label of [
      'Writer pool exhaustion',
      'Source query returns nothing',
      'Index bloat under nightly load',
      'Third-party payment latency',
      'Writer starvation and index bloat',
      'Cache miss storm',
      'Deploy config drift',
      'Other cause not listed',
    ]) {
      expect(readsAsClause(label), label).toBe(false);
    }
  });

  it('flags a label that carries a finite clause', () => {
    for (const label of [
      'The writer pool was exhausted overnight',
      'The source query is returning no rows',
      'Latency has doubled since the deploy',
      'The transform will drop every row',
      'Nothing here can explain the gap',
    ]) {
      expect(readsAsClause(label), label).toBe(true);
    }
  });

  it('flags a label holding more than one sentence', () => {
    expect(readsAsClause('Writer pool exhaustion. Queue filled first')).toBe(true);
    expect(readsAsClause('Why did it fail? Nobody checked')).toBe(true);
  });

  it('does not flag a word that merely contains an auxiliary', () => {
    // Substring matching would read "Disk" as "is" and "Cannibalized" as "can".
    for (const label of ['Disk saturation', 'Cannibalized cache entries', 'Bewildering index plan', 'Hasty rollout']) {
      expect(readsAsClause(label), label).toBe(false);
    }
  });

  it('says nothing about an empty or blank label, which titleProblem already refuses', () => {
    expect(readsAsClause('')).toBe(false);
    expect(readsAsClause('   ')).toBe(false);
  });
});
