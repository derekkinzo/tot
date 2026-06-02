import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
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
  private mutationsSinceStatusChange = 0;
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
      status: 'active',
      createdAt: now,
    };

    const root: Hypothesis = {
      id: rootId,
      parentId: null,
      sessionId,
      depth: 0,
      content: problem,
      status: 'pending',
      score: null,
      evidence: [],
      metadata: { createdAt: now, updatedAt: now, source: 'agent' },
      children: [],
    };

    this.sessions.set(sessionId, session);
    this.hypotheses.set(rootId, root);
    this.sessionHypotheses.set(sessionId, new Set([rootId]));
    this.currentSessionId = sessionId;
    this.mutationsSinceStatusChange = 0;
    this.touch();

    this.emit('event', { type: 'session-created', session } satisfies TreeEvent);
    this.emit('event', { type: 'hypothesis-added', hypothesis: root } satisfies TreeEvent);

    return { session, root };
  }

  /**
   * Decomposes a hypothesis into MECE sub-hypotheses, creating child nodes.
   * Auto-transitions the parent from 'pending' to 'exploring'.
   * @param parentId - ID of the hypothesis to decompose
   * @param childContents - Array of sub-hypothesis descriptions (2+)
   * @returns The created child hypothesis nodes
   * @throws TreeError if parent is eliminated/confirmed, fewer than 2 children, depth exceeded, or count exceeded
   */
  decompose(parentId: string, childContents: string[]): Hypothesis[] {
    const parent = this.getHypothesisOrThrow(parentId);
    this.currentSessionId = parent.sessionId;

    if (parent.status === 'eliminated' || parent.status === 'confirmed') {
      throw new TreeError(`Cannot decompose a ${parent.status} hypothesis`);
    }
    if (childContents.length < 2) {
      throw new TreeError('Decomposition requires at least 2 sub-hypotheses');
    }
    if (parent.depth + 1 > this.maxDepth) {
      throw new TreeError(`Tree depth limit (${this.maxDepth}) exceeded`);
    }
    if (this.hypotheses.size + childContents.length > this.maxHypotheses) {
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
      score: null,
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
      this.mutationsSinceStatusChange = 0;
      this.touch();
    } else {
      this.incrementMutationCounter();
    }

    this.emit('event', { type: 'hypothesis-updated', hypothesis: parent } satisfies TreeEvent);
    return children;
  }

  /**
   * Adds a single hypothesis as a child of an existing node.
   * Use when a MECE decomposition is missing a possibility.
   * @param parentId - ID of the parent hypothesis
   * @param content - Description of the new hypothesis
   * @returns The newly created hypothesis
   * @throws TreeError if parent is eliminated, depth exceeded, or count exceeded
   */
  addHypothesis(parentId: string, content: string): Hypothesis {
    const parent = this.getHypothesisOrThrow(parentId);
    this.currentSessionId = parent.sessionId;

    if (parent.status === 'eliminated') {
      throw new TreeError('Cannot add hypothesis to an eliminated node');
    }
    if (parent.depth + 1 > this.maxDepth) {
      throw new TreeError(`Tree depth limit (${this.maxDepth}) exceeded`);
    }
    if (this.hypotheses.size + 1 > this.maxHypotheses) {
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
      score: null,
      evidence: [],
      metadata: { createdAt: now, updatedAt: now, source: 'agent' },
      children: [],
    };

    this.hypotheses.set(hypothesis.id, hypothesis);
    this.sessionHypotheses.get(parent.sessionId)?.add(hypothesis.id);
    parent.children.push(hypothesis.id);
    parent.metadata.updatedAt = now;
    this.incrementMutationCounter();

    this.emit('event', { type: 'hypothesis-added', hypothesis } satisfies TreeEvent);
    this.emit('event', { type: 'hypothesis-updated', hypothesis: parent } satisfies TreeEvent);
    return hypothesis;
  }

  /**
   * Attaches evidence to a hypothesis. Auto-transitions 'pending' to 'exploring'.
   * @param hypothesisId - ID of the target hypothesis
   * @param type - Relationship of evidence to the hypothesis
   * @param content - Description of the evidence
   * @param source - Optional provenance (logs, tests, docs, etc.)
   * @returns The created evidence record
   * @throws TreeError if hypothesis is eliminated or confirmed
   */
  addEvidence(
    hypothesisId: string,
    type: 'supports' | 'refutes' | 'neutral',
    content: string,
    source?: string,
  ): Evidence {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);
    this.currentSessionId = hypothesis.sessionId;

    if (hypothesis.status === 'eliminated' || hypothesis.status === 'confirmed') {
      throw new TreeError(`Cannot add evidence to a ${hypothesis.status} hypothesis`);
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

    if (hypothesis.status === 'pending') {
      hypothesis.status = 'exploring';
      this.mutationsSinceStatusChange = 0;
      this.touch();
    } else {
      this.incrementMutationCounter();
    }

    this.emit('event', { type: 'evidence-added', hypothesisId, evidence } satisfies TreeEvent);
    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);

    return evidence;
  }

  /**
   * Marks a hypothesis as eliminated (dead end), recording the reason.
   * @param hypothesisId - ID of the hypothesis to eliminate
   * @param reason - Justification for elimination (creates audit trail)
   * @returns The updated hypothesis
   * @throws TreeError if already eliminated or confirmed
   */
  eliminateHypothesis(hypothesisId: string, reason: string): Hypothesis {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);
    this.currentSessionId = hypothesis.sessionId;

    if (hypothesis.status === 'eliminated') {
      throw new TreeError('Hypothesis is already eliminated');
    }
    if (hypothesis.status === 'confirmed') {
      throw new TreeError('Cannot eliminate a confirmed hypothesis');
    }

    const now = new Date().toISOString();
    hypothesis.status = 'eliminated';
    hypothesis.conclusion = { verdict: 'eliminated', reason, timestamp: now };
    hypothesis.metadata.updatedAt = now;
    this.mutationsSinceStatusChange = 0;
    this.touch();

    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);
    return hypothesis;
  }

  /**
   * Marks a hypothesis as confirmed (the answer). Completes the session.
   * @param hypothesisId - ID of the hypothesis to confirm
   * @param reason - Justification for confirmation
   * @returns The updated hypothesis
   * @throws TreeError if already confirmed or eliminated
   */
  confirmHypothesis(hypothesisId: string, reason: string): Hypothesis {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);
    this.currentSessionId = hypothesis.sessionId;

    if (hypothesis.status === 'confirmed') {
      throw new TreeError('Hypothesis is already confirmed');
    }
    if (hypothesis.status === 'eliminated') {
      throw new TreeError('Cannot confirm an eliminated hypothesis');
    }

    const now = new Date().toISOString();
    hypothesis.status = 'confirmed';
    hypothesis.conclusion = { verdict: 'confirmed', reason, timestamp: now };
    hypothesis.metadata.updatedAt = now;
    this.mutationsSinceStatusChange = 0;
    this.touch();

    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);

    const session = this.sessions.get(hypothesis.sessionId);
    if (session) {
      session.status = 'completed';
      session.completedAt = now;
      this.emit('event', { type: 'session-completed', sessionId: session.id } satisfies TreeEvent);
    }

    return hypothesis;
  }

  /**
   * Updates the confidence score for a hypothesis (0-1 range).
   * @param hypothesisId - ID of the hypothesis to score
   * @param score - Confidence between 0 and 1
   * @param rationale - Optional reasoning for the score assignment
   * @returns The updated hypothesis
   * @throws TreeError if score is out of range or hypothesis not found
   */
  scoreHypothesis(hypothesisId: string, score: number, rationale?: string): Hypothesis {
    const hypothesis = this.getHypothesisOrThrow(hypothesisId);
    this.currentSessionId = hypothesis.sessionId;

    if (score < 0 || score > 1 || Number.isNaN(score)) {
      throw new TreeError('Score must be between 0 and 1');
    }

    hypothesis.score = score;
    if (rationale) {
      hypothesis.scoreRationale = rationale;
    }
    hypothesis.metadata.updatedAt = new Date().toISOString();
    this.incrementMutationCounter();

    this.emit('event', { type: 'hypothesis-updated', hypothesis } satisfies TreeEvent);
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

    return {
      childCount: children.length,
      substringOverlaps,
      duplicateLabels,
      hasCatchAll,
    };
  }

  /**
   * Returns the full tree state for a session (hypotheses + metadata).
   * @param sessionId - Specific session ID, or omit for the active session
   * @returns Tree state, or null if no matching session exists
   */
  getTree(sessionId?: string): TreeState | null {
    let session: Session | undefined;
    if (sessionId) {
      session = this.sessions.get(sessionId);
    } else if (this.currentSessionId) {
      session = this.sessions.get(this.currentSessionId);
    } else {
      session = Array.from(this.sessions.values()).find((s) => s.status === 'active');
    }

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
   * Returns a summary of the active session: counts, stagnation state, unexplored branches, and best lead.
   * @returns Status object (session is null if no active session exists)
   */
  getStatus(): {
    session: Session | null;
    counts: Record<HypothesisStatus, number>;
    stagnant: boolean;
    unexplored: Hypothesis[];
    bestLead: Hypothesis | null;
  } {
    const state = this.getTree();
    if (!state) {
      return { session: null, counts: { pending: 0, exploring: 0, eliminated: 0, confirmed: 0 }, stagnant: false, unexplored: [], bestLead: null };
    }

    const counts: Record<HypothesisStatus, number> = { pending: 0, exploring: 0, eliminated: 0, confirmed: 0 };
    const unexplored: Hypothesis[] = [];
    let bestLead: Hypothesis | null = null;

    for (const h of state.hypotheses.values()) {
      counts[h.status]++;
      if (h.status === 'pending') unexplored.push(h);
      if (h.score !== null && (bestLead === null || h.score > bestLead.score!)) {
        bestLead = h;
      }
    }

    return {
      session: state.session,
      counts,
      stagnant: this.mutationsSinceStatusChange >= this.stagnationThreshold,
      unexplored,
      bestLead,
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
      return this.sessions.get(this.currentSessionId);
    }
    return undefined;
  }

  /**
   * Restores persisted state into the TreeManager at startup.
   *
   * Does NOT emit events. This is intentional: events are for live mutations
   * only. SSE handles initial state via snapshot-on-connect (the browser
   * receives full state when it connects to /sse). This method is called by
   * the daemon at startup before any client connections exist.
   */
  loadState(sessions: Session[], hypotheses: Hypothesis[]): void {
    for (const s of sessions) {
      this.sessions.set(s.id, s);
      this.currentSessionId = s.id;
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

  private getHypothesisOrThrow(id: string): Hypothesis {
    const h = this.hypotheses.get(id);
    if (!h) throw new TreeError(`Hypothesis not found: ${id}`);
    return h;
  }

  private incrementMutationCounter(): void {
    this.mutationsSinceStatusChange++;
    this.touch();
  }
}

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeError';
  }
}
