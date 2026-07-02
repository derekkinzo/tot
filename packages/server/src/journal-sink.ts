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
  // Sessions with a pending, not-yet-surfaced append rejection. A failed write
  // does not poison the per-session chain (later events still attempt to write),
  // but it is flagged so the next {@link drain} for that session reports the
  // failure and clears it. The flag is scoped to the batch a caller drains, not
  // sticky for the session lifetime: once a caller has been told a write failed,
  // a subsequent batch whose appends all succeed reports clean.
  private failed = new Set<string>();

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
    const sessionId = record.sessionId;
    // Per-session serialization preserves emit order on disk. A rejected append
    // is caught here so the chain is not poisoned (later events still attempt to
    // write), but the session is recorded as failed so drain-then-check can
    // surface the data loss to the tool caller.
    void this.lockFor(sessionId)(() => writer.append(record.type, record.payload))
      .catch(() => { this.failed.add(sessionId); });
  }

  /**
   * Resolves once every append enqueued for this session so far has settled, and
   * reports whether any of them rejected. A mutating tool handler awaits this
   * after its mutation and acknowledges with isError when it returns true, rather
   * than reporting a success for state that never reached disk. The failure flag
   * is consumed here, so a later batch whose appends all succeed reports false.
   */
  drain(sessionId: string): Promise<boolean> {
    const lock = this.locks.get(sessionId);
    if (!lock) return Promise.resolve(false);
    // The drain section chains after all enqueued appends (and their failure
    // recording) have settled, so reading + clearing the flag here observes the
    // full batch.
    return lock(async () => {
      const failed = this.failed.delete(sessionId);
      return failed;
    });
  }

  /** Resolves once every session's enqueued appends have settled. */
  drainAll(): Promise<void> {
    return Promise.allSettled([...this.locks.values()].map((l) => l(async () => {}))).then(() => undefined);
  }
}
