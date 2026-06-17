import type { TreeEvent } from './types.js';

/** Minimal SSE sink — anything that can receive a chunk (a Node ServerResponse). */
export interface SseClient {
  write(chunk: string): void;
}

/** Emits 'event' with a TreeEvent payload (a TreeManager). */
interface EventSource {
  on(event: 'event', listener: (e: TreeEvent) => void): void;
  removeListener(event: 'event', listener: (e: TreeEvent) => void): void;
}

interface Channel {
  source: EventSource;
  listener: (e: TreeEvent) => void;
  clients: Set<SseClient>;
  counter: number;
  snapshotFor: () => TreeEvent | null;
}

/**
 * Owns the SSE client lifecycle for one project's tree: subscription to the
 * engine event stream, broadcast with monotonic event ids, keepalive, and
 * balanced connect/disconnect accounting. Decoupled from HTTP so it is
 * unit-testable with a plain EventEmitter and a fake client.
 */
export class SseHub {
  private channel: Channel | null = null;

  constructor(
    private onConnect: () => void,
    private onDisconnect: () => void,
  ) {}

  /**
   * Subscribe (or re-subscribe) the project to its engine event source. A
   * second call with a different source swaps the listener (removing the old
   * one) so a replaced TreeManager does not double-fire into clients.
   */
  subscribe(source: EventSource, snapshotFor: () => TreeEvent | null): void {
    const existing = this.channel;
    if (existing) {
      if (existing.source === source) {
        existing.snapshotFor = snapshotFor; // same source, refresh snapshot thunk
        return;
      }
      existing.source.removeListener('event', existing.listener);
    }

    this.channel = {
      source,
      clients: existing?.clients ?? new Set<SseClient>(),
      counter: existing?.counter ?? 0,
      snapshotFor,
      listener: (event: TreeEvent) => this.onEvent(event),
    };
    source.on('event', this.channel.listener);
  }

  /** True when `source` is the currently-subscribed emitter. */
  isSubscribed(source: EventSource): boolean {
    return this.channel?.source === source;
  }

  /** Register a live client. */
  addClient(client: SseClient): void {
    if (!this.channel) return;
    this.channel.clients.add(client);
    this.onConnect();
  }

  /**
   * Remove a client, firing onDisconnect exactly once (only when a delete
   * actually removed it), so accounting stays balanced across the
   * keepalive-prune and req-close paths.
   */
  removeClient(client: SseClient): void {
    if (this.channel?.clients.delete(client)) {
      this.onDisconnect();
    }
  }

  /** Write a keepalive comment to every client; reap any that fail. */
  keepalive(): void {
    if (!this.channel) return;
    for (const client of this.channel.clients) {
      try { client.write(': keepalive\n\n'); }
      catch { this.removeClient(client); }
    }
  }

  private onEvent(event: TreeEvent): void {
    const channel = this.channel;
    if (!channel || channel.clients.size === 0) return;
    channel.counter += 1;
    const data = `id: ${channel.counter}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of channel.clients) {
      try { client.write(data); }
      catch { this.removeClient(client); }
    }
  }
}
