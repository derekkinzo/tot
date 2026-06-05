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

// Translates legacy status literals on read so older JSONL files replay into
// the current vocabulary. The on-disk bytes are never rewritten — every read
// path passes payloads through this before they become typed records.
function translateLegacyStatus<T extends { status?: string }>(payload: T): T {
  if (!payload || typeof payload !== 'object' || !payload.status) return payload;
  switch (payload.status) {
    case 'active':    payload.status = 'open'; break;
    case 'completed': payload.status = 'resolved'; break;
    case 'confirmed': payload.status = 'corroborated'; break;
  }
  return payload;
}

function translateLegacyVerdict<T extends { conclusion?: { verdict?: string; refutingEvidenceIds?: string[] } }>(payload: T): T {
  if (payload?.conclusion?.verdict === 'confirmed') {
    payload.conclusion.verdict = 'corroborated';
  }
  // Legacy eliminated records carry no refutingEvidenceIds. Fill an empty
  // array so the in-memory shape is consistent; the audit trail is genuinely
  // absent for these records.
  if (payload?.conclusion?.verdict === 'eliminated' && payload.conclusion.refutingEvidenceIds === undefined) {
    payload.conclusion.refutingEvidenceIds = [];
  }
  return payload;
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

      const session = translateLegacyStatus(firstEntry.payload as Session);

      // Determine final status by scanning for session-completed event
      // (the wire identifier covers both 'resolved' and 'abandoned' transitions).
      let status: SessionIndex['status'] = session.status;
      for (let i = lines.length - 1; i >= 1; i--) {
        try {
          const entry: JournalEntry = JSON.parse(lines[i]);
          if (entry.type === 'session-completed') {
            status = 'resolved';
            break;
          }
        } catch {
          // skip corrupt lines
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

function replayEntry(entry: JournalEntry, sessions: Session[], hypotheses: Hypothesis[]): void {
  switch (entry.type) {
    case 'session-created': {
      const session = translateLegacyStatus(entry.payload as Session);
      sessions.push(session);
      break;
    }
    case 'hypothesis-added': {
      const h = translateLegacyVerdict(translateLegacyStatus(entry.payload as Hypothesis));
      hypotheses.push(h);
      break;
    }
    case 'hypothesis-updated': {
      const updated = translateLegacyVerdict(translateLegacyStatus(entry.payload as Hypothesis));
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
      const { sessionId } = entry.payload as { sessionId: string };
      const s = sessions.find((sess) => sess.id === sessionId);
      if (s) {
        // The wire event covers both terminal transitions; only flip
        // 'open' sessions and assume resolution. Sessions written by newer
        // code carry their own terminal status before this event replays.
        if (s.status === 'open') s.status = 'resolved';
        s.completedAt = entry.timestamp;
      }
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
