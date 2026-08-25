import { describe, it, expect } from 'vitest';
import {
  applyEntry, deriveScanStatus, emptyReplayState, isFromNewerWriter,
  JOURNAL_SCHEMA_VERSION, type JournalEntry,
} from '../src/replay.js';
import type { Hypothesis, Session } from '../src/types.js';
import { deriveTitle } from '@tot-mcp/shared';

const ts = '2024-01-01T00:00:00.000Z';

function session(over: Partial<Session> = {}): Session {
  return { id: 's', problem: 'p', rootNodeId: 'root', status: 'open', createdAt: ts, ...over };
}
function hyp(id: string, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id, parentId: null, sessionId: 's', depth: 0, title: id, status: 'exploring',
    evidence: [], metadata: { createdAt: ts, updatedAt: ts, source: 'agent' }, children: [], ...over,
  };
}
const entry = (type: string, payload: unknown): JournalEntry => ({ timestamp: ts, type, payload });

function fold(...entries: JournalEntry[]) {
  const state = emptyReplayState();
  for (const e of entries) applyEntry(state, e);
  return state;
}

describe('legacy payloads are projected onto the declared unions', () => {
  // Every predicate in the engine switches on these values. A value outside the
  // union makes each one false, so a node is neither terminal, nor pruned, nor
  // open — it simply stops participating in closure, silently.

  it('translates a pre-corroboration hypothesis status', () => {
    const s = fold(entry('hypothesis-added', { ...hyp('h1'), status: 'confirmed' }));
    expect(s.hypotheses[0].status).toBe('corroborated');
  });

  it('lands an unrecognised hypothesis status on a live, undecided value', () => {
    // Guessing a verdict would assert one nobody recorded; 'exploring' claims
    // nothing and keeps the node inside closure rather than invisible to it.
    const s = fold(entry('hypothesis-added', { ...hyp('h1'), status: 'quantum' }));
    expect(['pending', 'exploring']).toContain(s.hypotheses[0].status);
  });

  it('translates the verdict a legacy conclusion carries, not only the status', () => {
    // status and conclusion.verdict share one vocabulary and are compared against
    // each other to decide whether a verdict was superseded. Translating one and
    // not the other makes every legacy terminal node read as reopened.
    const s = fold(entry('hypothesis-added', {
      ...hyp('h1'),
      status: 'confirmed',
      conclusion: { verdict: 'confirmed', reason: 'survived', timestamp: ts },
    }));
    expect(s.hypotheses[0].status).toBe('corroborated');
    expect(s.hypotheses[0].conclusion?.verdict).toBe('corroborated');
  });

  it('does not let an inherited object key pass for a known status', () => {
    // A persisted value is arbitrary text. Looking it up in a plain object means
    // 'toString' or 'constructor' resolves to an inherited member, so the fallback
    // never fires and a function lands in a field every reader switches on.
    for (const hostile of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const s = fold(entry('hypothesis-added', { ...hyp('h1'), status: hostile }));
      expect(typeof s.hypotheses[0].status, `status ${hostile}`).toBe('string');
      expect(['pending', 'exploring'], `status ${hostile}`).toContain(s.hypotheses[0].status);
      const t = fold(entry('session-created', { ...session(), status: hostile }));
      expect(['open', 'resolved', 'abandoned'], `session ${hostile}`).toContain(t.sessions[0].status);
    }
  });

  it('translates a legacy session status', () => {
    const s = fold(entry('session-created', { ...session(), status: 'active' }));
    expect(s.sessions[0].status).toBe('open');
  });

  it('never leaves a session status outside its union', () => {
    for (const status of ['active', 'complete', 'done', undefined, null, 42]) {
      const s = fold(entry('session-created', { ...session(), status }));
      expect(['open', 'resolved', 'abandoned'], `status ${String(status)}`)
        .toContain(s.sessions[0].status);
    }
  });

  it('never leaves a completed session without a status', () => {
    // The codebase's own comment says a journal can carry a completion with no
    // terminalStatus; assigning it unconditionally writes undefined into a field
    // every reader switches on.
    const s = fold(
      entry('session-created', session()),
      entry('session-completed', { sessionId: 's' }),
    );
    expect(['open', 'resolved', 'abandoned']).toContain(s.sessions[0].status);
    expect(s.sessions[0].status).not.toBe('open');
  });

  it('keeps an explicit terminal status as written', () => {
    const s = fold(
      entry('session-created', session()),
      entry('session-completed', { sessionId: 's', terminalStatus: 'resolved' }),
    );
    expect(s.sessions[0].status).toBe('resolved');
  });
});

