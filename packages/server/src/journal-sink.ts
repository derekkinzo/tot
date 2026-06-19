import { journalEventToEntry } from './persistence.js';
import { makeLock, type Lock } from './mutex.js';
import type { TreeEvent } from './types.js';

/** Minimal append-only journal writer (a Persistence instance). */
export interface JournalWriter {
  append(type: string, payload: unknown): Promise<void>;
}

/** Emits 'event' with a TreeEvent payload (a TreeManager). */
interface EventSource {
  on(event: 'event', listener: (e: TreeEvent) => void): void;
}

/**
 * Drives the JSONL journal off the engine's event stream — the same stream the
 * SSE layer consumes — so journaling is derived from one source of truth rather
 * than replicated by hand in each tool handler.
 *
 * For every journaled event the sink routes to the per-session writer (keyed by
 * the session id the event self-carries) and serializes appends per session via
 * a promise-chain lock, so the on-disk order equals the emit order. A handler
 * awaits {@link drain} for its session before returning, reproducing the
 * write-before-acknowledge barrier the inline `await append()` calls provided.
 *
 * Decoupled from the engine and from Persistence: it depends only on the
 * TreeEvent contract and a narrow {@link JournalWriter}.
 */
export class JournalSink {
  private locks = new Map<string, Lock>();

  constructor(private getWriter: (sessionId: string) => JournalWriter) {}

  /** Bind to an engine event source. Call once, before any mutation runs. */
  subscribe(source: EventSource): void {
    source.on('event', (event) => this.onEvent(event));
  }

  private lockFor(sessionId: string): Lock {
    let lock = this.locks.get(sessionId);
    if (!lock) {
      lock = makeLock();
      this.locks.set(sessionId, lock);
    }
    return lock;
  }

  private onEvent(event: TreeEvent): void {
    const record = journalEventToEntry(event);
    if (!record) return;
    const writer = this.getWriter(record.sessionId);
    // Per-session serialization preserves emit order on disk. append() reports
    // its own errors and never rejects, so the chain is not poisoned; the
    // trailing catch is defensive against a writer that violates that.
    void this.lockFor(record.sessionId)(() => writer.append(record.type, record.payload)).catch(() => {});
  }

  /** Resolves once every append enqueued for this session so far has settled. */
  drain(sessionId: string): Promise<void> {
    const lock = this.locks.get(sessionId);
    if (!lock) return Promise.resolve();
    return lock(async () => {});
  }

  /** Resolves once every session's enqueued appends have settled. */
  drainAll(): Promise<void> {
    return Promise.allSettled([...this.locks.values()].map((l) => l(async () => {}))).then(() => undefined);
  }
}
