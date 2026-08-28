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
  /** How this node was split, recorded when it was decomposed. */
  decomposition?: Decomposition;
}

/**
 * The shape of a split: the one dimension the children were compared along, and
 * how they relate to the claim above them.
 *
 * Both are the agent's declarations, not derived properties. Recording them is
 * what makes a decomposition checkable at all: siblings can only be judged for
 * overlap and coverage against a stated axis, and a verdict on a child only
 * bears on its parent through a stated relation.
 */
export interface Decomposition {
  /** The dimension the children divide, such as "by subsystem" or "by timing". */
  axis: string;
  gate?: DecompositionGate;
}

/**
 * How children relate to the claim above them.
 *
 * - `one-of`: rivals, at most one of which holds — the mutually exclusive case.
 * - `any-of`: alternatives that may hold together, as contributing causes do
 *   (Mackie's INUS conditions).
 * - `all-of`: parts that must all hold for the parent to hold.
 */
export const GATES = ['one-of', 'any-of', 'all-of'] as const;

/** Derived from {@link GATES} so a schema, a renderer, and this type cannot
 *  describe different sets of gates. */
export type DecompositionGate = typeof GATES[number];

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
  /** Present exactly when `kind` is 'artifact'. */
  artifact?: ArtifactRef;
  timestamp: string;
}

export type EvidenceKind = 'artifact' | 'transcription';

/**
 * A reference to captured bytes held outside the journal.
 *
 * Deliberately absent: the on-disk path, because a browser resolves bytes only
 * through the artifact endpoints; the excerpt's text, because the journal
 * snapshots the whole node on every change and duplicating captured text there
 * would grow the log by the field agents fill most; and any integrity verdict,
 * because that is recomputed when bytes are read — a stored 'verified' would
 * have replay assert integrity for bytes that may since have changed.
 */
export interface ArtifactRef {
  id: string;
  /** The session whose directory holds the bytes. Makes a reference resolvable
   *  without consulting engine state. */
  sessionId: string;
  /** Display name only. Never a path component: it is caller-supplied. */
  filename: string;
  /** Selects a viewer renderer. */
  mediaType: string;
  bytes: number;
  lineCount?: number;
  digest: ArtifactDigest;
  capturedAt: string;
  /** The invocation that produced the bytes, when one was named. */
  command?: string;
  exitCode?: number;
  /** The quoted region of the artifact, by line. The text itself is read from
   *  the artifact rather than copied here. */
  excerpt?: { startLine: number; endLine: number };
}

/** Only collision-resistant algorithms: a digest is what makes a later
 *  integrity check meaningful. */
export interface ArtifactDigest {
  alg: 'sha-256' | 'sha-512';
  value: string;
}

/** Where artifact reads are addressed. The server routes this prefix and the
 *  dashboard composes its URLs from it, so neither can move alone. */
export const ARTIFACT_ROUTE_PREFIX = '/api/artifacts';

/**
 * What recomputing the digest found: bytes that still match what was captured,
 * bytes that no longer do, or bytes that are gone.
 *
 * A read never trusts a stored verdict, so this is always the result of a fresh
 * check rather than a field on the reference.
 */
export type ArtifactIntegrity = 'verified' | 'mismatch' | 'missing';

/** One page of an artifact's lines, as the line-window endpoint returns it. */
export interface ArtifactLineWindow {
  lines: string[];
  /** The first and last line served, which is what the range was clamped to. */
  from: number;
  to: number;
  totalLines: number;
  /** True when the requested range was cut to the window cap. */
  truncated: boolean;
}

/**
 * Whether an artifact is shown as numbered lines rather than offered as a
 * download.
 *
 * Reads the line count the capture recorded, which is present exactly when the
 * bytes were treated as text there. Both the read endpoint and the viewer ask
 * this one question, so a viewer can never page a file the store never counted.
 */