describe('a terminal status this build cannot read falls through to the spine', () => {
  // The fold onto the declared union must not be mistaken for knowledge. A value
  // this build does not recognise carries no verdict, so the closure walk decides
  // — reporting 'abandoned' would assert that nothing survived when a corroborated
  // hypothesis may sit on a live lineage.

  const journalOf = (terminalStatus) => [
    entry('session-created', session()),
    entry('hypothesis-added', hyp('root', { status: 'corroborated' })),
    ...(terminalStatus === undefined
      ? [entry('session-completed', { sessionId: 's' })]
      : [entry('session-completed', { sessionId: 's', terminalStatus })]),
  ];

  it('does not treat an unrecognised terminal status as authoritative', () => {
    const state = fold(...journalOf('closed'));
    expect(state.sawExplicitTerminal).toBe(false);
    expect(deriveScanStatus(state.sessions[0], state.hypotheses, state.sawExplicitTerminal))
      .toBe('resolved');
  });

  it('does not treat an absent terminal status as authoritative', () => {
    const state = fold(...journalOf(undefined));
    expect(state.sawExplicitTerminal).toBe(false);
    expect(deriveScanStatus(state.sessions[0], state.hypotheses, state.sawExplicitTerminal))
      .toBe('resolved');
  });

  it('trusts a terminal status it does recognise', () => {
    for (const [written, expected] of [['resolved', 'resolved'], ['abandoned', 'abandoned'], ['complete', 'resolved']]) {
      const state = fold(...journalOf(written));
      expect(state.sawExplicitTerminal, `written ${written}`).toBe(true);
      expect(deriveScanStatus(state.sessions[0], state.hypotheses, state.sawExplicitTerminal), `written ${written}`)
        .toBe(expected);
    }
  });
});

describe('a journal written by a newer build', () => {
  // Folding one silently would leave a reader believing it had the whole tree
  // when fields this build does not know about were dropped on the way in.

  const newer = (type: string, payload: unknown): JournalEntry =>
    ({ timestamp: ts, type, payload, v: JOURNAL_SCHEMA_VERSION + 1 });

  it('is recognised by its stamped version', () => {
    expect(isFromNewerWriter(newer('session-created', session()))).toBe(true);
    expect(isFromNewerWriter(entry('session-created', session()))).toBe(false);
    // An entry with no version predates versioning, so it is older, never newer.
    expect(isFromNewerWriter({ timestamp: ts, type: 'x', payload: {} })).toBe(false);
  });

  it('is recorded on the folded state, so a reader can say so', () => {
    const state = fold(newer('session-created', session()));
    expect(state.sawNewerWriter).toBe(true);
  });

  it('leaves the flag clear for a journal this build could have written', () => {
    const state = fold(entry('session-created', session()), entry('hypothesis-added', hyp('root')));
    expect(state.sawNewerWriter).toBe(false);
  });

  it('is still folded, because reporting is not refusing', () => {
    const state = fold(newer('session-created', session()), newer('hypothesis-added', hyp('root')));
    expect(state.sessions).toHaveLength(1);
    expect(state.hypotheses).toHaveLength(1);
  });
});

