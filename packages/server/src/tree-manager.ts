import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { isPruned, isTerminal, subtreeContainsCorroborated, topLevelBranchesDisposed } from './closure.js';
import type {
  Evidence,
  Hypothesis,
  HypothesisStatus,
  Session,
  StructuralCheck,
  TreeEvent,
  TreeState,
} from './types.js';
import { STAGNATION_THRESHOLD_DEFAULT, MAX_DEPTH_DEFAULT, MAX_HYPOTHESES_DEFAULT } from './defaults.js';

export class TreeManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private hypotheses = new Map<string, Hypothesis>();
  private sessionHypotheses = new Map<string, Set<string>>();
  private currentSessionId: string | null = null;
  // Stagnation is tracked per session: one TreeManager can hold several
  // concurrently-open trees, and each session's "mutations since last status
  // change" must not leak into another's stagnation verdict.
  private mutationsSinceStatusChange = new Map<string, number>();
  private stagnationThreshold: number;
  private maxDepth: number;
  private maxHypotheses: number;
  private lastInteractionTime = Date.now();

  constructor(opts?: { stagnationThreshold?: number; maxDepth?: number; maxHypotheses?: number }) {
    super();
    this.stagnationThreshold = opts?.stagnationThreshold ?? STAGNATION_THRESHOLD_DEFAULT;
    this.maxDepth = opts?.maxDepth ?? MAX_DEPTH_DEFAULT;
    this.maxHypotheses = opts?.maxHypotheses ?? MAX_HYPOTHESES_DEFAULT;
  }

  /**
   * Creates a new reasoning session with a root hypothesis node.
   * @param problem - The problem statement to investigate
   * @returns The new session and its root hypothesis node
   * @throws TreeError if problem is empty/whitespace
   */
  createSession(problem: string): { session: Session; root: Hypothesis } {
    if (!problem.trim()) {
      throw new TreeError('Problem statement cannot be empty');
    }

    const sessionId = uuid();
    const rootId = uuid();
    const now = new Date().toISOString();

    const session: Session = {
      id: sessionId,
      problem,
      rootNodeId: rootId,
      status: 'open',
      createdAt: now,
    };

    const root: Hypothesis = {
      id: rootId,
      parentId: null,
      sessionId,
      depth: 0,
      content: problem,
      status: 'pending',
      evidence: [],
      metadata: { createdAt: now, updatedAt: now, source: 'agent' },
      children: [],
    };

    this.sessions.set(sessionId, session);
    this.hypotheses.set(rootId, root);
    this.sessionHypotheses.set(sessionId, new Set([rootId]));
    this.resetMutationCounter(sessionId);

    this.emit('event', { type: 'session-created', session } satisfies TreeEvent);
    this.emit('event', { type: 'hypothesis-added', hypothesis: root } satisfies TreeEvent);
    this.setCurrent(sessionId);

    return { session, root };
  }

  /**
   * Decomposes a hypothesis into sibling sub-hypotheses, creating child nodes.
   * Aim for non-overlapping siblings that collectively cover the parent's
   * claim — strict mutual exclusivity is not required (Heuer 2005).
   * Auto-transitions the parent from 'pending' to 'exploring'.
   * @param parentId - ID of the hypothesis to decompose
   * @param childContents - Array of sub-hypothesis descriptions (2+)
   * @returns The created child hypothesis nodes
   * @throws TreeError if parent is in a terminal status, fewer than 2 children, depth exceeded, or count exceeded
   */
  decompose(parentId: string, childContents: string[]): Hypothesis[] {
    const parent = this.getHypothesisOrThrow(parentId);

    this.assertSessionOpen(parent.sessionId, 'decompose');
    if (isTerminal(parent.status)) {
      throw new TreeError(`Cannot decompose a ${parent.status} hypothesis`);
    }
    if (childContents.length < 2) {
      throw new TreeError('Decomposition requires at least 2 sub-hypotheses');
    }
    if (parent.depth + 1 > this.maxDepth) {
      throw new TreeError(`Tree depth limit (${this.maxDepth}) exceeded`);
    }
    // The cap is per tree, not per process: count only the parent's session,
    // so a large historical session co-loaded in this manager cannot block a
    // small new one.
    const sessionSize = this.sessionHypotheses.get(parent.sessionId)?.size ?? 0;
    if (sessionSize + childContents.length > this.maxHypotheses) {
      throw new TreeError(`Maximum hypothesis count (${this.maxHypotheses}) exceeded`);
    }

    const now = new Date().toISOString();
    const children: Hypothesis[] = childContents.map((content) => ({
      id: uuid(),
      parentId: parent.id,
      sessionId: parent.sessionId,
      depth: parent.depth + 1,
      content,
      status: 'pending' as const,
      evidence: [],
      metadata: { createdAt: now, updatedAt: now, source: 'agent' as const },
      children: [],
    }));

    const sessionSet = this.sessionHypotheses.get(parent.sessionId);
    for (const child of children) {
      this.hypotheses.set(child.id, child);
      parent.children.push(child.id);
      sessionSet?.add(child.id);
      this.emit('event', { type: 'hypothesis-added', hypothesis: child } satisfies TreeEvent);
    }

    parent.metadata.updatedAt = now;

    if (parent.status === 'pending') {
      parent.status = 'exploring';
      this.resetMutationCounter(parent.sessionId);
    } else {
      this.incrementMutationCounter(parent.sessionId);
    }

    this.emit('event', { type: 'hypothesis-updated', hypothesis: parent } satisfies TreeEvent);
    this.setCurrent(parent.sessionId);
    return children;
  }

  /**
   * Adds a single hypothesis as a child of an existing node.
   * Use when a sibling-level decomposition is missing a possibility.
   * @param parentId - ID of the parent hypothesis
   * @param content - Description of the new hypothesis
   * @returns The newly created hypothesis
   * @throws TreeError if parent is in a terminal status, depth exceeded, or count exceeded
   */
  addHypothesis(parentId: string, content: string): Hypothesis {
    const parent = this.getHypothesisOrThrow(parentId);

    this.assertSessionOpen(parent.sessionId, 'add a hypothesis');
    // Mirror decompose's terminal-parent guard. Without this, a new pending
    // child can appear under a terminal ancestor, leaving structural debt
    // that the closure predicate would silently overlook.
    if (isTerminal(parent.status)) {
      throw new TreeError(`Cannot add hypothesis to a ${parent.status} node`);
    }
    if (parent.depth + 1 > this.maxDepth) {
      throw new TreeError(`Tree depth limit (${this.maxDepth}) exceeded`);
    }
    // Per-tree cap (see decompose): meter only the parent's session.
    const sessionSize = this.sessionHypotheses.get(parent.sessionId)?.size ?? 0;
    if (sessionSize + 1 > this.maxHypotheses) {
      throw new TreeError(`Maximum hypothesis count (${this.maxHypotheses}) exceeded`);
    }

    const now = new Date().toISOString();
    const hypothesis: Hypothesis = {
      id: uuid(),
      parentId: parent.id,
      sessionId: parent.sessionId,
      depth: parent.depth + 1,
      content,
      status: 'pending',
      evidence: [],
      metadata: { createdAt: now, updatedAt: now, source: 'agent' },
      children: [],
    };

    this.hypotheses.set(hypothesis.id, hypothesis);
    this.sessionHypotheses.get(parent.sessionId)?.add(hypothesis.id);
    parent.children.push(hypothesis.id);
    parent.metadata.updatedAt = now;
    this.incrementMutationCounter(parent.sessionId);

    this.emit('event', { type: 'hypothesis-added', hypothesis } satisfies TreeEvent);
    this.emit('event', { type: 'hypothesis-updated', hypothesis: parent } satisfies TreeEvent);
    this.setCurrent(parent.sessionId);
    return hypothesis;
  }

  /**
   * Attaches evidence to a hypothesis. Auto-transitions 'pending' to
   * 'exploring'. A refute against a corroborated hypothesis demotes it to
   * 'exploring', cascades up corroborated ancestors (also demoted), and
   * reopens the session if it was terminal.
   * @param hypothesisId - ID of the target hypothesis
   * @param type - Relationship of evidence to the hypothesis
   * @param content - Description of the evidence
   * @param source - Optional provenance
   * @returns The created evidence record plus the cascade-demoted ancestors
   *   so callers can journal each ancestor's hypothesis-updated entry.
   * @throws TreeError if hypothesis is eliminated/out-of-scope, or if
   *   supports/neutral evidence is added to a corroborated leaf.
   */
  addEvidence(
    hypothesisId: string,
    type: 'supports' | 'refutes' | 'neutral',
    content: string,
    source?: string,
  ): { evidence: Evidence; demotedAncestors: Hypothesis[] } {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);

    if (isPruned(hypothesis.status)) {
      throw new TreeError(`Cannot add evidence to a ${hypothesis.status} hypothesis`);
    }
    // Corroboration is provisional: a refuting observation may legitimately
    // arrive later and reopen the verdict. Only refutes is admitted on a
    // corroborated leaf — supports/neutral on a settled verdict would be
    // accumulating positive evidence, the satisficing trap Popper rejects.
    if (hypothesis.status === 'corroborated' && type !== 'refutes') {
      throw new TreeError('Only refuting evidence is admitted on a corroborated hypothesis');
    }
    // A closed session accepts no new evidence EXCEPT a refute on a corroborated
    // branch, which is the sanctioned way to reopen it (handled below). Any other
    // evidence on a leaked pending/exploring descendant of a pruned branch would
    // mutate a completed investigation without re-running closure.
    if (!(type === 'refutes' && hypothesis.status === 'corroborated')) {
      this.assertSessionOpen(hypothesis.sessionId, 'add evidence');
    }

    const now = new Date().toISOString();
    const evidence: Evidence = {
      id: uuid(),
      type,
      content,
      source,
      timestamp: now,
    };

    hypothesis.evidence.push(evidence);
    hypothesis.metadata.updatedAt = now;

    // A refute against a corroborated hypothesis demotes it to 'exploring'
    // (the historical conclusion stays in the audit trail) and, when the
    // session was terminal, reopens it. Both terminal states reflect a
    // claimed closure that fresh refutation challenges. The demotion
    // cascades up corroborated ancestors because corroboration's contract
    // requires every direct child to be terminal — once a descendant
    // becomes non-terminal, the ancestor's verdict is no longer earned.
    const session = this.sessions.get(hypothesis.sessionId);
    const demotesCorroborated = type === 'refutes' && hypothesis.status === 'corroborated';
    const reopensSession = demotesCorroborated && session !== undefined && session.status !== 'open';

    if (hypothesis.status === 'pending' || demotesCorroborated) {
      hypothesis.status = 'exploring';
      this.resetMutationCounter(hypothesis.sessionId);
    } else {
      this.incrementMutationCounter(hypothesis.sessionId);
    }
    // Mark the historical conclusion as superseded by the direct refute
    // so renderers can distinguish it from a cascade demote. The guard
    // covers loadState's reload path, which copies hypotheses straight
    // from the journal without engine-API validation.
    if (demotesCorroborated && hypothesis.conclusion) {
      hypothesis.conclusion.supersededBy = 'self';
    }

    this.emit('event', { type: 'evidence-added', hypothesisId, evidence } satisfies TreeEvent);
    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);

    // Reopen the session BEFORE the cascade fires so ancestor demotions
    // emitted by the cascade are observed under an open session. (The
    // direct target's hypothesis-updated above precedes session-reopened
    // and is part of the same logical event.)
    if (reopensSession) {
      session.status = 'open';
      session.completedAt = undefined;
      this.emit('event', { type: 'session-reopened', sessionId: session.id } satisfies TreeEvent);
    }

    const demotedAncestors = demotesCorroborated
      ? this.demoteCorroboratedAncestors(hypothesis, now)
      : [];

    this.setCurrent(hypothesis.sessionId);

    return { evidence, demotedAncestors };
  }

  /**
   * Marks a hypothesis as eliminated (dead end), grounded in refuting
   * evidence. Per Popper, elimination is the operational form of
   * falsification (modus tollens) — a counter-instance must exist on the
   * hypothesis's evidence ledger.
   *
   * @param hypothesisId - ID of the hypothesis to eliminate
   * @param reason - Justification for elimination (creates audit trail)
   * @param refutingEvidenceIds - Optional explicit refutes-typed evidence
   *   ids that ground the verdict. When omitted, the call binds implicitly
   *   to every refutes-typed record on the target.
   * @returns The updated hypothesis
   * @throws TreeError if already terminal, or no refuting record exists
   */
  eliminateHypothesis(hypothesisId: string, reason: string, refutingEvidenceIds?: string[]): Hypothesis {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);

    this.assertSessionOpen(hypothesis.sessionId, 'eliminate a hypothesis');
    if (isTerminal(hypothesis.status)) {
      const message = hypothesis.status === 'eliminated'
        ? 'Hypothesis is already eliminated'
        : `Cannot eliminate a ${hypothesis.status} hypothesis`;
      throw new TreeError(message);
    }

    const refutesOnTarget = hypothesis.evidence.filter((e) => e.type === 'refutes');
    let groundedIds: string[];
    if (refutingEvidenceIds && refutingEvidenceIds.length > 0) {
      const refutesIds = new Set(refutesOnTarget.map((e) => e.id));
      for (const id of refutingEvidenceIds) {
        if (!refutesIds.has(id)) {
          throw new TreeError(`Evidence id ${id} is not a refutes-typed record on this hypothesis`);
        }
      }
      groundedIds = refutingEvidenceIds;
    } else {
      if (refutesOnTarget.length === 0) {
        throw new TreeError(
          'Cannot eliminate without recorded refuting evidence — call add_evidence(type=refutes) first, or use set_out_of_scope to mark this branch uninvestigated',
        );
      }
      groundedIds = refutesOnTarget.map((e) => e.id);
    }

    const now = new Date().toISOString();
    hypothesis.status = 'eliminated';
    hypothesis.conclusion = { verdict: 'eliminated', reason, timestamp: now, refutingEvidenceIds: groundedIds };
    hypothesis.metadata.updatedAt = now;
    this.resetMutationCounter(hypothesis.sessionId);

    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);

    // An elimination can complete the disposition of the last open top-level
    // branch. tryCloseSession decides resolved vs abandoned based on whether
    // a corroborated answer survives on a non-pruned lineage.
    const session = this.sessions.get(hypothesis.sessionId);
    if (session && session.status === 'open') {
      this.tryCloseSession(session, now);
    }

    // Eliminating a hypothesis is pruning, not investigative progress, so
    // currentSessionId is not promoted to this session unless it was already
    // current and we just closed it (handled above).
    return hypothesis;
  }

  /**
   * Marks a hypothesis as corroborated (provisionally retained — survived
   * available refutation attempts). Per Popper, corroboration never amounts
   * to verification; the verdict remains revisable by later refuting
   * evidence. Resolves the session under the current closure rule.
   * @param hypothesisId - ID of the hypothesis to corroborate
   * @param reason - Justification for corroboration
   * @returns The updated hypothesis
   * @throws TreeError if already corroborated, eliminated, or any child is unresolved
   */
  corroborateHypothesis(hypothesisId: string, reason: string): Hypothesis {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);

    this.assertSessionOpen(hypothesis.sessionId, 'corroborate');
    if (isTerminal(hypothesis.status)) {
      const message = hypothesis.status === 'corroborated'
        ? 'Hypothesis is already corroborated'
        : `Cannot corroborate a ${hypothesis.status} hypothesis`;
      throw new TreeError(message);
    }

    // Decomposition is a structural commitment: the parent's truth is
    // determined by the resolution of its children. Direct children must
    // be terminal; pending grandchildren are tolerated when they hide
    // under a pruned intermediate (elimination does not cascade, so the
    // hidden work is moot under the closure rule and stays moot here).
    for (const childId of hypothesis.children) {
      const child = this.hypotheses.get(childId);
      // A child id present in the array but absent from the Map signals an
      // incompletely-loaded subtree (e.g. a corrupt/skipped journal line); fail
      // closed rather than treating the missing branch as satisfied.
      if (!child || !isTerminal(child.status)) {
        throw new TreeError('Cannot corroborate a hypothesis with unresolved or missing children');
      }
    }

    const now = new Date().toISOString();
    hypothesis.status = 'corroborated';
    hypothesis.conclusion = { verdict: 'corroborated', reason, timestamp: now };
    hypothesis.metadata.updatedAt = now;
    this.resetMutationCounter(hypothesis.sessionId);

    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);

    // Resolution does not follow a single corroboration. Per Mackie INUS, a
    // corroborated leaf may be one of several co-instantiated contributors;
    // per Popper, untested siblings cannot be discarded by association. The
    // session resolves only when every other top-level branch is terminal.
    const session = this.sessions.get(hypothesis.sessionId);
    if (session && session.status === 'open' && this.tryCloseSession(session, now)) {
      // closed
    } else {
      this.setCurrent(hypothesis.sessionId);
    }

    return hypothesis;
  }

  /**
   * Marks a hypothesis as out-of-scope: terminal but no refutation claimed.
   * Use to set aside a branch without investigating it. Distinct from
   * elimination, which asserts a refuting record. Closure treats both as
   * pruning.
   * @throws TreeError if hypothesis is already terminal
   */
  setOutOfScope(hypothesisId: string, reason: string): Hypothesis {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);
    this.assertSessionOpen(hypothesis.sessionId, 'set a hypothesis out-of-scope');
    if (isTerminal(hypothesis.status)) {
      throw new TreeError(`Cannot set out-of-scope a ${hypothesis.status} hypothesis`);
    }
    // The root carries the session's problem statement; setting it
    // out-of-scope would abandon the entire investigation by fiat without
    // touching live work below it. To abandon a session, dispose of every
    // top-level branch — closure infers abandonment from the absence of a
    // surviving answer.
    if (hypothesis.parentId === null) {
      throw new TreeError('Cannot set the root hypothesis out-of-scope; dispose of every top-level branch instead');
    }

    const now = new Date().toISOString();
    hypothesis.status = 'out-of-scope';
    hypothesis.conclusion = { verdict: 'out-of-scope', reason, timestamp: now };
    hypothesis.metadata.updatedAt = now;
    // A status change is real progress on tree disposition; sibling
    // status-changing mutators (eliminate, corroborate) reset the counter
    // for the same reason.
    this.resetMutationCounter(hypothesis.sessionId);

    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);

    // Setting a branch out-of-scope can complete the disposition of the last
    // open top-level branch.
    const session = this.sessions.get(hypothesis.sessionId);
    if (session && session.status === 'open') {
      this.tryCloseSession(session, now);
    }

    return hypothesis;
  }

  /**
   * Checks structural properties of a decomposition (overlaps, duplicates, catch-all).
   * Does NOT validate semantic MECE — that requires human/LLM reasoning.
   * @param parentId - ID of the parent whose children to validate
   * @returns Structural check results
   * @throws TreeError if parent not found
   */
  validateDecomposition(parentId: string): StructuralCheck {
    const parent = this.getHypothesisOrThrow(parentId);
    const children = parent.children.map((id) => this.hypotheses.get(id)!).filter(Boolean);

    const labels = children.map((c) => c.content.toLowerCase());

    const substringOverlaps: [string, string][] = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        if (labels[i].includes(labels[j]) || labels[j].includes(labels[i])) {
          substringOverlaps.push([children[i].id, children[j].id]);
        }
      }
    }

    const duplicateLabels = labels.filter((l, i) => labels.indexOf(l) !== i);

    const catchAllPatterns = ['other', 'remaining', 'miscellaneous', 'everything else', 'unknown'];
    const hasCatchAll = labels.some((l) =>
      catchAllPatterns.some((p) => l.includes(p)),
    );

    let abstractionMismatch = false;
    let minWords: number | undefined;
    let maxWords: number | undefined;
    if (children.length >= 2) {
      const wordCounts = children.map((c) => c.content.trim().split(/\s+/).filter(Boolean).length);
      minWords = Math.min(...wordCounts);
      maxWords = Math.max(...wordCounts);
      abstractionMismatch = maxWords > minWords * 3;
    }

    return {
      childCount: children.length,
      substringOverlaps,
      duplicateLabels,
      hasCatchAll,
      abstractionMismatch,
      minWords,
      maxWords,
    };
  }

  /**
   * Returns the full tree state for a session (hypotheses + metadata).
   * @param sessionId - Specific session ID, or omit for the active session
   * @returns Tree state, or null if no matching session exists
   */
  getTree(sessionId?: string): TreeState | null {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActiveSession();
    if (!session) return null;

    const sessionHypotheses = new Map<string, Hypothesis>();
    for (const [id, h] of this.hypotheses) {
      if (h.sessionId === session.id) {
        sessionHypotheses.set(id, h);
      }
    }

    return { session, hypotheses: sessionHypotheses };
  }

  /**
   * Returns a summary of the active session: counts, stagnation state, and unexplored branches.
   * @returns Status object (session is null if no active session exists)
   */
  getStatus(): {
    session: Session | null;
    counts: Record<HypothesisStatus, number>;
    stagnant: boolean;
    unexplored: Hypothesis[];
  } {
    const state = this.getTree();
    if (!state) {
      return { session: null, counts: { pending: 0, exploring: 0, eliminated: 0, corroborated: 0, 'out-of-scope': 0 }, stagnant: false, unexplored: [] };
    }

    const counts: Record<HypothesisStatus, number> = { pending: 0, exploring: 0, eliminated: 0, corroborated: 0, 'out-of-scope': 0 };
    const unexplored: Hypothesis[] = [];

    for (const h of state.hypotheses.values()) {
      counts[h.status]++;
      if (h.status === 'pending') unexplored.push(h);
    }

    const sessionMutations = this.mutationsSinceStatusChange.get(state.session.id) ?? 0;
    return {
      session: state.session,
      counts,
      stagnant: sessionMutations >= this.stagnationThreshold,
      unexplored,
    };
  }

  getHypothesis(id: string): Hypothesis | undefined {
    return this.hypotheses.get(id);
  }

  /**
   * Returns sibling hypotheses (same parent, excluding self).
   * @param hypothesisId - ID of the hypothesis whose siblings to find
   * @returns Array of sibling hypotheses (empty if root or parent missing)
   */
  getSiblings(hypothesisId: string): Hypothesis[] {
    const h = this.hypotheses.get(hypothesisId);
    if (!h || !h.parentId) return [];
    const parent = this.hypotheses.get(h.parentId);
    if (!parent) return [];
    return parent.children
      .filter((id) => id !== hypothesisId)
      .map((id) => this.hypotheses.get(id)!)
      .filter(Boolean);
  }

  getActiveSession(): Session | undefined {
    if (this.currentSessionId) {
      const tracked = this.sessions.get(this.currentSessionId);
      if (tracked && tracked.status === 'open') return tracked;
    }
    return Array.from(this.sessions.values()).find((s) => s.status === 'open');
  }

  /**
   * Restores persisted state into the TreeManager at startup.
   *
   * Does NOT emit events. This is intentional: events are for live mutations
   * only. SSE handles initial state via snapshot-on-connect (the browser
   * receives full state when it connects to /sse). This runs at server startup,
   * before any client connections exist.
   */
  loadState(sessions: Session[], hypotheses: Hypothesis[]): void {
    for (const s of sessions) {
      this.sessions.set(s.id, s);
    }
    for (const h of hypotheses) {
      this.hypotheses.set(h.id, h);
      if (!this.sessionHypotheses.has(h.sessionId)) {
        this.sessionHypotheses.set(h.sessionId, new Set());
      }
      this.sessionHypotheses.get(h.sessionId)!.add(h.id);
    }
  }

  /**
   * Returns whether a session is currently loaded in memory.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** O(1) lookup of a session by id. */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Returns all hypotheses across all sessions. For per-session lookup, prefer getHypothesesBySession(). */
  getAllHypotheses(): Hypothesis[] {
    return Array.from(this.hypotheses.values());
  }

  /**
   * Returns hypotheses for a specific session using the per-session index (O(n) in session size, not total).
   */
  getHypothesesBySession(sessionId: string): Hypothesis[] {
    const ids = this.sessionHypotheses.get(sessionId);
    if (!ids) return [];
    const result: Hypothesis[] = [];
    for (const id of ids) {
      const h = this.hypotheses.get(id);
      if (h) result.push(h);
    }
    return result;
  }

  getSecondsSinceLastInteraction(): number {
    return Math.floor((Date.now() - this.lastInteractionTime) / 1000);
  }

  private touch(): void {
    this.lastInteractionTime = Date.now();
  }

  /**
   * Marks `sessionId` as the agent's current working session. Called from
   * mutation methods AFTER validation succeeds, so a rejected call cannot
   * leak state. Refuses to track a non-open session so the next status
   * read falls through to the active-session scan.
   */
  private setCurrent(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'open') {
      this.currentSessionId = sessionId;
    }
  }

  /**
   * Closes a session in either terminal state. Single chokepoint so every
   * mutator goes through the same release of the current-session pointer
   * and emits the same wire event.
   */
  private closeSession(session: Session, terminal: 'resolved' | 'abandoned', timestamp: string): void {
    session.status = terminal;
    session.completedAt = timestamp;
    this.emit('event', { type: 'session-completed', sessionId: session.id, terminalStatus: terminal } satisfies TreeEvent);
    if (this.currentSessionId === session.id) {
      this.currentSessionId = null;
    }
  }

  /**
   * Trigger called from every terminal-status mutation (corroborate,
   * eliminate, set_out_of_scope). Closes the session when every top-level
   * branch is disposed of — resolved if at least one corroborated answer
   * lives on a non-pruned lineage, abandoned otherwise. Corroborations
   * buried under an eliminated or out-of-scope ancestor are moot under
   * the same pruning rule the closure walker applies. Returns true if
   * the session was closed.
   */
  private tryCloseSession(session: Session, timestamp: string): boolean {
    const lookup = (id: string) => this.hypotheses.get(id);
    if (!topLevelBranchesDisposed(session.rootNodeId, lookup)) return false;
    const terminal: 'resolved' | 'abandoned' =
      subtreeContainsCorroborated(session.rootNodeId, lookup) ? 'resolved' : 'abandoned';
    this.closeSession(session, terminal, timestamp);
    return true;
  }

  /**
   * Walks up corroborated ancestors and demotes each to 'exploring'.
   * corroborateHypothesis requires direct children terminal at the moment
   * of the verdict; once a corroborated child demotes via refute, the
   * parent's gate is retroactively unmet, so the parent demotes too — and
   * recursively up the corroborated spine. The historical conclusion stays
   * as audit trail with supersededBy='descendant'. Returns the demoted
   * ancestors so callers can journal the cascade.
   *
   * The visited set guards against a cycle in parentId pointers (impossible
   * via the public engine API but reachable through corrupt journals).
   */
  private demoteCorroboratedAncestors(start: Hypothesis, now: string): Hypothesis[] {
    const demoted: Hypothesis[] = [];
    const seen = new Set<string>([start.id]);
    let cursor = start.parentId ? this.hypotheses.get(start.parentId) : undefined;
    while (cursor && cursor.status === 'corroborated' && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor.status = 'exploring';
      cursor.metadata.updatedAt = now;
      // Guard for loadState's reload path, which trusts journal payloads;
      // a corrupt entry could carry status='corroborated' without a
      // conclusion, and a non-null assertion would crash mid-cascade.
      if (cursor.conclusion) {
        cursor.conclusion.supersededBy = 'descendant';
      }
      demoted.push(cursor);
      this.emit('event', { type: 'hypothesis-updated', hypothesis: cursor } satisfies TreeEvent);
      cursor = cursor.parentId ? this.hypotheses.get(cursor.parentId) : undefined;
    }
    return demoted;
  }

  private getHypothesisOrThrow(id: string): Hypothesis {
    const h = this.hypotheses.get(id);
    if (!h) throw new TreeError(`Hypothesis not found: ${id}`);
    return h;
  }

  /**
   * Rejects a mutation targeting a node whose session is already closed
   * (resolved/abandoned). Pruning never cascades, so a closed session can retain
   * pending/exploring descendants under a pruned branch; mutating those leaked
   * nodes would grow or re-verdict a completed investigation with no closure
   * re-evaluation. The one sanctioned way to act on a closed session is a refute
   * that reopens it (see {@link addEvidence}), which calls this before the
   * reopen and is therefore exempted by its caller.
   */
  private assertSessionOpen(sessionId: string, verb: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status !== 'open') {
      throw new TreeError(
        `Cannot ${verb} in a ${session.status} session; add refuting evidence to a corroborated branch to reopen it first`,
      );
    }
  }

  private incrementMutationCounter(sessionId: string): void {
    this.mutationsSinceStatusChange.set(sessionId, (this.mutationsSinceStatusChange.get(sessionId) ?? 0) + 1);
    this.touch();
  }

  /** Resets the stagnation counter for a session after a real status change. */
  private resetMutationCounter(sessionId: string): void {
    this.mutationsSinceStatusChange.set(sessionId, 0);
    this.touch();
  }
}

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeError';
  }
}
