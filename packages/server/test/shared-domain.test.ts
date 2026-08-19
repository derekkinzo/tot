import { describe, it, expect } from 'vitest';
import {
  isPruned, isLive, isTerminal, isOpen,
  countSupporting, countRefuting,
  deriveTitle, TITLE_MAX_LENGTH,
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
