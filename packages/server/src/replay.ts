import { subtreeContainsCorroborated } from './closure.js';
import {
  normalizeEvidenceRecord, normalizeHypothesisPayload, normalizeSessionPayload,
  terminalSessionStatus,
} from '@tot-mcp/shared';
import type { Evidence, Hypothesis, Session } from './types.js';

/**
 * Current journal schema version, stamped on every entry written.
 *
 * Field defaulting is deliberately NOT keyed on this: {@link applyEntry} pipes
 * every hypothesis payload through {@link normalizeHypothesisPayload}, which
 * defaults each field from its own absence. Writers that ship at different times
 * all stamp the version current for them while omitting fields added later, so a
 * version-keyed branch would not fire on them.
 *
 * The version's remaining use is detecting a file written by a NEWER build than
 * the reader, which is reported rather than folded silently.
 */
export const JOURNAL_SCHEMA_VERSION = 2;

/** True when an entry was written by a build newer than this one. Entries with
 *  no `v` predate versioning and are older, never newer. */
export function isFromNewerWriter(entry: JournalEntry): boolean {
  return (entry.v ?? 1) > JOURNAL_SCHEMA_VERSION;
}

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
  /** Whether any entry was stamped by a build newer than this one, so a reader
   *  can say that fields it does not know about were dropped on the way in. */
  sawNewerWriter: boolean;
  /** Whether a completion named a terminal state this build recognises. A value
   *  it cannot read carries no verdict, so the closure walk decides instead of
   *  the fold — tracked here so every reader asks the same question. */
  sawExplicitTerminal: boolean;
}

export function emptyReplayState(): ReplayState {
  return {
    sessions: [], hypotheses: [], hypothesisIndex: new Map(),
    pendingEvidence: new Map(), sawNewerWriter: false, sawExplicitTerminal: false,
  };
}

/**
 * Merges a hypothesis' child list, keeping ids the incoming snapshot omits.
 *
 * `children` and `evidence` only ever grow — the engine pushes and nothing
 * removes — so an entry a snapshot does not carry means its writer had not seen
 * that entry, never that the entry was deleted. Substituting the collection
 * wholesale therefore loses whatever a concurrent writer recorded, and the loss
 * is silent and structural: the dropped children still name the parent, but the
 * parent no longer names them, so they are unreachable from the root and every
 * closure walk steps straight past them. A session can then report itself fully
 * resolved with real branches never examined. For a single writer the merge and
 * a substitution agree, so a journal written by one process folds identically.
 */
function mergedChildren(prior: string[], next: string[]): string[] {
  return [...prior, ...next.filter((id) => !prior.includes(id))];
}

/**
 * Merges a hypothesis' evidence, matching records by id.
 *
 * Same append-only reasoning as {@link mergedChildren}, with one difference:
 * qualifiers are applied to a record in place, so a record the snapshot carries
 * is the newer of the two and wins. A record with no id cannot be matched
 * against anything and is always kept, rather than folding every such record
 * onto one entry.
 */