export function rendersAsLines(ref: Pick<ArtifactRef, 'lineCount'>): boolean {
  return ref.lineCount !== undefined;
}

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

  // A clause carries at least two words. Anything shorter before a period is a
  // list marker, a version, a date, or an initial — 'Step 1.', 'v1.', '2026-08-19.',
  // 'Q.' — and keeping it would discard the claim it introduces, so the whole prose
  // is used instead. Counted in words rather than tokens, so 'Step 1' is a marker
  // while 'Disk full' is a clause. Leading punctuation is dropped so the label
  // starts on a word.
  const candidate = flat.split(CLAUSE_BOUNDARY)[0].replace(/\.+$/, '').trim();
  const isClause = (text: string) => (text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length >= 2;
  const chosen = isClause(candidate) ? candidate : flat;
  const firstClause = chosen.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\.+$/, '').trim();
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
/**
 * English's closed class of copulas and auxiliaries. A word from this list
 * standing on its own turns a phrase into a clause, which is what distinguishes
 * "the writer pool was exhausted" from "writer pool exhaustion". Closed because
 * the language does not add to it, so this is the class itself rather than a
 * sample of it.
 */
const FINITE_AUXILIARIES = [
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
  'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
];

const CLAUSE_MARKERS = new RegExp(`(?:^|[^\\p{L}])(?:${FINITE_AUXILIARIES.join('|')})(?:[^\\p{L}]|$)`, 'iu');

/**
 * Whether a label reads as a clause rather than the noun phrase the tools ask
 * for — because it carries a finite auxiliary, or because it runs to more than
 * one sentence.
 *
 * Advisory only, and reported as such: a noun phrase is a claim about what the
 * words denote, which no lexical test settles. What this does establish is that
 * a clause marker is present, and a label carrying one is prose in a slot the
 * canvas renders as a name.
 */
export function readsAsClause(label: string): boolean {
  const flat = label.replace(/\s+/g, ' ').trim();
  if (flat === '') return false;
  // A sentence break inside the label: terminal punctuation with a word after it.
  if (/[.!?]\s+\p{L}/u.test(flat)) return true;
  return CLAUSE_MARKERS.test(flat);
}

export function titleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === '') return 'must not be empty or whitespace-only';
  if (trimmed.length > TITLE_MAX_LENGTH) return `must be at most ${TITLE_MAX_LENGTH} characters`;
  if (trimmed.endsWith('.')) return 'must read as a short label, so it must not end with a period';
  return null;
}

// ─── Decompositions ───

const GATE_TEXT: Record<DecompositionGate, { label: string; meaning: string }> = {
  'one-of': {
    label: 'one of',
    meaning: 'Rivals: at most one of these holds, so evidence for one counts against the others.',
  },
  'any-of': {
    label: 'any of',
    meaning: 'Alternatives: one or more may hold together, so corroborating one does not rule out the rest.',
  },
  'all-of': {
    label: 'all of',
    meaning: 'Parts: every one must hold for the claim above them to hold, so defeating any part defeats it.',
  },
};

/** Short label for a gate, as a canvas renders it. */
export function gateLabel(gate: DecompositionGate): string {
  return GATE_TEXT[gate].label;
}

/** What the gate claims about the children, in one sentence. */
export function gateMeaning(gate: DecompositionGate): string {
  return GATE_TEXT[gate].meaning;
}

export type GateFindingKind =
  | 'rival-survivors'
  | 'required-part-defeated'
  | 'required-part-untested'
  | 'alternatives-exhausted'
  | 'alternatives-abandoned';

/** A conflict between a declared gate and the verdicts recorded under it. */
export interface GateFinding {
  kind: GateFindingKind;
  /** The children the conflict rests on. */
  nodeIds: string[];
  message: string;
}

/**
 * Conflicts between how a node declared its children relate and how they were
 * actually settled.
 *
 * Reports only what follows from the declaration, never whether a decomposition
 * is exhaustive or exclusive in fact — that cannot be computed from the tree, so
 * asserting it would be an overclaim. Children absent from `children` are
 * unknown rather than settled, so no finding rests on them.
 */
