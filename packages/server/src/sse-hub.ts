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

interface ProjectChannel {
  source: EventSource;
  listener: (e: TreeEvent) => void;
  clients: Set<SseClient>;
  counter: number;
  snapshotFor: () => TreeEvent | null;
}

/**
 * Owns the SSE client lifecycle: per-project subscription to the engine event
 * stream, broadcast with monotonic event ids, snapshot-on-flush for clients
 * that connected before their project existed, keepalive, and balanced
 * connect/disconnect accounting. Decoupled from HTTP so it is unit-testable
 * with a plain EventEmitter and a fake client.
 */
export class SseHub {
  private channels = new Map<string, ProjectChannel>();
  // Clients connected before their project existed → the project they asked
  // for via ?project= (null = no preference), so a flush binds each only to
  // the project it actually wanted.
  private waiting = new Map<SseClient, string | null>();

  constructor(
    private onConnect: () => void,
    private onDisconnect: () => void,
  ) {}

  /**
   * Subscribe (or re-subscribe) a project to its engine event source. A second
   * call with a different source swaps the listener (removing the old one), so
   * a replaced TreeManager does not double-fire into clients.
   */
  subscribeProject(projectDir: string, source: EventSource, snapshotFor: () => TreeEvent | null): void {
    const existing = this.channels.get(projectDir);
    if (existing) {
      if (existing.source === source) {
        existing.snapshotFor = snapshotFor; // same source, refresh snapshot thunk
        return;
      }
      existing.source.removeListener('event', existing.listener);
    }

    const channel: ProjectChannel = {
      source,
      clients: existing?.clients ?? new Set<SseClient>(),
      counter: existing?.counter ?? 0,
      snapshotFor,
      listener: (event: TreeEvent) => this.onEvent(projectDir, event),
    };
    source.on('event', channel.listener);
    this.channels.set(projectDir, channel);
  }

  /** True when `source` is the currently-subscribed emitter for `projectDir`. */
  isSubscribed(projectDir: string, source: EventSource): boolean {
    return this.channels.get(projectDir)?.source === source;
  }

  /** Register a live client for an already-subscribed project. */
  addClient(client: SseClient, projectDir: string): void {
    const channel = this.channels.get(projectDir);
    if (!channel) {
      // Project not yet subscribed — treat as a no-preference waiting client.
      this.addWaiting(client, projectDir);
      return;
    }
    channel.clients.add(client);
    this.onConnect();
  }

  /** Park a client until its requested project fires/registers. */
  addWaiting(client: SseClient, requestedProject: string | null): void {
    this.waiting.set(client, requestedProject);
    this.onConnect();
  }

  /**
   * Remove a client from wherever it lives, firing onDisconnect exactly once
   * (only when a delete actually removed it), so accounting stays balanced
   * across the keepalive-prune and req-close paths.
   */
  removeClient(client: SseClient): void {
    if (this.waiting.delete(client)) {
      this.onDisconnect();
      return;
    }
    for (const channel of this.channels.values()) {
      if (channel.clients.delete(client)) {
        this.onDisconnect();
        return;
      }
    }
  }

  /** Write a keepalive comment to every client; reap any that fail. */
  keepalive(): void {
    for (const channel of this.channels.values()) {
      for (const client of channel.clients) {
        try { client.write(': keepalive\n\n'); }
        catch { this.removeClient(client); }
      }
    }
    for (const client of [...this.waiting.keys()]) {
      try { client.write(': keepalive\n\n'); }
      catch { this.removeClient(client); }
    }
  }

  private onEvent(projectDir: string, event: TreeEvent): void {
    const channel = this.channels.get(projectDir);
    if (!channel) return;

    // Flush waiting clients onto this project — only those with no preference
    // or that named this project.
    if (this.waiting.size > 0) {
      for (const [client, requested] of this.waiting) {
        if (requested && requested !== projectDir) continue;
        this.waiting.delete(client);
        channel.clients.add(client);
        const snapshot = channel.snapshotFor();
        if (snapshot) {
          try { client.write(`id: 0\ndata: ${JSON.stringify(snapshot)}\n\n`); }
          catch { channel.clients.delete(client); }
        }
      }
    }

    if (channel.clients.size === 0) return;
    channel.counter += 1;
    const data = `id: ${channel.counter}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of channel.clients) {
      try { client.write(data); }
      catch { this.removeClient(client); }
    }
  }
}
