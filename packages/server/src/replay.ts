import { subtreeContainsCorroborated } from './closure.js';
import type { Evidence, Hypothesis, Session } from './types.js';

/**
 * Current journal schema version, stamped on every entry written. Bump when the
 * on-disk entry/payload shape changes incompatibly; {@link applyEntry} can then
 * branch on `entry.v` to upcast older entries. Entries with no `v` predate
 * versioning and are treated as v1.
 */
export const JOURNAL_SCHEMA_VERSION = 1;

/** A journal entry as stored on disk: a timestamped, typed, versioned payload. */
export interface JournalEntry {
  timestamp: string;
  type: string;
  payload: unknown;
  /** Schema version; absent in pre-versioning journals (treated as v1). */
  v?: number;
}

/** In-memory state rebuilt by folding journal entries. */
export interface ReplayState {
  sessions: Session[];
  hypotheses: Hypothesis[];
  /** id → index into `hypotheses`, so update/evidence events resolve a node in
   *  O(1) instead of a linear scan per event (replay is O(n) over the journal,
   *  not O(updates × nodes)). */
  hypothesisIndex: Map<string, number>;
  /** Evidence whose hypothesis has not been seen yet, keyed by hypothesisId.
   *  A legacy/hand-authored journal can order an evidence-added before the
   *  hypothesis-added that creates its target; the evidence is held here and
   *  flushed onto the node when it first appears, so order-tolerance extends to
   *  evidence and nothing is silently dropped. */
  pendingEvidence: Map<string, Evidence[]>;
}

export function emptyReplayState(): ReplayState {
  return { sessions: [], hypotheses: [], hypothesisIndex: new Map(), pendingEvidence: new Map() };
}

/**
 * The single per-event interpreter: folds one journal entry into replay state.
 * This is the one place that knows what each event type does to in-memory
 * state, shared by full replay ({@link loadSession}) and the lightweight scan
 * ({@link scanSessions}) so the two cannot drift. It is the read-side
 * counterpart to journalEventToEntry (the write side).
 *
 * Mutation, not return, mirrors the append-only log: each entry advances the
 * accumulator. Order-tolerant by design — a hypothesis-updated with no prior
 * hypothesis-added still lands the node (defensive total replay over a
 * truncated/legacy log; the writer never produces that order).
 */
export function applyEntry(state: ReplayState, entry: JournalEntry): void {
  const { sessions, hypotheses, hypothesisIndex, pendingEvidence } = state;
  // Upsert a hypothesis by id in O(1): replace in place if known, else append
  // and record its index. Shared by add (writer never re-adds an id, but upsert
  // is safe) and update (order-tolerant: an update with no prior add lands it).
  // On first appearance, any evidence buffered out-of-order ahead of the node is
  // flushed onto it (without dropping evidence the snapshot itself carries).
  const upsertHypothesis = (h: Hypothesis): void => {
    const idx = hypothesisIndex.get(h.id);
    if (idx !== undefined) {
      hypotheses[idx] = h;
    } else {
      const buffered = pendingEvidence.get(h.id);
      if (buffered) {
        h.evidence = [...h.evidence, ...buffered];
        pendingEvidence.delete(h.id);
      }
      hypothesisIndex.set(h.id, hypotheses.length);
      hypotheses.push(h);
    }
  };
  switch (entry.type) {
    case 'session-created': {
      sessions.push(entry.payload as Session);
      break;
    }
    case 'hypothesis-added':
    case 'hypothesis-updated': {
      upsertHypothesis(entry.payload as Hypothesis);
      break;
    }
    case 'evidence-added': {
      // journalEventToEntry never writes evidence-added — the hypothesis-updated
      // snapshot that follows it already carries the evidence — so this branch
      // does not fire on journals this writer produces. It is retained so a
      // legacy or hand-authored journal that does carry the event still replays
      // correctly.
      const { hypothesisId, evidence } = entry.payload as { hypothesisId: string; evidence: Evidence };
      const idx = hypothesisIndex.get(hypothesisId);
      if (idx !== undefined) {
        hypotheses[idx].evidence.push(evidence);
      } else {
        // Hypothesis not seen yet (out-of-order legacy journal): buffer until it
        // appears rather than dropping the evidence.
        const buf = pendingEvidence.get(hypothesisId);
        if (buf) buf.push(evidence);
        else pendingEvidence.set(hypothesisId, [evidence]);
      }
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

/**
 * Projects the index status of a fully-folded session for the lightweight scan.
 *
 * `loadSession` returns the verbatim folded status (set directly by
 * applyEntry's session-completed/reopened). The scan needs a richer rule: when
 * a session reached a terminal state WITHOUT an explicit `terminalStatus` on
 * the wire (a legacy journal, or a hand-authored created-terminal session), it
 * discriminates resolved-vs-abandoned by a pruning-aware spine walk — only a
 * corroborated hypothesis on a non-pruned lineage counts as survival, matching
 * the engine's closure choice.
 *
 * @param sawExplicitTerminal whether any session-completed entry carried a terminalStatus
 */
export function deriveScanStatus(
  session: Session,
  hypotheses: Hypothesis[],
  sawExplicitTerminal: boolean,
): 'open' | 'resolved' | 'abandoned' {
  if (session.status === 'open') return 'open';
  if (sawExplicitTerminal && (session.status === 'resolved' || session.status === 'abandoned')) {
    return session.status;
  }
  const byId = new Map(hypotheses.map((h) => [h.id, h]));
  const hasCorroborated = subtreeContainsCorroborated(session.rootNodeId, (id) => byId.get(id));
  return hasCorroborated ? 'resolved' : 'abandoned';
}
