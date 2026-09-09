/**
 * A promise-chain mutex: each section runs to completion before the next
 * starts, so one cannot observe state another left half-written across an
 * `await`. Held by the HTTP handlers, which lazily load a session — replacing
 * the engine's in-memory state — and then read it back. Tool handlers do not
 * take it, and do not need to: each mutation runs synchronously, so no await
 * can land inside one.
 */
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeLock(): Lock {
  let tail: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // Chain onto the current tail; run fn after the prior section settles
    // (success or failure), so a thrown section still releases the lock.
    const result = tail.then(fn, fn);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
