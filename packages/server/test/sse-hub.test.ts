import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { SseHub, type SseClient } from '../src/sse-hub.js';
import type { TreeEvent } from '../src/types.js';

/** Minimal SSE client capturing what the hub writes. */
function fakeClient() {
  const writes: string[] = [];
  let failNext = false;
  return {
    writes,
    failOnce() { failNext = true; },
    write(s: string) {
      if (failNext) { failNext = false; throw new Error('write failed'); }
      writes.push(s);
    },
  } satisfies SseClient & { writes: string[]; failOnce(): void };
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

});