function mergedEvidence(prior: Evidence[], next: Evidence[]): Evidence[] {
  const incoming = new Map(next.filter((e) => e.id).map((e) => [e.id, e]));
  const priorIds = new Set(prior.map((e) => e.id).filter(Boolean));
  return [
    ...prior.map((e) => incoming.get(e.id) ?? e),
    ...next.filter((e) => !e.id || !priorIds.has(e.id)),
  ];
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
  if (isFromNewerWriter(entry)) state.sawNewerWriter = true;
  // Upsert a hypothesis by id in O(1): fold onto the known node if there is one,
  // else append and record its index. Shared by add (writer never re-adds an id,
  // but upsert is safe) and update (order-tolerant: an update with no prior add
  // lands it). A snapshot's scalar fields win outright; its append-only
  // collections are merged rather than substituted — see {@link mergedChildren}.
  // On first appearance, any evidence buffered out-of-order ahead of the node is
  // flushed onto it (without dropping evidence the snapshot itself carries).
  const upsertHypothesis = (h: Hypothesis): void => {
    const idx = hypothesisIndex.get(h.id);
    if (idx !== undefined) {
      const prior = hypotheses[idx];
      hypotheses[idx] = {
        ...h,
        children: mergedChildren(prior.children, h.children),
        evidence: mergedEvidence(prior.evidence, h.evidence),
      };
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
      sessions.push(normalizeSessionPayload(entry.payload));
      break;
    }
    case 'hypothesis-added':
    case 'hypothesis-updated': {
      upsertHypothesis(normalizeHypothesisPayload(entry.payload));
      break;
    }
    case 'evidence-added': {
      // journalEventToEntry never writes evidence-added — the hypothesis-updated
      // snapshot that follows it already carries the evidence — so this branch
      // does not fire on journals this writer produces. It is retained so a
      // legacy or hand-authored journal that does carry the event still replays
      // correctly.
      const { hypothesisId, evidence: raw } = entry.payload as { hypothesisId: string; evidence: unknown };
      // Normalized on the same terms as a snapshot's records, so a required
      // field does not depend on which event carried it.
      const evidence = normalizeEvidenceRecord(raw);
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
      const payload = entry.payload as { sessionId: string; terminalStatus?: unknown };
      const s = sessions.find((sess) => sess.id === payload.sessionId);
      if (!s) break;
      // A journal can carry a completion with no terminalStatus, or one this build
      // cannot read. Either way the entry names no verdict, so the fold marks the
      // session terminal in the way that claims least — no survival — and records
      // that it was not told which. {@link deriveScanStatus} then decides from the
      // spine, which is the only thing that knows whether anything survived.
      const named = terminalSessionStatus(payload.terminalStatus);
      if (named !== null) state.sawExplicitTerminal = true;
      s.status = named ?? 'abandoned';
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
 * The session a folded journal describes, filling in from the root node whatever
 * the header entry did not carry.
 *
 * The header is one line among many, and taking it as the only account of the
 * session makes the whole file hostage to it: no session means no index entry
 * and nothing to load, leaving every node in the journal unreachable, while a
 * header that parses but arrives incomplete is worse still — its missing fields
 * travel as far as the surfaces that render them.
 *
 * The root node is a second record of the same facts, written in the same
 * moment: it names its session, is itself the root, carries that timestamp, and
 * was built from the problem statement. So it can stand in for a header that is
 * absent or partial. The recorded header still wins where it has a value — it
 * holds the problem verbatim, where the root's copy may have been split into a
 * label and a statement — and the status is only ever the header's to give, so a
 * reconstructed session starts open and {@link deriveScanStatus} settles it from
 * the spine, exactly as for a journal that recorded no terminal status.
 *
 * Returns undefined when the result would have no id: a session that cannot be
 * addressed cannot be listed or opened, and passing one on only moves the
 * failure to whichever surface reads it first.
 */
export function foldedSession(state: ReplayState): Session | undefined {
  const recorded: Partial<Session> | undefined = state.sessions[0];
  const root = state.hypotheses.find((h) => h.parentId === null);
  if (!root) {
    // No node to recover from, so the header is all there is: an id is the one
    // field nothing can stand in for, and a missing problem reads as unstated.
    if (recorded?.id === undefined) return undefined;
    return { ...recorded, id: recorded.id, problem: recorded.problem ?? '' } as Session;
  }

  const fromRoot: Session = {
    id: root.sessionId,
    problem: root.statement ?? root.title,
    rootNodeId: root.id,
    status: 'open',
    createdAt: root.metadata.createdAt,
  };
  if (!recorded) return fromRoot;
  return {
    ...fromRoot,
    ...recorded,
    id: recorded.id ?? fromRoot.id,
    problem: recorded.problem ?? fromRoot.problem,
    rootNodeId: recorded.rootNodeId ?? fromRoot.rootNodeId,
    createdAt: recorded.createdAt ?? fromRoot.createdAt,
  };
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
