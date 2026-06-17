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
    hub.subscribeProject('/p', tm, () => null);
    const c = fakeClient();
    hub.addClient(c, '/p');
    tm.emit('event', ev('a'));
    tm.emit('event', ev('b'));
    expect(c.writes.join('')).toContain('"sessionId":"a"');
    expect(c.writes.join('')).toContain('"sessionId":"b"');
  });

  it('broadcast assigns monotonically increasing event ids per project', () => {
    const hub = new SseHub(() => {}, () => {});
    const tm = new EventEmitter();
    hub.subscribeProject('/p', tm, () => null);
    const c = fakeClient();
    hub.addClient(c, '/p');
    tm.emit('event', ev('a'));
    tm.emit('event', ev('b'));
    const ids = c.writes.map((w: string) => /id: (\d+)/.exec(w)?.[1]).filter(Boolean);
    expect(ids).toEqual(['1', '2']);
  });

  it('removeClient stops delivery and fires onDisconnect exactly once (idempotent)', () => {
    let disconnects = 0;
    const hub = new SseHub(() => {}, () => { disconnects++; });
    const tm = new EventEmitter();
    hub.subscribeProject('/p', tm, () => null);
    const c = fakeClient();
    hub.addClient(c, '/p');
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
    hub.subscribeProject('/p', tm, () => null);
    const c = fakeClient();
    hub.addClient(c, '/p');
    c.failOnce();
    tm.emit('event', ev('a')); // write throws → client dropped
    expect(disconnects).toBe(1);
    tm.emit('event', ev('b'));
    expect(c.writes.join('')).not.toContain('"sessionId":"b"');
  });

  it('waiting-client flush binds a client only to the project it requested', () => {
    const hub = new SseHub(() => {}, () => {});
    const pA = new EventEmitter();
    const pB = new EventEmitter();
    hub.subscribeProject('/A', pA, () => null);
    hub.subscribeProject('/B', pB, () => null);
    const wantsA = fakeClient();
    const noPref = fakeClient();
    hub.addWaiting(wantsA, '/A');
    hub.addWaiting(noPref, null);

    // Project B fires first: must NOT capture the client that asked for A.
    pB.emit('event', ev('b1'));
    expect(noPref.writes.join('')).toContain('"sessionId":"b1"'); // no-preference binds to B
    expect(wantsA.writes.join('')).not.toContain('"sessionId":"b1"'); // stays waiting

    // Now A fires: the A-requester binds and receives A's events.
    pA.emit('event', ev('a1'));
    expect(wantsA.writes.join('')).toContain('"sessionId":"a1"');
  });

  it('re-subscribing a project with a new emitter removes the prior listener (no double-fire)', () => {
    const hub = new SseHub(() => {}, () => {});
    const tm1 = new EventEmitter();
    hub.subscribeProject('/p', tm1, () => null);
    const c = fakeClient();
    hub.addClient(c, '/p');
    const tm2 = new EventEmitter();
    hub.subscribeProject('/p', tm2, () => null); // swap
    tm1.emit('event', ev('old')); // prior emitter must no longer reach the client
    tm2.emit('event', ev('new'));
    const joined = c.writes.join('');
    expect(joined).not.toContain('"sessionId":"old"');
    expect(joined).toContain('"sessionId":"new"');
  });

  it('isSubscribed reports whether the given emitter is the current one for a project', () => {
    const hub = new SseHub(() => {}, () => {});
    const tm1 = new EventEmitter();
    const tm2 = new EventEmitter();
    hub.subscribeProject('/p', tm1, () => null);
    expect(hub.isSubscribed('/p', tm1)).toBe(true);
    expect(hub.isSubscribed('/p', tm2)).toBe(false);
    expect(hub.isSubscribed('/other', tm1)).toBe(false);
  });
});
