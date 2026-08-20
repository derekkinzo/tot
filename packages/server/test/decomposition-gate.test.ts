import { describe, it, expect } from 'vitest';
import {
  gateLabel, gateMeaning, gateFindings, GATES,
  type DecompositionGate, type Hypothesis, type HypothesisStatus,
} from '@tot-mcp/shared';

const ts = '2024-01-01T00:00:00.000Z';

function node(id: string, status: HypothesisStatus, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id, parentId: 'p', sessionId: 's', depth: 1, title: id, status,
    evidence: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [], ...over,
  };
}
function parent(gate: DecompositionGate | undefined, childIds: string[]): Hypothesis {
  return node('p', 'exploring', {
    parentId: null, depth: 0, children: childIds,
    ...(gate === undefined ? {} : { decomposition: { axis: 'by subsystem', gate } }),
  });
}

describe('gate vocabulary', () => {
  it('names every gate, so a renderer never has to invent a label', () => {
    for (const gate of GATES) {
      expect(gateLabel(gate)).toMatch(/\S/);
      expect(gateMeaning(gate)).toMatch(/\S/);
    }
  });

  it('states what each gate claims about the children', () => {
    // The label is what a reader sees; the meaning is what they can act on.
    expect(gateMeaning('one-of')).toMatch(/exactly one|at most one|only one/i);
    expect(gateMeaning('any-of')).toMatch(/one or more|at least one|more than one/i);
    expect(gateMeaning('all-of')).toMatch(/every|all|each/i);
  });
});

describe('gateFindings', () => {
  // A gate is the agent's declaration about how the children relate. It is never
  // a verdict, so what is reported is the conflict between that declaration and
  // the verdicts actually recorded — never a claim that a decomposition is MECE.

  it('reports nothing when no gate was declared', () => {
    const children = [node('a', 'corroborated'), node('b', 'corroborated')];
    expect(gateFindings(parent(undefined, ['a', 'b']), children)).toEqual([]);
  });

  it('reports two survivors under a one-of gate, which cannot both hold', () => {
    const children = [node('a', 'corroborated'), node('b', 'corroborated')];
    const findings = gateFindings(parent('one-of', ['a', 'b']), children);
    expect(findings.map((f) => f.kind)).toEqual(['rival-survivors']);
    expect(findings[0].nodeIds).toEqual(['a', 'b']);
  });

  it('accepts a single survivor under a one-of gate', () => {
    const children = [node('a', 'corroborated'), node('b', 'eliminated')];
    expect(gateFindings(parent('one-of', ['a', 'b']), children)).toEqual([]);
  });

  it('does not report two survivors under any-of, where several may hold together', () => {
    // Several contributing causes are first-class (Mackie's INUS conditions), so
    // this is only a conflict when the agent declared the children exclusive.
    const children = [node('a', 'corroborated'), node('b', 'corroborated')];
    expect(gateFindings(parent('any-of', ['a', 'b']), children)).toEqual([]);
  });

  it('reports an eliminated part under an all-of gate, which defeats the parent', () => {
    const children = [node('a', 'eliminated'), node('b', 'corroborated')];
    const findings = gateFindings(parent('all-of', ['a', 'b']), children);
    expect(findings.map((f) => f.kind)).toEqual(['required-part-defeated']);
    expect(findings[0].nodeIds).toEqual(['a']);
  });

  it('separates a part set aside from a part refuted under an all-of gate', () => {
    // Setting a branch aside records a choice not to investigate it. Reporting
    // that as a defeated part would assert a refutation from a branch nobody
    // tested — the parent is not refuted, it is unestablished.
    const findings = gateFindings(parent('all-of', ['a', 'b']), [node('a', 'out-of-scope'), node('b', 'corroborated')]);
    expect(findings.map((f) => f.kind)).toEqual(['required-part-untested']);
    expect(findings[0].nodeIds).toEqual(['a']);
    expect(findings[0].message).not.toMatch(/cannot hold|no longer stands|refut/i);
  });

  it('reports a refuted part and a part set aside on their own terms', () => {
    const findings = gateFindings(
      parent('all-of', ['a', 'b', 'c']),
      [node('a', 'eliminated'), node('b', 'out-of-scope'), node('c', 'corroborated')],
    );
    expect(findings.map((f) => f.kind).sort())
      .toEqual(['required-part-defeated', 'required-part-untested']);
    expect(findings.find((f) => f.kind === 'required-part-defeated')!.nodeIds).toEqual(['a']);
    expect(findings.find((f) => f.kind === 'required-part-untested')!.nodeIds).toEqual(['b']);
  });

  it('reports every alternative ruled out under a one-of or any-of gate', () => {
    for (const gate of ['one-of', 'any-of'] as const) {
      const children = [node('a', 'eliminated'), node('b', 'eliminated')];
      const findings = gateFindings(parent(gate, ['a', 'b']), children);
      expect(findings.map((f) => f.kind)).toEqual(['alternatives-exhausted']);
      expect(findings[0].nodeIds).toEqual(['a', 'b']);
    }
  });

  it('does not say alternatives were ruled out when they were only set aside', () => {
    // 'Every alternative has been ruled out ... the claim itself is refuted'
    // asserts an elimination that never happened. Nothing was tested here.
    for (const gate of ['one-of', 'any-of'] as const) {
      const children = [node('a', 'out-of-scope'), node('b', 'out-of-scope')];
      const findings = gateFindings(parent(gate, ['a', 'b']), children);
      expect(findings.map((f) => f.kind)).toEqual(['alternatives-abandoned']);
      // The message has to say what did happen (branches set aside) and deny what
      // did not (any refutation of the claim above).
      expect(findings[0].message).toMatch(/set aside|not investigat|untested/i);
      expect(findings[0].message).toMatch(/nothing here refutes/i);
      expect(findings[0].message).not.toMatch(/claim itself is refuted|has been ruled out/i);
    }
  });

  it('does not claim exhaustion when only some alternatives were ruled out', () => {
    // A mixed close is not an elimination of the space: one branch was refuted,
    // the other was never tested.
    const children = [node('a', 'eliminated'), node('b', 'out-of-scope')];
    const findings = gateFindings(parent('any-of', ['a', 'b']), children);
    expect(findings.map((f) => f.kind)).toEqual(['alternatives-abandoned']);
    expect(findings[0].message).toMatch(/set aside|not investigat|untested/i);
  });

  it('does not report exhausted alternatives while one is still open', () => {
    const children = [node('a', 'eliminated'), node('b', 'exploring')];
    expect(gateFindings(parent('any-of', ['a', 'b']), children)).toEqual([]);
  });

  it('does not report an all-of gate whose parts are all still standing', () => {
    const children = [node('a', 'corroborated'), node('b', 'exploring')];
    expect(gateFindings(parent('all-of', ['a', 'b']), children)).toEqual([]);
  });

  it('reports nothing for a node with no children', () => {
    expect(gateFindings(parent('one-of', []), [])).toEqual([]);
  });

  it('ignores children the caller did not supply rather than assuming their status', () => {
    // A lazily loaded view may hold only part of a session; a missing child is
    // unknown, not eliminated, so no finding may rest on it.
    const findings = gateFindings(parent('one-of', ['a', 'b']), [node('a', 'eliminated')]);
    expect(findings).toEqual([]);
  });

  it('carries a message that names the conflict, so a caller renders no rules of its own', () => {
    const findings = gateFindings(parent('all-of', ['a']), [node('a', 'eliminated')]);
    expect(findings[0].message).toMatch(/\S/);
  });
});