describe('evidence folded through the legacy event', () => {
  // journalEventToEntry does not write evidence-added — the hypothesis-updated
  // snapshot carries the evidence — but a hand-authored or legacy journal can,
  // and that path has to land a record the contract accepts.

  const legacyRecord = {
    id: 'e1', type: 'supports', content: 'the traces show it',
    timestamp: ts,
  };

  it('defaults the record kind the same way a snapshot would', () => {
    const state = fold(
      entry('hypothesis-added', hyp('h1')),
      entry('evidence-added', { hypothesisId: 'h1', evidence: legacyRecord }),
    );
    // 'artifact' is claimed only by a record that carries captured bytes.
    expect(state.hypotheses[0].evidence[0].kind).toBe('transcription');
  });

  it('defaults it the same way when the evidence arrives before its node', () => {
    const state = fold(
      entry('evidence-added', { hypothesisId: 'h1', evidence: legacyRecord }),
      entry('hypothesis-added', hyp('h1')),
    );
    expect(state.hypotheses[0].evidence[0].kind).toBe('transcription');
  });

  it('calls a record carrying captured bytes verbatim, whatever it was labelled', () => {
    // kind and artifact are one fact stated twice. A reader that trusts the label
    // would show 'paraphrase' beside a capture it can open, so the label is
    // derived from the bytes rather than taken on faith.
    const state = fold(
      entry('hypothesis-added', hyp('h1')),
      entry('evidence-added', {
        hypothesisId: 'h1',
        evidence: { ...legacyRecord, kind: 'transcription', artifact: { id: 'a1' } },
      }),
    );
    expect(state.hypotheses[0].evidence[0].kind).toBe('artifact');
  });

  it('calls a record with no captured bytes a paraphrase, whatever it was labelled', () => {
    const state = fold(
      entry('hypothesis-added', hyp('h1')),
      entry('evidence-added', {
        hypothesisId: 'h1',
        evidence: { ...legacyRecord, kind: 'artifact' },
      }),
    );
    expect(state.hypotheses[0].evidence[0].kind).toBe('transcription');
  });

  it('keeps a kind the record already declares', () => {
    const state = fold(
      entry('hypothesis-added', hyp('h1')),
      entry('evidence-added', {
        hypothesisId: 'h1',
        evidence: { ...legacyRecord, kind: 'artifact', artifact: { id: 'a1' } },
      }),
    );
    expect(state.hypotheses[0].evidence[0].kind).toBe('artifact');
  });
});

