import type { TreeEvent } from './types.js';

/**
 * Minimal SSE sink — anything that can receive a chunk (a Node ServerResponse).
 * `write` returns the backpressure signal: false when the send buffer is full
 * (the caller should stop writing until it drains). Node's ServerResponse.write
 * already returns this boolean.
 */
export interface SseClient {
  write(chunk: string): boolean;
}

/** Emits 'event' with a TreeEvent payload (a TreeManager). */
interface EventSource {
  on(event: 'event', listener: (e: TreeEvent) => void): void;
}

/**
 * Owns the SSE client lifecycle for the project's tree: one subscription to the
 * engine event stream, broadcast with monotonic event ids, keepalive, and
 * balanced connect/disconnect accounting. Decoupled from HTTP so it is
 * unit-testable with a plain EventEmitter and a fake client.
 */
export class SseHub {
  /**
   * Consecutive backpressured writes a client may accrue before it is dropped.
   * A momentary full buffer is normal; a client that never drains across this
   * many broadcasts is wedged (suspended tab, dead connection) and would
   * otherwise buffer unbounded in-process.
   */
  static readonly MAX_BACKPRESSURED_WRITES = 50;

  private clients = new Set<SseClient>();
  // Consecutive backpressured (write()===false) broadcasts per client; reset on
  // any drained write. A client exceeding the cap is reaped.
  private backpressure = new WeakMap<SseClient, number>();
  private counter = 0;

  constructor(
    private onConnect: () => void,
    private onDisconnect: () => void,
  ) {}

  /** Subscribe to the engine event source. Called once, before the server accepts connections. */
  subscribe(source: EventSource): void {
    source.on('event', (event) => this.broadcast(event));
  }

  /** Register a live client. */
  addClient(client: SseClient): void {
    this.clients.add(client);
    this.onConnect();
  }

  /**
   * Remove a client, firing onDisconnect exactly once (only when a delete
   * actually removed it), so accounting stays balanced across the
   * keepalive-prune and req-close paths.
   */
  removeClient(client: SseClient): void {
    if (this.clients.delete(client)) {
      this.onDisconnect();
    }
  }

  /** Write a keepalive comment to every client; reap any that fail or stay wedged. */
  keepalive(): void {
    for (const client of this.clients) {
      this.writeTo(client, ': keepalive\n\n');
    }
  }

  private broadcast(event: TreeEvent): void {
    if (this.clients.size === 0) return;
    this.counter += 1;
    const data = `id: ${this.counter}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      this.writeTo(client, data);
    }
  }

  /**
   * Write one frame to a client, applying the shared backpressure policy: a
   * thrown write (dead socket) reaps immediately; a drained write (write()
   * returns true) clears accrued backpressure; a full buffer (false) increments
   * the consecutive-backpressure count and reaps once it stays wedged past the
   * cap. Used by both broadcast and keepalive so a keepalive that drains on a
   * quiet stream lets a recovered client off the hook.
   */
  private writeTo(client: SseClient, data: string): void {
    try {
      const drained = client.write(data);
      if (drained) {
        this.backpressure.delete(client);
        return;
      }
      const n = (this.backpressure.get(client) ?? 0) + 1;
      if (n > SseHub.MAX_BACKPRESSURED_WRITES) {
        this.removeClient(client);
      } else {
        this.backpressure.set(client, n);
      }
    } catch {
      this.removeClient(client);
    }
  }
}
