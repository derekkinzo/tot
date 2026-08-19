/**
 * Domain contract shared by the server (engine + persistence) and the web-ui
 * dashboard: the hypothesis-tree types that cross the SSE/JSON wire, and the
 * pure status/evidence predicates both sides reason with. These are a single
 * piece of knowledge that must change together — defining them once here keeps
 * the two separately-bundled packages from drifting.
 *
 * Pure and dependency-free, so both bundlers (tsup for Node, Vite for the
 * browser) consume this TypeScript source directly with no build step.
 */

// ─── Wire contract types ───

export interface Hypothesis {
  id: string;
  parentId: string | null;
  sessionId: string;
  depth: number;
  /** Short label, at most {@link TITLE_MAX_LENGTH} characters. The only text a
   *  canvas renders for this node. */
  title: string;
  /** Long-form statement of the claim, when one was authored. Rendered where
   *  there is room for prose rather than a label. */
  statement?: string;
  status: HypothesisStatus;
  evidence: Evidence[];
  conclusion?: Conclusion;
  metadata: HypothesisMetadata;
  children: string[];
}

// 'out-of-scope': terminal but no refutation claimed — the agent set this
// branch aside as not worth investigating, distinct from elimination which
// asserts a refuting record. Closure treats both as pruning.
export type HypothesisStatus =
  | 'pending'
  | 'exploring'
  | 'eliminated'
  | 'corroborated'
  | 'out-of-scope';

export interface Evidence {
  id: string;
  type: 'supports' | 'refutes' | 'neutral';
  /** Whether the record is verbatim captured bytes or a paraphrase of them. */
  kind: EvidenceKind;
  content: string;
  source?: string;
  /** Marks a record the verdict turns on, so it can be read first. */
  decisive?: boolean;
  /** Asserted — never inferred — when a record does not discriminate between the
   *  live alternatives. Such a record is retained and still counted, but carries
   *  no weight toward a verdict. */
  nonDiagnostic?: boolean;
  /** Records that only support or refute jointly. A group carries the weight of
   *  one independent observation however many records it holds. */
  linkedGroupId?: string;
  timestamp: string;
}

export type EvidenceKind = 'artifact' | 'transcription';

export interface Conclusion {
  verdict: 'eliminated' | 'corroborated' | 'out-of-scope';
  reason: string;
  timestamp: string;
  // Ids of refutes-typed evidence that ground an 'eliminated' verdict.
  // Empty/absent when replaying older journals that did not record this.
  refutingEvidenceIds?: string[];
  // Set when the verdict has been superseded by a later refute. 'self' marks a
  // direct refute against this hypothesis; 'descendant' marks a cascade demote
  // triggered by a refute on a corroborated descendant. Renderers use this to
  // distinguish the historical-conclusion banner.
  supersededBy?: 'self' | 'descendant';
}

export interface HypothesisMetadata {
  createdAt: string;
  updatedAt: string;
  source: 'agent' | 'human';
}

export interface Session {
  id: string;
  problem: string;
  rootNodeId: string;
  status: 'open' | 'resolved' | 'abandoned';
  createdAt: string;
  completedAt?: string;
}

// 'session-completed' covers both terminal transitions (resolved and
// abandoned); terminalStatus disambiguates which.
export type TreeEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'hypothesis-added'; hypothesis: Hypothesis }
  | { type: 'hypothesis-updated'; hypothesis: Hypothesis }
  | { type: 'evidence-added'; hypothesisId: string; evidence: Evidence }
  | { type: 'session-completed'; sessionId: string; terminalStatus: 'resolved' | 'abandoned' }
  | { type: 'session-reopened'; sessionId: string }
  | { type: 'snapshot'; session: Session | null; hypotheses: Hypothesis[] };

// ─── Status predicates ───

/**
 * Eliminated and out-of-scope are pruning verdicts: descendants of a pruned
 * branch are moot under the closure rule.
 */
export function isPruned(status: HypothesisStatus): boolean {
  return status === 'eliminated' || status === 'out-of-scope';
}

/**
 * A hypothesis is "live" when it can still accept further work or be reopened.
 * Pruning verdicts are the only excluded states.
 */
export function isLive(status: HypothesisStatus): boolean {
  return !isPruned(status);
}

/**
 * Terminal statuses cannot accept new children. Includes corroborated, which is
 * settled (though revisable by refutation on the leaf itself, not by sprouting
 * a new pending child below it).
 */
export function isTerminal(status: HypothesisStatus): boolean {
  return status === 'eliminated' || status === 'corroborated' || status === 'out-of-scope';
}

/**
 * A hypothesis is "open" when it is an unsettled competitor still inviting work
 * — pending or exploring. Distinct from isLive, which also admits a
 * corroborated (settled) verdict.
 */
export function isOpen(status: HypothesisStatus): boolean {
  return status === 'pending' || status === 'exploring';
}

// ─── Evidence counts ───

/**
 * Count of supporting / refuting evidence on a hypothesis. One definition so
 * every gate that fires and every number printed agree.
 */
export const countSupporting = (h: Hypothesis): number =>
  h.evidence.filter((e) => e.type === 'supports').length;
export const countRefuting = (h: Hypothesis): number =>
  h.evidence.filter((e) => e.type === 'refutes').length;

/**
 * Independent discriminating force of the supporting / refuting evidence, as
 * distinct from how many records were filed.
 *
 * Records sharing a `linkedGroupId` only observe jointly, so a group weighs one;
 * a record asserted `nonDiagnostic` weighs nothing. Use a weight wherever the
 * question is "how strongly is this held", and a count wherever the reader is
 * comparing the number against a list of records.
 */
export const supportingWeight = (h: Hypothesis): number => weigh(h, 'supports');
export const refutingWeight = (h: Hypothesis): number => weigh(h, 'refutes');

