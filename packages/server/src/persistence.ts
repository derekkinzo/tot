import { open } from 'node:fs/promises';
import {
  closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureStoreDir } from './storage-paths.js';
import {
  applyEntry, deriveScanStatus, emptyReplayState, foldedSession, JOURNAL_SCHEMA_VERSION,
  type JournalEntry, type ReplayState,
} from './replay.js';
import type { Hypothesis, Session, TreeEvent } from './types.js';

// ─── Session Index (lightweight metadata for lazy loading) ───

export interface SessionIndex {
  id: string;
  problem: string;
  status: 'open' | 'resolved' | 'abandoned';
  createdAt: string;
  filePath: string;
  /** Hypotheses reconstructed by folding the file. */
  nodeCount: number;
  /**
   * Lines of the journal that could not be folded, so the tree is narrower than
   * what was recorded. Carried on the index because a partial fold is otherwise
   * indistinguishable from a complete one: what replays is a smaller, entirely
   * plausible tree, and a reader who is not told cannot know to doubt it.
   */
  unreadableLines: number;
}

export class Persistence {
  private filePath: string;
  private onError?: (err: Error) => void;
  private onRecovered?: () => void;

  constructor(
    dataDir: string,
    sessionId: string,
    onError?: (err: Error) => void,
    onRecovered?: () => void,
  ) {
    ensureStoreDir(dataDir);
    this.filePath = join(dataDir, `${sessionId}.jsonl`);
    this.onError = onError;
    this.onRecovered = onRecovered;
  }

