import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { JournalSink, type JournalWriter } from '../src/journal-sink.js';
import { journalEventToEntry } from '../src/persistence.js';
import { TreeManager } from '../src/tree-manager.js';
import type { TreeEvent, Session, Hypothesis } from '../src/types.js';

const session = (id: string): Session => ({
  id, problem: 'p', rootNodeId: `${id}-root`, status: 'open', createdAt: '2024-01-01T00:00:00.000Z',
});
const hyp = (id: string, sessionId: string): Hypothesis => ({
  id, parentId: null, sessionId, depth: 0, title: 'c', status: 'exploring',
  evidence: [], metadata: { createdAt: '', updatedAt: '', source: 'agent' } as any, children: [],
});

/** A writer that records every append and lets a test gate completion. */
function recordingWriter() {
  const calls: Array<{ type: string; payload: unknown }> = [];
  return {
    calls,
    async append(type: string, payload: unknown) { calls.push({ type, payload }); },
  } satisfies JournalWriter & { calls: Array<{ type: string; payload: unknown }> };
}

describe('journalEventToEntry (write↔read contract mapper)', () => {
  it('does NOT journal evidence-added — the following hypothesis-updated already carries the evidence', () => {
    const e: TreeEvent = { type: 'evidence-added', hypothesisId: 'h1', evidence: { id: 'e1', type: 'supports', content: 'x', timestamp: '' } as any };
    expect(journalEventToEntry(e)).toBeNull();
  });

  it('does NOT journal snapshot (never emitted by the engine; SSE-only)', () => {
    const e: TreeEvent = { type: 'snapshot', session: session('s1'), hypotheses: [] };
    expect(journalEventToEntry(e)).toBeNull();
  });

  it('routes session-created to the session id, payload = the session', () => {
    const s = session('s1');
    expect(journalEventToEntry({ type: 'session-created', session: s })).toEqual({
      sessionId: 's1', type: 'session-created', payload: s,
    });
  });

  it('routes hypothesis events to hypothesis.sessionId', () => {
    const h = hyp('h1', 's9');
    expect(journalEventToEntry({ type: 'hypothesis-added', hypothesis: h })?.sessionId).toBe('s9');
    expect(journalEventToEntry({ type: 'hypothesis-updated', hypothesis: h })?.type).toBe('hypothesis-updated');
  });

  it('writes a prose field onto the persisted payload for readers that predate the label split', () => {
    // Central storage outlives any single build: a previously released reader
    // will open these files and expects one prose field. Writing it here — and
    // only here — keeps that reader working without holding a second copy of the
    // prose in memory, where it could drift from the title and statement.
    const withStatement = { ...hyp('h1', 's9'), title: 'Pool exhaustion', statement: 'The pool exhausts under load.' };
    const added = journalEventToEntry({ type: 'hypothesis-added', hypothesis: withStatement });
    expect((added!.payload as Record<string, unknown>).content).toBe('The pool exhausts under load.');

    // With no statement authored, the label itself is the prose.
    const titleOnly = { ...hyp('h2', 's9'), title: 'Pool exhaustion' };
    const updated = journalEventToEntry({ type: 'hypothesis-updated', hypothesis: titleOnly });
    expect((updated!.payload as Record<string, unknown>).content).toBe('Pool exhaustion');
  });

  it('keeps the persisted payload otherwise identical to the in-memory node', () => {
    const h = { ...hyp('h1', 's9'), title: 'T', statement: 'S' };
    const payload = journalEventToEntry({ type: 'hypothesis-added', hypothesis: h })!.payload as Record<string, unknown>;
    // The projection adds one field and changes nothing else.
    const { content, ...rest } = payload;
    expect(content).toBe('S');
    expect(rest).toEqual({ ...h });
  });

  it('flattens session-completed/​reopened wire shape to the persisted payload shape', () => {
    expect(journalEventToEntry({ type: 'session-completed', sessionId: 's1', terminalStatus: 'resolved' })).toEqual({
      sessionId: 's1', type: 'session-completed', payload: { sessionId: 's1', terminalStatus: 'resolved' },
    });
    expect(journalEventToEntry({ type: 'session-reopened', sessionId: 's1' })).toEqual({
      sessionId: 's1', type: 'session-reopened', payload: { sessionId: 's1' },
    });
  });
});