describe('applyEntry payload normalization', () => {
  // Field defaulting keys on each field's own absence, never on the entry's
  // schema version: independently-shipped writers all stamp the current version
  // while omitting fields added later, so a version-keyed branch would not fire.

  /** A pre-title journal payload, hand-authored so it cannot inherit v2 defaults. */
  const legacyPayload = {
    id: 'h1',
    parentId: null,
    sessionId: 's1',
    depth: 0,
    content: 'Writer pool exhausts under retry storms; callers block in getConnection.',
    score: 0.8,
    scoreRationale: 'gut feel',
    status: 'exploring',
    evidence: [],
    metadata: { createdAt: ts, updatedAt: ts, source: 'agent' },
    children: [],
  };

  it('derives a title and keeps the prose as the statement', () => {
    expect('title' in legacyPayload).toBe(false); // guards against re-blinding the fixture
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: legacyPayload } as JournalEntry);
    const h = s.hypotheses[0];
    expect(h.title).toBe(deriveTitle(legacyPayload.content));
    expect(h.statement).toBe(legacyPayload.content);
  });

  it('does not invent a statement for a node whose prose was only its title', () => {
    // The projection writes one prose field, taken from the statement when there
    // was one and from the title otherwise. Adopting it back as a statement
    // whenever it is present resurrects a field the author left out — every
    // title-only node returns from the journal with its label duplicated.
    const titleOnly = {
      ...legacyPayload,
      title: 'Writer pool exhaustion',
      content: 'Writer pool exhaustion',
    };
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: titleOnly } as JournalEntry);
    const h = s.hypotheses[0];
    expect(h.title).toBe('Writer pool exhaustion');
    expect(h.statement).toBeUndefined();
  });

  it('keeps a statement that says more than the title', () => {
    const both = {
      ...legacyPayload,
      title: 'Writer pool exhaustion',
      content: 'Callers block in getConnection once the pool is saturated by retries.',
    };
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: both } as JournalEntry);
    expect(s.hypotheses[0].statement).toBe(both.content);
  });

  it('strips fields that are no longer part of the contract', () => {
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: legacyPayload } as JournalEntry);
    const h = s.hypotheses[0] as unknown as Record<string, unknown>;
    // Left in place, these would be re-journaled into every future snapshot.
    expect('content' in h).toBe(false);
    expect('score' in h).toBe(false);
    expect('scoreRationale' in h).toBe(false);
  });

  it('preserves optional fields the contract still carries', () => {
    const withConclusion = {
      ...legacyPayload,
      status: 'eliminated',
      conclusion: {
        verdict: 'eliminated', reason: 'r', timestamp: ts,
        refutingEvidenceIds: ['e1'], supersededBy: 'self',
      },
    };
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: withConclusion } as JournalEntry);
    expect(s.hypotheses[0].conclusion?.refutingEvidenceIds).toEqual(['e1']);
    expect(s.hypotheses[0].conclusion?.supersededBy).toBe('self');
  });

  it('normalizes an update payload too, so a mixed-version file folds consistently', () => {
    // A file spanning an upgrade holds a pre-title add followed by a current
    // update for the same id; the update replaces the node wholesale.
    const s = fold(
      { timestamp: ts, type: 'hypothesis-added', payload: legacyPayload } as JournalEntry,
      { timestamp: ts, type: 'hypothesis-updated', payload: { ...legacyPayload, status: 'corroborated' } } as JournalEntry,
    );
    expect(s.hypotheses).toHaveLength(1);
    expect(s.hypotheses[0].status).toBe('corroborated');
    expect(s.hypotheses[0].title).toBe(deriveTitle(legacyPayload.content));
    expect(s.hypotheses[0].statement).toBe(legacyPayload.content);
  });

  it('folds a parent written before splits were recorded, leaving it with none', () => {
    // A tree from an earlier writer carries no axis or relation. Inventing one
    // would put a declaration in the record that nobody made.
    const parent = { ...legacyPayload, children: ['h2'] };
    expect('decomposition' in parent).toBe(false); // guards against re-blinding the fixture
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: parent } as JournalEntry);
    expect(s.hypotheses[0].decomposition).toBeUndefined();
  });

  it('preserves a recorded split, so an axis survives a restart', () => {
    const parent = {
      ...legacyPayload,
      children: ['h2', 'h3'],
      decomposition: { axis: 'by subsystem', gate: 'one-of' },
    };
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: parent } as JournalEntry);
    expect(s.hypotheses[0].decomposition).toEqual({ axis: 'by subsystem', gate: 'one-of' });
  });

  it('leaves an authored title untouched rather than re-deriving it', () => {
    const authored = { ...legacyPayload, title: 'Writer pool exhaustion', content: undefined, statement: 'The long form.' };
    delete (authored as Record<string, unknown>).content;
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: authored } as JournalEntry);
    expect(s.hypotheses[0].title).toBe('Writer pool exhaustion');
    expect(s.hypotheses[0].statement).toBe('The long form.');
  });
});