export function gateFindings(parent: Hypothesis, children: Hypothesis[]): GateFinding[] {
  const gate = parent.decomposition?.gate;
  if (gate === undefined) return [];

  const known = new Map(children.map((c) => [c.id, c]));
  const present = parent.children.map((id) => known.get(id));
  if (present.length === 0 || present.some((c) => c === undefined)) return [];
  const kids = present as Hypothesis[];

  const findings: GateFinding[] = [];

  if (gate === 'one-of') {
    const survivors = kids.filter((c) => c.status === 'corroborated');
    if (survivors.length > 1) {
      findings.push({
        kind: 'rival-survivors',
        nodeIds: survivors.map((c) => c.id),
        message: `${survivors.length} rivals are corroborated, but they were declared mutually exclusive. Either one of them is not the cause, or the split is along more than one dimension.`,
      });
    }
  }

  // A refuted child and one merely set aside are reported apart throughout: only
  // the first was tested, so only the first can defeat anything.
  if (gate === 'all-of') {
    const defeated = kids.filter((c) => c.status === 'eliminated');
    if (defeated.length > 0) {
      findings.push({
        kind: 'required-part-defeated',
        nodeIds: defeated.map((c) => c.id),
        message: `${defeated.length} of the required parts no longer stands, so the claim above them cannot hold as stated. Eliminate it citing that part, or revise the split.`,
      });
    }
    const untested = kids.filter((c) => c.status === 'out-of-scope');
    if (untested.length > 0) {
      findings.push({
        kind: 'required-part-untested',
        nodeIds: untested.map((c) => c.id),
        message: `${untested.length} of the required parts was set aside without being investigated, so the claim above them rests on a part nobody has checked. Investigate it, or say what the claim above is worth without it.`,
      });
    }
  } else if (kids.every((c) => isPruned(c.status))) {
    const setAside = kids.filter((c) => c.status === 'out-of-scope');
    findings.push(setAside.length === 0
      ? {
        kind: 'alternatives-exhausted',
        nodeIds: kids.map((c) => c.id),
        message: 'Every alternative under this claim has been ruled out. Either the claim itself is refuted, or the alternatives did not cover the space and one is missing.',
      }
      : {
        kind: 'alternatives-abandoned',
        nodeIds: setAside.map((c) => c.id),
        message: `Every alternative under this claim is closed, but ${setAside.length} of them ${setAside.length === 1 ? 'was' : 'were'} set aside without being investigated, so the space was never eliminated. Nothing here refutes the claim above; investigate what was set aside before treating this branch as answered.`,
      });
  }

  return findings;
}

// ─── Payload normalization ───

/**
 * Names an earlier build wrote for statuses this one spells differently.
 *
 * Every closure and display rule switches on the status, so a value outside the
 * union does not read as "unknown" — it reads as none of the cases, and the node
 * quietly stops counting as terminal, pruned, or open.
 */
const LEGACY_STATUS = new Map<string, HypothesisStatus>([
  ['confirmed', 'corroborated'],
  ['corroborated', 'corroborated'],
  ['refuted', 'eliminated'],
  ['rejected', 'eliminated'],
  ['eliminated', 'eliminated'],
  ['out-of-scope', 'out-of-scope'],
  ['pending', 'pending'],
  ['exploring', 'exploring'],
]);

/**
 * Projects a persisted status onto the declared union.
 *
 * An unrecognised value becomes 'exploring': live and undecided. Guessing a
 * verdict would assert one nobody recorded, and leaving the value as written
 * would drop the node out of closure altogether.
 */
export function normalizeStatus(raw: unknown): HypothesisStatus {
  // A Map, not an object literal: a persisted value is arbitrary text, and an
  // object lookup on 'toString' or 'constructor' returns an inherited member, so
  // the fallback would never fire and a function would land in this field.
  return LEGACY_STATUS.get(String(raw)) ?? 'exploring';
}

