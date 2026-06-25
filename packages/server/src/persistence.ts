import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEntry, deriveScanStatus, emptyReplayState, JOURNAL_SCHEMA_VERSION, type JournalEntry } from './replay.js';
import type { Hypothesis, Session, TreeEvent } from './types.js';

// ─── Session Index (lightweight metadata for lazy loading) ───

export interface SessionIndex {
  id: string;
  problem: string;
  status: 'open' | 'resolved' | 'abandoned';
  createdAt: string;
  filePath: string;
  nodeCount: number; // estimated from line count
}

export class Persistence {
  private filePath: string;
  private onError?: (err: Error) => void;

  constructor(dataDir: string, sessionId: string, onError?: (err: Error) => void) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, `${sessionId}.jsonl`);
    this.onError = onError;
    ensureGitignore(dataDir);
  }

  async append(type: string, payload: unknown): Promise<void> {
    const entry: JournalEntry = {
      v: JOURNAL_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    try {
      await appendFile(this.filePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error(`[tot-mcp] Warning: failed to write JSONL: ${err}`);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      // Propagate so the sink can flag the session unhealthy and the tool
      // handler acknowledges with isError rather than reporting a false success
      // for a mutation that never reached disk.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

/**
 * Picks the "active" entry from a set of sessions: the most recently created
 * open one, falling back to the most recent overall; undefined when empty.
 * Generic over anything carrying a status + createdAt, so the server's eager
 * load (SessionIndex), the dashboard default (Session), and `status` all share
 * one definition of "which session is current".
 */
export function pickActiveSession<T extends { status: string; createdAt: string }>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  const sorted = [...items].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return sorted.find((s) => s.status === 'open') ?? sorted[0];
}

/**
 * Scans session files and returns lightweight metadata. Folds every line
 * through the shared {@link applyEntry} reducer (so scan and full replay agree
 * by construction), then projects the index status via {@link deriveScanStatus}.
 * Corrupt lines are skipped rather than discarding an otherwise-recoverable file.
 */
export function scanSessions(dataDir: string): SessionIndex[] {
  if (!existsSync(dataDir)) return [];

  let files: string[];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const index: SessionIndex[] = [];

  for (const file of files) {
    const filePath = join(dataDir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length === 0) continue;

      const state = emptyReplayState();
      // Whether any session-completed entry carried an explicit terminalStatus;
      // when it did, deriveScanStatus trusts it instead of re-deriving via the
      // spine walk (a legacy/hand-authored terminal session has none).
      let sawExplicitTerminal = false;
      for (const line of lines) {
        try {
          const entry: JournalEntry = JSON.parse(line);
          if (entry.type === 'session-completed'
            && (entry.payload as { terminalStatus?: string }).terminalStatus) {
            sawExplicitTerminal = true;
          }
          applyEntry(state, entry);
        } catch {
          // skip corrupt line, keep folding the rest
        }
      }

      const session = state.sessions[0];
      if (!session) continue; // no session-created header → not a usable session file

      index.push({
        id: session.id,
        problem: session.problem,
        status: deriveScanStatus(session, state.hypotheses, sawExplicitTerminal),
        createdAt: session.createdAt,
        filePath,
        nodeCount: lines.length, // rough estimate (includes non-hypothesis events)
      });
    } catch {
      // Skip files that can't be read or parsed
    }
  }

  return index;
}

/**
 * Loads a single session file by replaying all its events.
 * Returns the session and its hypotheses fully reconstructed.
 */
export function loadSession(filePath: string): { session: Session; hypotheses: Hypothesis[] } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    const state = emptyReplayState();
    for (const line of lines) {
      try {
        applyEntry(state, JSON.parse(line) as JournalEntry);
      } catch {
        // skip corrupt lines
      }
    }

    if (state.sessions.length === 0) return null;
    return { session: state.sessions[0], hypotheses: state.hypotheses };
  } catch {
    return null;
  }
}

/** A journalable record derived from an engine event: which session's file it
 *  belongs to, and the {type, payload} to append. */
export interface JournalRecord {
  sessionId: string;
  type: string;
  payload: unknown;
}

/**
 * Maps an engine {@link TreeEvent} to the journal record to persist, or `null`
 * for events that are not journaled. This is the write-side counterpart to
 * applyEntry in replay.ts (the read side); a journaled type must have a
 * matching applyEntry case.
 *
 * `evidence-added` is deliberately NOT journaled. The engine appends the
 * evidence to the hypothesis before emitting, so the `hypothesis-updated` event
 * that immediately follows already carries it; recording both would have replay
 * apply the same evidence twice. `snapshot` is never emitted by the engine.
 * Each journaled event self-carries its session id, so routing needs no
 * hypothesis→session lookup.
 */
export function journalEventToEntry(event: TreeEvent): JournalRecord | null {
  switch (event.type) {
    case 'session-created':
      return { sessionId: event.session.id, type: event.type, payload: event.session };
    case 'hypothesis-added':
    case 'hypothesis-updated':
      return { sessionId: event.hypothesis.sessionId, type: event.type, payload: event.hypothesis };
    case 'session-completed':
      return { sessionId: event.sessionId, type: event.type, payload: { sessionId: event.sessionId, terminalStatus: event.terminalStatus } };
    case 'session-reopened':
      return { sessionId: event.sessionId, type: event.type, payload: { sessionId: event.sessionId } };
    case 'evidence-added':
    case 'snapshot':
      return null;
  }
}

function ensureGitignore(dataDir: string): void {
  const parentDir = join(dataDir, '..');
  // Only write .gitignore if the parent looks like a .tot directory.
  // Custom TOT_DATA_DIR paths may point elsewhere; writing a blanket
  // "*" gitignore in an arbitrary directory would be surprising.
  if (!parentDir.endsWith('.tot')) return;

  const gitignorePath = join(parentDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    try {
      writeFileSync(gitignorePath, '*\n');
    } catch {
      // Non-critical
    }
  }
}
