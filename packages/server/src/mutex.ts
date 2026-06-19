/**
 * A promise-chain mutex. Serializes async critical sections so an in-flight
 * mutation cannot interleave with another read/write across `await` points
 * (e.g. an HTTP /api/state read while an MCP tool handler is mid-mutation).
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