/**
 * Projects a persisted conclusion verdict onto the declared union.
 *
 * A verdict names a disposition that was reached, so an unreadable one falls back
 * to the pruning disposition that claims no refutation and no survival.
 */
export function normalizeVerdict(raw: unknown): Conclusion['verdict'] {
  const mapped = LEGACY_STATUS.get(String(raw));
  return mapped === 'eliminated' || mapped === 'corroborated' || mapped === 'out-of-scope'
    ? mapped
    : 'out-of-scope';
}

/** Names an earlier build wrote for session states this one spells differently. */
const LEGACY_SESSION_STATUS = new Map<string, Session['status']>([
  ['active', 'open'],
  ['open', 'open'],
  ['resolved', 'resolved'],
  ['complete', 'resolved'],
  ['completed', 'resolved'],
  ['abandoned', 'abandoned'],
]);

/**
 * Projects a persisted session payload onto the declared contract.
 *
 * An unrecognised state becomes 'open', the state that permits mutation: a
 * session wrongly read as terminal can never be worked on again, while one
 * wrongly read as open is corrected by the next closure check.
 */
export function normalizeSessionPayload(raw: unknown): Session {
  const session = (raw ?? {}) as Session;
  return { ...session, status: LEGACY_SESSION_STATUS.get(String(session.status)) ?? 'open' };
}

/** Whether `raw` names a terminal session state this build understands. */
export function terminalSessionStatus(raw: unknown): 'resolved' | 'abandoned' | null {
  const mapped = LEGACY_SESSION_STATUS.get(String(raw));
  return mapped === 'resolved' || mapped === 'abandoned' ? mapped : null;
}


/**
 * Projects a persisted hypothesis payload onto the current contract.
 *
 * Every field is defaulted from *its own absence* rather than from the entry's
 * schema version, because writers that ship at different times all stamp the
 * version current for them while omitting fields introduced later; keying on the
 * version would leave those fields undefined.
 *
 * Fields the contract does not carry are removed by name rather than by
 * allowlisting the ones that remain, so an optional field the contract does
 * carry is never silently dropped.
 */
export function normalizeHypothesisPayload(raw: unknown): Hypothesis {
  const { content, score, scoreRationale, ...rest } = (raw ?? {}) as Record<string, unknown> & {
    content?: string;
    score?: unknown;
    scoreRationale?: unknown;
  };
  const node = rest as unknown as Hypothesis;

  // A payload carrying one prose field states either a long-form claim or, when
  // there was none, the label again. The label wins if it is there, and the prose
  // becomes the statement only where it says something the label does not —
  // adopting a restated label would hand back a field nobody authored.
  const prose = node.statement ?? content;
  const title = node.title ?? deriveTitle(prose ?? '');
  const statement = node.statement ?? (prose !== title ? prose : undefined);
  const evidence = (node.evidence ?? []).map(normalizeEvidenceRecord);

  // The verdict shares the status vocabulary and is compared against it to decide
  // whether a conclusion was superseded, so translating one without the other
  // makes every legacy terminal node read as reopened.
  const conclusion = node.conclusion === undefined
    ? undefined
    : { ...node.conclusion, verdict: normalizeVerdict(node.conclusion.verdict) };

  return {
    ...node, title, evidence, status: normalizeStatus(node.status),
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(statement === undefined ? {} : { statement }),
  };
}

/**
 * Projects a persisted evidence record onto the current contract.
 *
 * `kind` and `artifact` state one fact twice, so the label is derived from the
 * bytes rather than taken as written: a reader that trusted a stale label would
 * call a record a paraphrase while offering the capture it can open. Shared by
 * the snapshot path and the per-record journal event, which would otherwise
 * disagree about a required field.
 */
export function normalizeEvidenceRecord(raw: unknown): Evidence {
  const record = (raw ?? {}) as Evidence;
  const kind: EvidenceKind = record.artifact !== undefined ? 'artifact' : 'transcription';
  return record.kind === kind ? record : { ...record, kind };
}