describe('applyEntry (shared event interpreter)', () => {
  it('reconstructs a session + hypotheses in order', () => {
    const s = fold(
      entry('session-created', session()),
      entry('hypothesis-added', hyp('root', { children: ['a'] })),
      entry('hypothesis-added', hyp('a', { parentId: 'root' })),
    );
    expect(s.sessions).toHaveLength(1);
    expect(s.hypotheses.map((h) => h.id)).toEqual(['root', 'a']);
  });

  it('hypothesis-updated replaces the existing node (no duplicate)', () => {
    const s = fold(
      entry('hypothesis-added', hyp('a', { status: 'exploring' })),
      entry('hypothesis-updated', hyp('a', { status: 'corroborated' })),
    );
    expect(s.hypotheses).toHaveLength(1);
    expect(s.hypotheses[0].status).toBe('corroborated');
  });

  it('replays an entry that carries an explicit schema version', () => {
    // Forward-compat: entries may carry a version field. The current schema
    // replays as today; the field exists so a future format change has a branch
    // point rather than an ambiguous bare type.
    const s = fold({ timestamp: ts, type: 'hypothesis-added', payload: hyp('a'), v: 1 } as JournalEntry);
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a']);
  });

  it('replays a legacy entry with no version field (treated as v1)', () => {
    const s = fold(entry('hypothesis-added', hyp('a')));
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a']);
  });

  it('is order-tolerant: an update for a node with no prior add still lands it (total replay over a truncated log)', () => {
    // The writer never emits this order; the branch makes replay total over a
    // log whose hypothesis-added line was dropped/truncated.
    const s = fold(entry('hypothesis-updated', hyp('a', { status: 'eliminated' })));
    expect(s.hypotheses).toHaveLength(1);
    expect(s.hypotheses[0].status).toBe('eliminated');
  });

  it('replays a legacy evidence-added entry exactly once onto its hypothesis', () => {
    const ev = { id: 'e1', type: 'supports' as const, content: 'x', timestamp: ts };
    const s = fold(
      entry('hypothesis-added', hyp('a')),
      entry('evidence-added', { hypothesisId: 'a', evidence: ev }),
    );
    expect(s.hypotheses[0].evidence).toEqual([{ ...ev, kind: 'transcription' }]);
  });

  it('does not lose an evidence-added that precedes its hypothesis (order-tolerant)', () => {
    // The replay contract is order-tolerant for hypothesis events; evidence must
    // be too. A legacy/hand-authored journal can order evidence-added before the
    // hypothesis-added that creates its target. The evidence must land once the
    // hypothesis appears, not be silently dropped.
    const ev = { id: 'e1', type: 'refutes' as const, content: 'counter', timestamp: ts };
    const s = fold(
      entry('evidence-added', { hypothesisId: 'a', evidence: ev }),
      entry('hypothesis-added', hyp('a')),
    );
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a']);
    expect(s.hypotheses[0].evidence).toEqual([{ ...ev, kind: 'transcription' }]);
  });

  it('merges buffered out-of-order evidence ahead of evidence carried on the later snapshot', () => {
    // If the hypothesis-added/updated snapshot itself already carries evidence,
    // the buffered earlier evidence is appended without dropping the snapshot's.
    const early = { id: 'e1', type: 'refutes' as const, content: 'early', timestamp: ts };
    const carried = { id: 'e2', type: 'supports' as const, content: 'carried', timestamp: ts };
    const s = fold(
      entry('evidence-added', { hypothesisId: 'a', evidence: early }),
      entry('hypothesis-added', hyp('a', { evidence: [carried] })),
    );
    const ids = s.hypotheses[0].evidence.map((e) => e.id).sort();
    expect(ids).toEqual(['e1', 'e2']);
  });

  it('keeps hypothesisIndex consistent with the array across interleaved adds/updates', () => {
    const s = fold(
      entry('hypothesis-added', hyp('a')),
      entry('hypothesis-added', hyp('b')),
      entry('hypothesis-updated', hyp('a', { status: 'corroborated' })),
      entry('hypothesis-added', hyp('c')),
      entry('hypothesis-updated', hyp('c', { status: 'eliminated' })),
    );
    expect(s.hypotheses.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    // Every index entry resolves to the matching node — the O(1) lookup is sound.
    for (const [id, idx] of s.hypothesisIndex) {
      expect(s.hypotheses[idx].id).toBe(id);
    }
    expect(s.hypotheses[s.hypothesisIndex.get('a')!].status).toBe('corroborated');
    expect(s.hypotheses[s.hypothesisIndex.get('c')!].status).toBe('eliminated');
  });

  it('resolves update/evidence in O(1) — applyEntry performs no linear array scan', () => {
    // Guard the algorithmic invariant (not wall-clock): the reducer must not
    // reintroduce findIndex/find over the hypotheses array.
    const src = applyEntry.toString();
    expect(src).not.toMatch(/\.findIndex\(/);
    expect(src).not.toMatch(/hypotheses\.find\(/);
  });

  it('replays a worst-case full-tree journal to the correct final state at scale', () => {
    // The tree is bounded (MAX_HYPOTHESES_DEFAULT = 500). A heavily-worked tree
    // at the cap with 20 updates each is ~10.5k journal lines; replay must fold
    // them to one node per id with the last-written content winning, no
    // duplication. Correctness-at-scale, not wall-clock: the O(1) upsert
    // invariant is asserted structurally by the sibling 'no linear array scan'
    // test, so this one guards the folded result rather than timing it.
    const entries: JournalEntry[] = [entry('session-created', session())];
    const N = 500, UPDATES = 20;
    for (let i = 0; i < N; i++) {
      entries.push(entry('hypothesis-added', hyp(`h${i}`, { parentId: i === 0 ? null : 'h0' })));
      for (let u = 0; u < UPDATES; u++) {
        entries.push(entry('hypothesis-updated', hyp(`h${i}`, {
          status: 'exploring',
          evidence: Array.from({ length: u + 1 }, (_, k) => ({ id: `e${i}_${k}`, type: 'supports' as const, content: 'x', timestamp: ts })),
        })));
      }
    }
    const state = emptyReplayState();
    for (const e of entries) applyEntry(state, e);
    // Exactly one node per id (upsert, not append), index consistent, and the
    // last update's evidence count (UPDATES items) won.
    expect(state.hypotheses).toHaveLength(N);
    expect(state.hypothesisIndex.size).toBe(N);
    for (const [id, idx] of state.hypothesisIndex) expect(state.hypotheses[idx].id).toBe(id);
    expect(state.hypotheses[state.hypothesisIndex.get('h0')!].evidence).toHaveLength(UPDATES);
  });

  it('session-completed sets terminal status + completedAt; session-reopened reverts', () => {
    const completed = fold(
      entry('session-created', session()),
      entry('session-completed', { sessionId: 's', terminalStatus: 'resolved' }),
    );
    expect(completed.sessions[0].status).toBe('resolved');
    expect(completed.sessions[0].completedAt).toBe(ts);

    const reopened = fold(
      entry('session-created', session()),
      entry('session-completed', { sessionId: 's', terminalStatus: 'resolved' }),
      entry('session-reopened', { sessionId: 's' }),
    );
    expect(reopened.sessions[0].status).toBe('open');
    expect(reopened.sessions[0].completedAt).toBeUndefined();
  });
});

describe('deriveScanStatus (scan projection)', () => {
  it('returns open for a still-open session', () => {
    expect(deriveScanStatus(session({ status: 'open' }), [], false)).toBe('open');
  });

  it('trusts the explicit terminalStatus when one was seen on the wire', () => {
    expect(deriveScanStatus(session({ status: 'resolved' }), [], true)).toBe('resolved');
    expect(deriveScanStatus(session({ status: 'abandoned' }), [], true)).toBe('abandoned');
  });

  it('without an explicit terminalStatus, derives resolved when a corroborated node survives on a non-pruned lineage', () => {
    const hyps = [
      hyp('root', { children: ['a'], status: 'exploring' }),
      hyp('a', { parentId: 'root', status: 'corroborated' }),
    ];
    // session marked terminal (status != open) but no explicit terminalStatus seen.
    expect(deriveScanStatus(session({ status: 'resolved' }), hyps, false)).toBe('resolved');
  });

  it('without an explicit terminalStatus, derives abandoned when no corroborated node survives', () => {
    const hyps = [
      hyp('root', { children: ['a'], status: 'exploring' }),
      hyp('a', { parentId: 'root', status: 'eliminated' }),
    ];
    expect(deriveScanStatus(session({ status: 'abandoned' }), hyps, false)).toBe('abandoned');
  });

  it('a corroborated node buried under a pruned ancestor does NOT count as survival', () => {
    const hyps = [
      hyp('root', { children: ['a'], status: 'exploring' }),
      hyp('a', { parentId: 'root', status: 'out-of-scope', children: ['b'] }),
      hyp('b', { parentId: 'a', status: 'corroborated' }),
    ];
    expect(deriveScanStatus(session({ status: 'abandoned' }), hyps, false)).toBe('abandoned');
  });
});
