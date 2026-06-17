import { describe, it, expect } from 'vitest';
import { makeLock } from '../src/mutex.js';

describe('makeLock', () => {
  it('serializes overlapping async sections — the second cannot observe the first half-applied', async () => {
    const lock = makeLock();
    const order: string[] = [];
    let shared = 0;

    // Two critical sections that each read, await, then write. Without the lock
    // the second would read shared mid-first-section (a torn value).
    const a = lock(async () => {
      order.push('a:start');
      const seen = shared;
      await new Promise((r) => setTimeout(r, 20));
      shared = seen + 1;
      order.push('a:end');
    });
    const b = lock(async () => {
      order.push('b:start');
      // If serialized, b sees a's committed write (shared===1), never 0 mid-flight.
      expect(shared).toBe(1);
      shared = shared + 1;
      order.push('b:end');
    });

    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(shared).toBe(2);
  });

  it('returns the wrapped function result', async () => {
    const lock = makeLock();
    await expect(lock(async () => 42)).resolves.toBe(42);
  });

  it('a throwing section releases the lock so the next still runs', async () => {
    const lock = makeLock();
    await expect(lock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(lock(async () => 'ok')).resolves.toBe('ok');
  });
});