function weigh(h: Hypothesis, type: Evidence['type']): number {
  const groups = new Set<string>();
  let lone = 0;
  for (const e of h.evidence) {
    if (e.type !== type || e.nonDiagnostic) continue;
    if (e.linkedGroupId === undefined) lone += 1;
    else groups.add(e.linkedGroupId);
  }
  return lone + groups.size;
}

/**
 * True when a hypothesis holds a settled verdict but no verbatim record.
 *
 * Exactly computable and free of judgement: it reports that a conclusion rests
 * only on paraphrase, never that the conclusion is wrong.
 */
export function hasUngroundedVerdict(h: Hypothesis): boolean {
  return isTerminal(h.status) && !h.evidence.some((e) => e.kind === 'artifact');
}

/** True when any hypothesis in the set carries a verbatim record. Distinguishes
 *  a session that never captured artifacts from one whose verdicts skipped them. */
export function sessionIsGrounded(hypotheses: Iterable<Hypothesis>): boolean {
  for (const h of hypotheses) {
    if (h.evidence.some((e) => e.kind === 'artifact')) return true;
  }
  return false;
}

// ─── Titles ───

/** Longest label a hypothesis title may render as. */
export const TITLE_MAX_LENGTH = 80;

/**
 * Clause boundary: a sentence period, a semicolon, or a spaced dash. Requiring
 * a capital after the period keeps "e.g. foo" and "v1.2 bar" intact, and
 * requiring spaces around the dash keeps "write-ahead" intact.
 *
 * A comma is deliberately not a boundary: cutting there would reduce an
 * enumeration of alternatives to its first item, which is the part of the
 * meaning a label most needs to keep.
 */
const CLAUSE_BOUNDARY = /\.\s+(?=[A-Z])|;\s+|\s+[—–-]\s+/;

/**
 * Projects free-form prose onto a single-line label of at most
 * {@link TITLE_MAX_LENGTH} characters: collapses whitespace, keeps the first
 * clause, drops a trailing period, and — when still too long — cuts on a word
 * boundary and appends an ellipsis.
 *
 * Idempotent, and returns an empty string for blank input. Used to render a
 * label for a hypothesis that carries only long-form prose; it derives a label
 * for display and never rewrites the stored text.
 */
export function deriveTitle(prose: string): string {
  const flat = prose.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';

  const firstClause = flat.split(CLAUSE_BOUNDARY)[0].replace(/\.+$/, '').trim();
  if (firstClause === '') return '';
  if (firstClause.length <= TITLE_MAX_LENGTH) return firstClause;

  // Reserve the last position for the ellipsis, then prefer the last word
  // boundary inside the budget; a single unbroken token has none, so cut it.
  const budget = firstClause.slice(0, TITLE_MAX_LENGTH - 1);
  const lastSpace = budget.lastIndexOf(' ');
  const cut = lastSpace > 0 ? budget.slice(0, lastSpace) : budget;
  return `${cut.trimEnd()}…`;
}

/**
 * The label to render for a hypothesis: its title, falling back to a label
 * derived from the statement and then to a placeholder, so a payload written
 * without a usable title still renders as something identifiable.
 */
export function nodeLabel(h: Pick<Hypothesis, 'title'> & Partial<Pick<Hypothesis, 'statement'>>): string {
  return h.title || deriveTitle(h.statement ?? '') || '(untitled)';
}

/**
 * Splits authored prose into a label and, when the prose carries more than the
 * label does, the statement it was derived from. Lets a caller that has only one
 * free-text field populate both without inventing a second projection rule.
 */
export function splitProse(prose: string): { title: string; statement?: string } {
  const title = deriveTitle(prose);
  const trimmed = prose.trim();
  return trimmed === title ? { title } : { title, statement: trimmed };
}

/** The authored text for a new hypothesis: a label, optionally with the
 *  long-form claim it summarizes. */
export interface HypothesisDraft {
  title: string;
  statement?: string;
}

/**
 * Why a title is unusable as a label, or null when it is fine. A label reads as
 * a noun phrase, so a trailing sentence period is rejected along with blank text
 * and text past the length bound.
 */
export function titleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === '') return 'must not be empty or whitespace-only';
  if (trimmed.length > TITLE_MAX_LENGTH) return `must be at most ${TITLE_MAX_LENGTH} characters`;
  if (trimmed.endsWith('.')) return 'must read as a short label, so it must not end with a period';
  return null;
}

// ─── Payload normalization ───

/**
 * Projects a persisted hypothesis payload onto the current contract.
 *
 * Every field is defaulted from *its own absence* rather than from the entry's
 * schema version, because writers that ship at different times all stamp the
 * version current for them while omitting fields introduced later; keying on the
 * version would leave those fields undefined.
 *
 * Fields no longer in the contract are removed explicitly rather than by
 * allowlisting the ones that remain, so an optional field the contract still
 * carries is never silently dropped.
 */
export function normalizeHypothesisPayload(raw: unknown): Hypothesis {
  const { content, score, scoreRationale, ...rest } = (raw ?? {}) as Record<string, unknown> & {
    content?: string;
    score?: unknown;
    scoreRationale?: unknown;
  };
  const node = rest as unknown as Hypothesis;

  // A payload predating the title/statement split carries one prose field; it
  // becomes the statement, and the label is derived from it.
  const statement = node.statement ?? content;
  const title = node.title ?? deriveTitle(statement ?? '');
  // A record written before the distinction existed is a paraphrase: it holds
  // text the agent typed, not bytes captured from a source.
  const evidence = (node.evidence ?? []).map((e) => (e.kind ? e : { ...e, kind: 'transcription' as const }));

  return { ...node, title, evidence, ...(statement === undefined ? {} : { statement }) };
}
