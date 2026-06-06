import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, Hypothesis, Session } from './types.js';

// ─── Session Index (lightweight metadata for lazy loading) ───

export interface SessionIndex {
  id: string;
  problem: string;
  status: 'open' | 'resolved' | 'abandoned';
  createdAt: string;
  filePath: string;
  nodeCount: number; // estimated from line count
}

interface JournalEntry {
  timestamp: string;
  type: string;
  payload: unknown;
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
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    await appendFile(this.filePath, JSON.stringify(entry) + '\n').catch((err) => {
      console.error(`[tot-mcp] Warning: failed to write JSONL: ${err}`);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }
}

export function discoverDataDir(): string {
  const override = process.env['TOT_DATA_DIR'];
  if (override) return override;

  const projectDir = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  return join(projectDir, '.tot', 'sessions');
}

export function loadActiveSessions(dataDir: string): { sessions: Session[]; hypotheses: Hypothesis[] } {
  if (!existsSync(dataDir)) return { sessions: [], hypotheses: [] };

  const sessions: Session[] = [];
  const hypotheses: Hypothesis[] = [];

  let files: string[];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { sessions: [], hypotheses: [] };
  }

  for (const file of files) {
    const filePath = join(dataDir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        try {
          const entry: JournalEntry = JSON.parse(line);
          replayEntry(entry, sessions, hypotheses);
        } catch {
          console.error(`[tot-mcp] Warning: skipping corrupt JSONL line in ${file}`);
        }
      }
    } catch (err) {
      console.error(`[tot-mcp] Warning: failed to read ${file}: ${err}`);
    }
  }

  return { sessions, hypotheses };
}

/**
 * True iff the subtree rooted at rootId contains a corroborated hypothesis
 * on a non-pruned lineage. Walks the tree from the root, skipping descendants
 * of any eliminated or out-of-scope ancestor. Mirrors the engine's
 * subtreeContainsCorroborated walker so replay agrees with the live decision.
 */
function subtreeContainsCorroborated(rootId: string, sessionHypotheses: Hypothesis[]): boolean {
  const byId = new Map(sessionHypotheses.map((h) => [h.id, h] as const));
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = byId.get(id);
    if (!node) continue;
    if (node.status === 'eliminated' || node.status === 'out-of-scope') continue;
    if (node.status === 'corroborated') return true;
    for (const childId of node.children) stack.push(childId);
  }
  return false;
}

/**
 * Scans session files and returns lightweight metadata without replaying events.
 * Reads only the first line (session-created event) + counts lines for nodeCount estimate.
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

      const firstEntry: JournalEntry = JSON.parse(lines[0]);
      if (firstEntry.type !== 'session-created') continue;

      const session = firstEntry.payload as Session;

      // Determine final status by tracking the last session-level event.
      // session-reopened wins over an earlier session-completed; the
      // session-completed payload's terminalStatus disambiguates resolved
      // from abandoned, and falls back to a pruning-aware spine walk if
      // the field is missing.
      let status: SessionIndex['status'] = session.status;
      let lastSessionEvent: 'completed' | 'reopened' | null = null;
      let lastTerminalStatus: 'resolved' | 'abandoned' | undefined;
      const latestHypothesis = new Map<string, Hypothesis>();
      for (let i = 1; i < lines.length; i++) {
        try {
          const entry: JournalEntry = JSON.parse(lines[i]);
          if (entry.type === 'session-completed') {
            lastSessionEvent = 'completed';
            lastTerminalStatus = (entry.payload as { terminalStatus?: 'resolved' | 'abandoned' }).terminalStatus;
          } else if (entry.type === 'session-reopened') {
            lastSessionEvent = 'reopened';
            lastTerminalStatus = undefined;
          } else if (entry.type === 'hypothesis-added' || entry.type === 'hypothesis-updated') {
            const h = entry.payload as Hypothesis;
            latestHypothesis.set(h.id, h);
          }
        } catch {
          // skip corrupt lines
        }
      }
      if (lastSessionEvent === 'reopened') {
        status = 'open';
      } else {
        const reachedTerminal =
          lastSessionEvent === 'completed' ||
          (lastSessionEvent === null && status !== 'open');
        if (reachedTerminal) {
          if (lastTerminalStatus) {
            status = lastTerminalStatus;
          } else {
            // Discriminate by the hypothesis tree's final state. The walker
            // skips descendants of pruned ancestors so it agrees with the
            // engine's closure choice: only a corroborated hypothesis on a
            // non-pruned lineage counts as survival.
            const sessionHypotheses = Array.from(latestHypothesis.values());
            const hasCorroborated = subtreeContainsCorroborated(session.rootNodeId, sessionHypotheses);
            status = hasCorroborated ? 'resolved' : 'abandoned';
          }
        }
      }

      index.push({
        id: session.id,
        problem: session.problem,
        status,
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

    const sessions: Session[] = [];
    const hypotheses: Hypothesis[] = [];

    for (const line of lines) {
      try {
        const entry: JournalEntry = JSON.parse(line);
        replayEntry(entry, sessions, hypotheses);
      } catch {
        // skip corrupt lines
      }
    }

    if (sessions.length === 0) return null;
    return { session: sessions[0], hypotheses };
  } catch {
    return null;
  }
}

function replayEntry(
  entry: JournalEntry,
  sessions: Session[],
  hypotheses: Hypothesis[],
): void {
  switch (entry.type) {
    case 'session-created': {
      sessions.push(entry.payload as Session);
      break;
    }
    case 'hypothesis-added': {
      hypotheses.push(entry.payload as Hypothesis);
      break;
    }
    case 'hypothesis-updated': {
      const updated = entry.payload as Hypothesis;
      const idx = hypotheses.findIndex((h) => h.id === updated.id);
      if (idx >= 0) hypotheses[idx] = updated;
      else hypotheses.push(updated);
      break;
    }
    case 'evidence-added': {
      const { hypothesisId, evidence } = entry.payload as { hypothesisId: string; evidence: Evidence };
      const h = hypotheses.find((hyp) => hyp.id === hypothesisId);
      if (h) h.evidence.push(evidence);
      break;
    }
    case 'session-completed': {
      const payload = entry.payload as { sessionId: string; terminalStatus: 'resolved' | 'abandoned' };
      const s = sessions.find((sess) => sess.id === payload.sessionId);
      if (!s) break;
      s.status = payload.terminalStatus;
      s.completedAt = entry.timestamp;
      break;
    }
    case 'session-reopened': {
      const { sessionId } = entry.payload as { sessionId: string };
      const s = sessions.find((sess) => sess.id === sessionId);
      if (s) {
        s.status = 'open';
        s.completedAt = undefined;
      }
      break;
    }
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