describe('JournalSink', () => {
  it('writes journaled events in emit (FIFO) order and skips evidence-added', async () => {
    const w = recordingWriter();
    const sink = new JournalSink(() => w);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') });
    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('h1', 's1') });
    tm.emit('event', { type: 'evidence-added', hypothesisId: 'h1', evidence: { id: 'e', type: 'supports', content: 'x', timestamp: '' } as any });
    tm.emit('event', { type: 'hypothesis-updated', hypothesis: hyp('h1', 's1') });
    await sink.drain('s1');

    expect(w.calls.map((c) => c.type)).toEqual(['session-created', 'hypothesis-added', 'hypothesis-updated']);
  });

  it('drain resolves only after the enqueued appends for that session have settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const writer: JournalWriter = { append: async (type) => { await gate; calls.push(type); } };
    const sink = new JournalSink(() => writer);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') });
    let drained = false;
    const d = sink.drain('s1').then(() => { drained = true; });
    // The append is blocked on the gate, so drain must not have resolved yet.
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(calls).toEqual([]);

    release();
    await d;
    expect(drained).toBe(true);
    expect(calls).toEqual(['session-created']);
  });

  it('drain on a never-touched session resolves immediately with no failure', async () => {
    const sink = new JournalSink(() => recordingWriter());
    await expect(sink.drain('never')).resolves.toBe(false);
  });

  it('routes concurrent sessions to their own writers with no cross-leakage', async () => {
    const writers = new Map<string, ReturnType<typeof recordingWriter>>();
    const sink = new JournalSink((sid) => {
      if (!writers.has(sid)) writers.set(sid, recordingWriter());
      return writers.get(sid)!;
    });
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('A') });
    tm.emit('event', { type: 'session-created', session: session('B') });
    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('hb', 'B') });
    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('ha', 'A') });
    await sink.drainAll();

    expect(writers.get('A')!.calls.map((c) => c.type)).toEqual(['session-created', 'hypothesis-added']);
    expect(writers.get('B')!.calls.map((c) => c.type)).toEqual(['session-created', 'hypothesis-added']);
    // No event for A landed in B's writer or vice versa.
    expect(writers.get('A')!.calls.every((c) => (c.payload as any).id !== 'hb')).toBe(true);
  });

  it('loadState fires zero appends — a reload must not re-journal the session', async () => {
    // loadState restores in-memory state without emitting (it is the reload
    // path, not a live mutation). A subscribed sink must therefore write
    // nothing, or every restart would rewrite the whole journal unboundedly.
    const w = recordingWriter();
    const sink = new JournalSink(() => w);
    const tm = new TreeManager({ stagnationThreshold: 4 });
    sink.subscribe(tm);

    const s = session('s1');
    tm.loadState([s], [hyp('s1-root', 's1')]);
    await sink.drainAll();

    expect(w.calls).toEqual([]);
  });

  it('a writer that rejects does not poison the session chain or reject drain', async () => {
    let n = 0;
    const ok: string[] = [];
    const writer: JournalWriter = {
      append: async (type) => { n += 1; if (n === 2) throw new Error('disk full'); ok.push(type); },
    };
    const sink = new JournalSink(() => writer);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') });   // ok
    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('h1', 's1') }); // throws
    tm.emit('event', { type: 'hypothesis-updated', hypothesis: hyp('h1', 's1') }); // still attempted
    // drain must resolve (not reject) despite the middle failure, and report the
    // failure so the caller surfaces it; the later append still ran (chain not
    // poisoned).
    await expect(sink.drain('s1')).resolves.toBe(true);
    expect(ok).toEqual(['session-created', 'hypothesis-updated']);
  });

  it('drain reports a failed append for the current batch so a caller can surface it', async () => {
    const writer: JournalWriter = {
      append: async () => { throw new Error('disk full'); },
    };
    const sink = new JournalSink(() => writer);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') });
    // drain resolves to true because an append in this batch rejected — a
    // mutating handler surfaces isError rather than reporting a false success.
    expect(await sink.drain('s1')).toBe(true);
    // A session with no enqueued appends reports no failure.
    expect(await sink.drain('other')).toBe(false);
  });

  it('drain reports no failure for a batch whose appends all succeed', async () => {
    const w = recordingWriter();
    const sink = new JournalSink(() => w);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') });
    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('h1', 's1') });
    expect(await sink.drain('s1')).toBe(false);
  });

  it('a transient failure is reported once, and a later successful batch reports clean', async () => {
    // The failure signal is scoped to the batch that hit it, not sticky for the
    // session lifetime: after the write path recovers, subsequent mutations that
    // reach disk must report success.
    let calls = 0;
    const writer: JournalWriter = {
      append: async () => { calls += 1; if (calls === 1) throw new Error('transient'); },
    };
    const sink = new JournalSink(() => writer);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') }); // fails
    expect(await sink.drain('s1')).toBe(true);

    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('h1', 's1') }); // succeeds
    expect(await sink.drain('s1')).toBe(false);
  });
});
