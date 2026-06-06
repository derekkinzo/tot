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
// path passes payloads through one of these before they become typed records.
// Session and hypothesis vocabularies are translated separately because their
// legacy and current value sets do not overlap.
function translateLegacySessionStatus<T extends { status?: string }>(payload: T): T {
  if (!payload || typeof payload !== 'object' || !payload.status) return payload;
  switch (payload.status) {
    case 'active':    payload.status = 'open'; break;
    case 'completed': payload.status = 'resolved'; break;
  }
  return payload;
}

function translateLegacyHypothesisStatus<T extends { status?: string }>(payload: T): T {
  if (!payload || typeof payload !== 'object' || !payload.status) return payload;
  if (payload.status === 'confirmed') payload.status = 'corroborated';
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
  // Sessions whose terminal status was authoritatively recorded on the wire
  // event are not subject to post-replay discrimination — the engine had the
  // full pruning-aware tree at close time and its decision is canonical.
  const wireTerminalSet = new Set<string>();

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
          replayEntry(entry, sessions, hypotheses, wireTerminalSet);
        } catch {
          console.error(`[tot-mcp] Warning: skipping corrupt JSONL line in ${file}`);
        }
      }
    } catch (err) {
      console.error(`[tot-mcp] Warning: failed to read ${file}: ${err}`);
    }
  }

  discriminateTerminalSessions(sessions, hypotheses, wireTerminalSet);
  return { sessions, hypotheses };
}

/**
 * Post-replay discriminator for sessions whose terminal status was NOT
 * authoritatively recorded on the wire. Sessions reaching this pass include
 * legacy journals that wrote terminal status only on the session-created
 * payload (translated to 'resolved' by the legacy shim above) and any
 * pre-terminalStatus 'session-completed' wire entries.
 *
 * The rule mirrors the engine's closure choice: a session is resolved iff
 * at least one corroborated hypothesis sits on a non-pruned lineage from
 * the root. Corroborated leaves buried under an eliminated or out-of-scope
 * ancestor do not count as survival — they were superseded by their
 * ancestor's pruning verdict and the engine would have closed as abandoned.
 */
function discriminateTerminalSessions(
  sessions: Session[],
  hypotheses: Hypothesis[],
  skipSessionIds: Set<string>,
): void {
  for (const s of sessions) {
    if (s.status !== 'resolved' && s.status !== 'abandoned') continue;
    if (skipSessionIds.has(s.id)) continue;
    const sessionHypotheses = hypotheses.filter((h) => h.sessionId === s.id);
    if (sessionHypotheses.length === 0) continue;
    s.status = subtreeContainsCorroborated(s.rootNodeId, sessionHypotheses) ? 'resolved' : 'abandoned';
  }
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

      const session = translateLegacySessionStatus(firstEntry.payload as Session);

      // Determine final status by tracking the LAST session-level event.
      // The wire identifier session-completed covers both terminal
      // transitions; resolved vs abandoned is discriminated from the
      // hypothesis state at the moment of the event (every-eliminated
      // implies abandoned, otherwise a corroborated answer drove the
      // closure). A later session-reopened wins over an earlier
      // session-completed.
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
            const h = translateLegacyVerdict(translateLegacyHypothesisStatus(entry.payload as Hypothesis));
            latestHypothesis.set(h.id, h);
          }
        } catch {
          // skip corrupt lines
        }
      }
      // Legacy files may have written a terminal status directly on the
      // session-created payload (translated from 'completed' to 'resolved'
      // above) rather than emitting a session-completed event. Either path
      // into terminal state must be discriminated by hypothesis content.
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
    const wireTerminalSet = new Set<string>();

    for (const line of lines) {
      try {
        const entry: JournalEntry = JSON.parse(line);
        replayEntry(entry, sessions, hypotheses, wireTerminalSet);
      } catch {
        // skip corrupt lines
      }
    }

    if (sessions.length === 0) return null;
    discriminateTerminalSessions(sessions, hypotheses, wireTerminalSet);
    return { session: sessions[0], hypotheses };
  } catch {
    return null;
  }
}

function replayEntry(
  entry: JournalEntry,
  sessions: Session[],
  hypotheses: Hypothesis[],
  wireTerminalSet: Set<string>,
): void {
  switch (entry.type) {
    case 'session-created': {
      const session = translateLegacySessionStatus(entry.payload as Session);
      sessions.push(session);
      break;
    }
    case 'hypothesis-added': {
      const h = translateLegacyVerdict(translateLegacyHypothesisStatus(entry.payload as Hypothesis));
      hypotheses.push(h);
      break;
    }
    case 'hypothesis-updated': {
      const updated = translateLegacyVerdict(translateLegacyHypothesisStatus(entry.payload as Hypothesis));
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
      const payload = entry.payload as { sessionId: string; terminalStatus?: 'resolved' | 'abandoned' };
      const s = sessions.find((sess) => sess.id === payload.sessionId);
      if (!s) break;
      // Replay must overwrite a previously resolved session as well. A
      // session can transition resolved → open (via session-reopened) and
      // back to a terminal status; only a session already at this exact
      // terminal status should be skipped to avoid clobbering completedAt.
      if (s.status === 'open' || s.status !== (payload.terminalStatus ?? s.status)) {
        // Newer journals carry terminalStatus on the wire event and the
        // engine had the full pruning-aware tree when it chose; the
        // post-replay discriminator must defer to this decision. Older
        // journals omit it, in which case the post-replay walker
        // reconstructs the verdict from the hypothesis tree.
        let terminal: 'resolved' | 'abandoned';
        if (payload.terminalStatus) {
          terminal = payload.terminalStatus;
          wireTerminalSet.add(payload.sessionId);
        } else {
          terminal = subtreeContainsCorroborated(s.rootNodeId, hypotheses.filter((h) => h.sessionId === payload.sessionId))
            ? 'resolved'
            : 'abandoned';
        }
        s.status = terminal;
        s.completedAt = entry.timestamp;
      } else if (payload.terminalStatus) {
        wireTerminalSet.add(payload.sessionId);
      }
      break;
    }
    case 'session-reopened': {
      const { sessionId } = entry.payload as { sessionId: string };
      const s = sessions.find((sess) => sess.id === sessionId);
      if (s) {
        s.status = 'open';
        s.completedAt = undefined;
        // Session is back open; any prior wire-terminal authority is moot
        // until a new session-completed records a fresh terminalStatus.
        wireTerminalSet.delete(sessionId);
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