  async append(type: string, payload: unknown): Promise<void> {
    const entry: JournalEntry = {
      v: JOURNAL_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    // A newline ahead of the record when the file ends mid-record: an append can
    // write some of its bytes and then fail, and the partial record it leaves
    // behind has no terminator. Appending straight onto those bytes would splice
    // the two records into one unparseable line and lose BOTH — including this
    // one, which the caller would still be told was written, because this append
    // itself succeeds. Closing the partial record first confines the damage to
    // the record that actually failed. Readers drop the resulting blank line.
    //
    // Read from the file each time rather than remembered from the last append,
    // because this journal is shared: a peer holding the same session can leave a
    // partial record at any point, and a flag set from what THIS writer last did
    // says nothing about that.
    const line = (endsMidRecord(this.filePath) ? '\n' : '') + JSON.stringify(entry) + '\n';
    try {
      // Written through a handle so the bytes can be flushed to the device before
      // this resolves. `appendFile` alone returns once the kernel holds them,
      // which survives the process dying but not the machine doing so, and the
      // caller is told the mutation was saved either way. The sync closes that
      // gap, so an acknowledgement means the same thing in both cases. Awaited in
      // this order: a sync that this does not wait for, or that runs before the
      // write, leaves the same gap while looking closed.
      const handle = await open(this.filePath, 'a');
      try {
        await handle.appendFile(line);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      // Idempotent, and fired on every success rather than on a transition: a
      // writer that has recovered cannot know whether anyone was told it failed.
      this.onRecovered?.();
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
 * Whether a journal's last byte is something other than a record terminator.
 *
 * True of a file left mid-record by a write that failed part-way, whichever
 * process was writing — so a session resumed after a crash does not append onto
 * a partial record. Reads one byte rather than the file, which can be large.
 * False when the file does not exist yet, or cannot be read: an append onto it
 * will fail on its own terms and report that.
 */
function endsMidRecord(filePath: string): boolean {
  let fd: number | undefined;
  try {
    const { size } = statSync(filePath);
    if (size === 0) return false;
    fd = openSync(filePath, 'r');
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Picks the "active" entry from a set of sessions: the most recently created
 * open one, falling back to the most recent overall; undefined when empty.
 *
 * Generic over anything carrying a status + createdAt, so the scan of what is on
 * disk ({@link SessionIndex}) and the engine's own resolution
 * ({@link TreeManager.getDefaultSession}, which every read surface goes through)
 * share one definition of "which session is current" — a boot that loads one
 * session and a read that answers about another describe different trees.
 */
export function pickActiveSession<T extends { status: string; createdAt: string }>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  const sorted = [...items].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return sorted.find((s) => s.status === 'open') ?? sorted[0];
}

/** The journals of a store, in directory order; empty when there is no store. */
function journalPaths(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  try {
    return readdirSync(dataDir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dataDir, f));
  } catch {
    return [];
  }
}

/**
 * Folds one journal into its index entry, or undefined when the file describes no
 * session. Throws only what reading the file itself throws.
 */
function foldIndexEntry(filePath: string): SessionIndex | undefined {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return undefined;

  const state = emptyReplayState();
  let skipped = 0;
  for (const line of lines) {
    try {
      applyEntry(state, JSON.parse(line) as JournalEntry);
    } catch {
      skipped++; // keep folding the rest
    }
  }

  const session = foldedSession(state);
  if (!session) return undefined; // nothing describing a session → not a session file
  warnIfFromNewerWriter(state, filePath);
  warnIfLinesSkipped(skipped, lines.length, filePath);

  return {
    id: session.id,
    problem: session.problem,
    status: deriveScanStatus(session, state.hypotheses, state.sawExplicitTerminal),
    createdAt: session.createdAt,
    filePath,
    nodeCount: state.hypotheses.length,
    unreadableLines: skipped,
  };
}

/**
 * Scans session files and returns lightweight metadata. Folds every line
 * through the shared {@link applyEntry} reducer (so scan and full replay agree
 * by construction), then projects the index status via {@link deriveScanStatus}.
 * Corrupt lines are skipped rather than discarding an otherwise-recoverable file.
 */
export function scanSessions(dataDir: string): SessionIndex[] {
  const index: SessionIndex[] = [];
  for (const filePath of journalPaths(dataDir)) {
    try {
      const entry = foldIndexEntry(filePath);
      if (entry) index.push(entry);
    } catch (err) {
      // A file that cannot be read at all has no session to list, so the only
      // thing that can be said about it is that it was there and was skipped.
      console.error(`[tot-mcp] Warning: skipped unreadable session file ${filePath}: ${err}`);
    }
  }
  return index;
}

/** What a folded journal was folded from, so an unchanged one is not folded twice. */
interface CachedEntry {
  size: number;
  mtimeMs: number;
  /** Absent for a file that holds no session, so that answer is cached too. */
  entry?: SessionIndex;
}

/**
 * A repeatable scan of one store that re-folds only the journals whose bytes
 * changed.
 *
 * The store is re-read on every enumeration, because a peer process can add to it
 * at any time — but a fold costs a read and a parse of the whole file, and these
 * files grow without bound while their content stops changing. On a store of a
 * few megabytes an ungated re-fold is tens to hundreds of milliseconds of
 * blocking work, paid on a timer by every open dashboard and again by every
 * status read, almost always to produce the answer already in hand.
 *
 * Size and modification time decide: the journal is append-only, so any record
 * that reaches it moves the size, and a rewrite that somehow preserved the size
 * still moves the mtime. A file whose size and mtime both stand is byte-identical
 * to the one already folded.
 *
 * Scoped to one caller, which keeps the cache out of {@link scanSessions} — the
 * one-shot read stays a pure function of the directory.
 */
export function makeSessionScanner(dataDir: string): () => SessionIndex[] {
  const cache = new Map<string, CachedEntry>();

  return () => {
    const index: SessionIndex[] = [];
    const seen = new Set<string>();

    for (const filePath of journalPaths(dataDir)) {
      seen.add(filePath);
      try {
        const { size, mtimeMs } = statSync(filePath);
        const cached = cache.get(filePath);
        if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
          if (cached.entry) index.push(cached.entry);
          continue;
        }
        const entry = foldIndexEntry(filePath);
        cache.set(filePath, { size, mtimeMs, ...(entry ? { entry } : {}) });
        if (entry) index.push(entry);
      } catch (err) {
        // Not cached: a file that could not be read may be readable next time, and
        // caching the failure would keep reporting it after the cause is gone.
        cache.delete(filePath);
        console.error(`[tot-mcp] Warning: skipped unreadable session file ${filePath}: ${err}`);
      }
    }

    for (const filePath of cache.keys()) {
      if (!seen.has(filePath)) cache.delete(filePath);
    }
    return index;
  };
}

/**
 * Loads a single session file by replaying all its events.
 * Returns the session and its hypotheses fully reconstructed, with a count of
 * the lines that could not be folded — see {@link SessionIndex.unreadableLines}.
 */
export function loadSession(
  filePath: string,
): { session: Session; hypotheses: Hypothesis[]; unreadableLines: number } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    const state = emptyReplayState();
    let skipped = 0;
    for (const line of lines) {
      try {
        applyEntry(state, JSON.parse(line) as JournalEntry);
      } catch {
        skipped++; // keep folding the rest
      }
    }

    // Derived the same way the index derives it. Handing back the folded status
    // would have the session list and the loaded session state different terminal
    // verdicts for the same bytes.
    const session = foldedSession(state);
    if (!session) return null;
    warnIfFromNewerWriter(state, filePath);
    warnIfLinesSkipped(skipped, lines.length, filePath);
    return {
      session: {
        ...session,
        status: deriveScanStatus(session, state.hypotheses, state.sawExplicitTerminal),
      },
      hypotheses: state.hypotheses,
      unreadableLines: skipped,
    };
  } catch {
    return null;
  }
}

/**
 * Says so when a journal was written by a newer build than this one.
 *
 * Such a file can carry fields this reader drops on the way in, so folding it
 * without a word would leave the reader believing it had the whole tree. Nothing
 * is refused: the entries still fold, because a partial view of a session beats
 * no view of it.
 */
function warnIfFromNewerWriter(state: ReplayState, filePath: string): void {
  if (!state.sawNewerWriter) return;
  console.error(
    `[tot-mcp] Warning: ${filePath} was written by a newer version of tot-mcp ` +
    `(journal schema above v${JOURNAL_SCHEMA_VERSION}). It has been read as far as this ` +
    'build understands it; anything newer was left out. Upgrade to see the whole session.',
  );
}

/**
 * Says so when lines of a journal could not be read.
 *
 * A skipped line is a record that is simply gone: an eliminated branch that
 * reads as still open, evidence that no longer appears under the hypothesis it
 * was filed against. The tree still renders, which is the danger — it renders as
 * a smaller but entirely plausible tree, with nothing to distinguish it from the
 * whole one. Saying how many records were lost is what lets a reader tell.
 */
function warnIfLinesSkipped(skipped: number, total: number, filePath: string): void {
  if (skipped === 0) return;
  console.error(
    `[tot-mcp] Warning: ${skipped} of ${total} records in ${filePath} could not be read ` +
    'and were left out. The session is shown without them, so it may be missing nodes, ' +
    'evidence, or verdicts it once had.',
  );
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
      return {
        sessionId: event.hypothesis.sessionId,
        type: event.type,
        payload: persistedHypothesis(event.hypothesis),
      };
    case 'session-completed':
      return { sessionId: event.sessionId, type: event.type, payload: { sessionId: event.sessionId, terminalStatus: event.terminalStatus } };
    case 'session-reopened':
      return { sessionId: event.sessionId, type: event.type, payload: { sessionId: event.sessionId } };
    case 'evidence-added':
    case 'snapshot':
      return null;
  }
}

/**
 * The on-disk shape of a hypothesis: the in-memory node plus a single prose
 * field.
 *
 * Central storage is shared by every build that opens it, and a reader that
 * knows only one prose field has to find one. Projecting it here — at the only
 * write site — serves that reader without holding a second copy of the prose in
 * memory, where it could drift from the fields it came from.
 * {@link normalizeHypothesisPayload} strips it again on read.
 */
function persistedHypothesis(h: Hypothesis): Hypothesis & { content: string } {
  return { ...h, content: h.statement ?? h.title };
}
