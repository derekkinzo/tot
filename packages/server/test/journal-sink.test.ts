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
  id, parentId: null, sessionId, depth: 0, content: 'c', status: 'exploring',
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

  it('routes hypothesis events to hypothesis.sessionId, payload = the hypothesis', () => {
    const h = hyp('h1', 's9');
    expect(journalEventToEntry({ type: 'hypothesis-added', hypothesis: h })).toEqual({ sessionId: 's9', type: 'hypothesis-added', payload: h });
    expect(journalEventToEntry({ type: 'hypothesis-updated', hypothesis: h })).toEqual({ sessionId: 's9', type: 'hypothesis-updated', payload: h });
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

  it('drain on a never-touched session resolves immediately (no-op)', async () => {
    const sink = new JournalSink(() => recordingWriter());
    await expect(sink.drain('never')).resolves.toBeUndefined();
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
    // drain must resolve (not reject) despite the middle failure.
    await expect(sink.drain('s1')).resolves.toBeUndefined();
    expect(ok).toEqual(['session-created', 'hypothesis-updated']);
  });

  it('records a per-session append failure so a caller can surface it after drain', async () => {
    const writer: JournalWriter = {
      append: async () => { throw new Error('disk full'); },
    };
    const sink = new JournalSink(() => writer);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    expect(sink.hadFailure('s1')).toBe(false);
    tm.emit('event', { type: 'session-created', session: session('s1') });
    await sink.drain('s1');

    // The append rejected, so the session is flagged unhealthy. A mutating tool
    // handler reads this after draining to acknowledge with isError rather than
    // reporting a success for state that never reached disk.
    expect(sink.hadFailure('s1')).toBe(true);
    // A session whose appends all succeeded is unaffected.
    expect(sink.hadFailure('other')).toBe(false);
  });

  it('does not flag a session whose appends all succeed', async () => {
    const w = recordingWriter();
    const sink = new JournalSink(() => w);
    const tm = new EventEmitter();
    sink.subscribe(tm);

    tm.emit('event', { type: 'session-created', session: session('s1') });
    tm.emit('event', { type: 'hypothesis-added', hypothesis: hyp('h1', 's1') });
    await sink.drain('s1');

    expect(sink.hadFailure('s1')).toBe(false);
  });
});
