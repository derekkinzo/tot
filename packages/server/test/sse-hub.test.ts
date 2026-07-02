import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { SseHub, type SseClient } from '../src/sse-hub.js';
import type { TreeEvent } from '../src/types.js';

/** Minimal SSE client capturing what the hub writes. */
function fakeClient() {
  const writes: string[] = [];
  let failNext = false;
  let backpressured = false;
  return {
    writes,
    failOnce() { failNext = true; },
    /** Simulate a stalled consumer: write() returns false (kernel buffer full). */
    setBackpressured(v: boolean) { backpressured = v; },
    write(s: string): boolean {
      if (failNext) { failNext = false; throw new Error('write failed'); }
      writes.push(s);
      return !backpressured;
    },
  } satisfies SseClient & { writes: string[]; failOnce(): void; setBackpressured(v: boolean): void };
}

const ev = (n: string): TreeEvent => ({ type: 'session-reopened', sessionId: n });

describe('SseHub', () => {
  it('delivers subsequent broadcasts to a registered client', () => {
    const hub = new SseHub(() => {}, () => {});
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    tm.emit('event', ev('a'));
    tm.emit('event', ev('b'));
    expect(c.writes.join('')).toContain('"sessionId":"a"');
    expect(c.writes.join('')).toContain('"sessionId":"b"');
  });

  it('broadcast assigns monotonically increasing event ids', () => {
    const hub = new SseHub(() => {}, () => {});
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    tm.emit('event', ev('a'));
    tm.emit('event', ev('b'));
    const ids = c.writes.map((w: string) => /id: (\d+)/.exec(w)?.[1]).filter(Boolean);
    expect(ids).toEqual(['1', '2']);
  });

  it('removeClient stops delivery and fires onDisconnect exactly once (idempotent)', () => {
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    hub.removeClient(c);
    hub.removeClient(c); // second call must be a no-op
    expect(disconnects).toBe(1);
    const before = c.writes.length;
    tm.emit('event', ev('a'));
    expect(c.writes.length).toBe(before); // no delivery after removal
  });

  it('a failed write removes the client and fires onDisconnect once', () => {
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    c.failOnce();
    tm.emit('event', ev('a')); // write throws → client dropped
    expect(disconnects).toBe(1);
    tm.emit('event', ev('b'));
    expect(c.writes.join('')).not.toContain('"sessionId":"b"');
  });

  it('drops a persistently backpressured client to bound in-process buffering', () => {
    // write() returning false means the kernel send buffer is full. A momentary
    // false is normal, but a client that never drains (suspended laptop, dead
    // connection) would buffer unbounded in the MCP process. After a bounded run
    // of consecutive backpressured writes the hub must drop it.
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    c.setBackpressured(true);

    // Emit more than the backpressure tolerance; the client should be reaped.
    for (let i = 0; i < SseHub.MAX_BACKPRESSURED_WRITES + 1; i++) tm.emit('event', ev(`e${i}`));
    expect(disconnects).toBe(1);

    // Once dropped, further broadcasts are not delivered to it.
    const before = c.writes.length;
    tm.emit('event', ev('after'));
    expect(c.writes.length).toBe(before);
  });

  it('does not drop a client that recovers from momentary backpressure', () => {
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);

    // A few backpressured writes, then it drains (write returns true) — the
    // consecutive counter resets, so it is never dropped.
    c.setBackpressured(true);
    for (let i = 0; i < SseHub.MAX_BACKPRESSURED_WRITES - 1; i++) tm.emit('event', ev(`e${i}`));
    c.setBackpressured(false);
    tm.emit('event', ev('drained'));
    c.setBackpressured(true);
    for (let i = 0; i < SseHub.MAX_BACKPRESSURED_WRITES - 1; i++) tm.emit('event', ev(`f${i}`));
    expect(disconnects).toBe(0);
  });

  it('keepalive reaps a client whose write fails', () => {
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    c.failOnce();
    hub.keepalive();
    expect(disconnects).toBe(1);
    // The healthy path writes a keepalive comment to live clients.
    const c2 = fakeClient();
    hub.addClient(c2);
    hub.keepalive();
    expect(c2.writes.join('')).toContain(': keepalive');
  });

  it('a keepalive that drains resets the backpressure counter (low-traffic recovery)', () => {
    // On a quiet stream the only writes between broadcasts are keepalives; a
    // keepalive that drains must clear accrued backpressure so a client that has
    // recovered is not reaped by the next momentarily-backpressured broadcast.
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);

    // Accrue backpressure just below the cap on broadcasts.
    c.setBackpressured(true);
    for (let i = 0; i < SseHub.MAX_BACKPRESSURED_WRITES - 1; i++) tm.emit('event', ev(`e${i}`));
    // The socket drains; a keepalive now succeeds and must reset the counter.
    c.setBackpressured(false);
    hub.keepalive();
    // Backpressure returns; a full fresh run below the cap must not drop it.
    c.setBackpressured(true);
    for (let i = 0; i < SseHub.MAX_BACKPRESSURED_WRITES - 1; i++) tm.emit('event', ev(`f${i}`));
    expect(disconnects).toBe(0);
  });

  it('keepalive drops a persistently backpressured client (bounds buffering on quiet streams)', () => {
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribe(tm);
    const c = fakeClient();
    hub.addClient(c);
    c.setBackpressured(true);
    for (let i = 0; i < SseHub.MAX_BACKPRESSURED_WRITES + 1; i++) hub.keepalive();
    expect(disconnects).toBe(1);
  });

});
