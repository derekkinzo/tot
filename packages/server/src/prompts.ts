import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Prompts a client can invoke on its own.
 *
 * `tot-investigate` carries the whole protocol. The two review prompts exist so
 * that a client with no subagent machinery can still get an independent read: it
 * runs one in a fresh context, which is what makes the read independent. They
 * state the questions rather than the reasoning behind them — the shipped
 * `references/` carry that — because a client that loads no files sees only this.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt('tot-investigate', {
    title: 'Tree of Thought Investigation',
    description: 'Systematically investigate a problem using a hypothesis tree grounded in falsificationism and eliminative induction. Creates a tree, decomposes into competing hypotheses, and guides structured elimination and corroboration.',
    argsSchema: {
      problem: z.string().describe('The problem, question, or decision to investigate'),
    },
  }, ({ problem }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: buildInvestigatePrompt(problem),
      },
    }],
  }));

  server.registerPrompt('tot-review-decomposition', {
    title: 'Review a Decomposition',
    description: 'Independently review one decomposition for sibling overlap, coverage, level of abstraction, declared relation, and testability. Reports advisory findings, never a pass/fail verdict. Run in a fresh context so the review does not inherit the reasoning that produced the split.',
    argsSchema: {
      parentId: z.string().describe('The hypothesis whose children to review'),
    },
  }, ({ parentId }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: buildReviewDecompositionPrompt(parentId) } }],
  }));

  server.registerPrompt('tot-challenge-hypothesis', {
    title: 'Challenge a Hypothesis',
    description: 'Attempt to refute one hypothesis: invert it, enumerate rivals, check confounders, mechanism and ordering, and design a discriminating test. Run in a fresh context so the challenge does not inherit the case for the claim.',
    argsSchema: {
      hypothesisId: z.string().describe('The hypothesis to attack'),
    },
  }, ({ hypothesisId }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: buildChallengePrompt(hypothesisId) } }],
  }));
}

/** The brief the `tot-review-decomposition` prompt hands a client. */
export function buildReviewDecompositionPrompt(parentId: string): string {
  return `Review the decomposition under hypothesis \`${parentId}\`. Read it with \`get_tree\` (format \`full\`) and \`validate_decomposition\`, then report findings — advisory categories, never a pass/fail verdict.

You did not write this split. Answer each question from its definition, not from the reasoning that produced the children.

**Overlap.** Is any child a strict subset of another? Do two children sit at different points in one causal chain? Where two genuinely co-instantiate, that is acknowledged overlap (Mackie's INUS conditions), and a combined "A and B" child is a legitimate answer rather than a fault to remove.

**Coverage.** Invent a plausible cause of the parent claim and ask which child it lands in. If none, name the gap. Common residuals: external dependencies, environmental drift, human action, time-based triggers, multi-cause interactions, measurement error.

**Level of abstraction.** Which child is a category and which an instance of that category? Children should divide one dimension — the axis the split declares — at one altitude.

**Declared relation.** The split states \`one-of\` (rivals), \`any-of\` (may hold together), or \`all-of\` (parts all required). Do the children as written fit what was declared? If none was declared, say which one they support.

**Testability.** For each child, name an observation that would refute it and one that would corroborate it. Where neither can be named, say so and suggest the sharper claim that could be tested.

**Framing.** Name another axis that could have divided this space, and say whether it would separate the evidence better than the one declared. A split cannot be redrawn once its children exist, so the reachable moves are \`add_hypothesis\` for a possibility the set misses, \`decompose\` on a child to divide a second dimension below it, and \`set_out_of_scope\` for a branch this investigation will not pursue.

Exclusivity and exhaustiveness cannot be established from the tree, so report what you found and what you could not settle. Say plainly when a check produced nothing — that states no finding was found, not that the decomposition is sound.`;
}

/** The brief the `tot-challenge-hypothesis` prompt hands a client. */
export function buildChallengePrompt(hypothesisId: string): string {
  return `Attempt to refute hypothesis \`${hypothesisId}\`. Read it with \`get_tree\` (format \`full\`). Your job is not to confirm it.

1. **Invert it.** Assume it is wrong. What would exist if it were? Hunt for the cause without the effect, and the effect without the cause.
2. **Enumerate rivals.** What else could produce the same observations? List them before gathering anything.
3. **Check confounders.** Is a third factor producing both the supposed cause and the effect?
4. **Trace the mechanism.** Correlation without a chain of intermediate steps is not causation.
5. **Check ordering.** Did the supposed cause precede the effect? Confirm against dated records and record what you found — a record's timestamp is when it was written, not when the phenomenon occurred, so an ordering claim only survives if the record states it.
6. **Design a discriminating test.** One observation whose result separates this claim from its rivals (cf. Platt's strong inference, 1964). Record the proposal with \`add_evidence\` type \`neutral\`, stating what each rival predicts, so the test is in the audit trail whether or not it gets run.

Call \`add_evidence\` for every finding with the type it earns (supports / refutes / neutral); a finding left in your reply alone does not reach the tree. Use \`qualify_evidence\` to mark a record the verdict turns on as \`decisive\`, and one that does not separate the live alternatives as \`nonDiagnostic\`.

Report what survived, what you refuted, which rivals now have evidence, and the test you proposed.`;
}

/** The protocol text the `tot-investigate` prompt hands a client. */
export function buildInvestigatePrompt(problem: string): string {
  return `Investigate this problem using a structured hypothesis tree with the tot-mcp tools:

**Problem:** ${problem}

## Methodology

This protocol applies wherever rival hypotheses must be weighed against evidence — root cause analysis, differential diagnosis, scientific inquiry, intelligence analysis, or any multi-factor decision. Follow this systematic approach:

### Step 1: Create the tree
Call \`create_tree\` with the problem statement.

### Step 2: Decompose into competing hypotheses
Call \`decompose\` to split the problem into 2-5 sibling hypotheses that are comparable along a single framing axis.

Name each hypothesis with a short label — a noun phrase such as "Writer pool exhaustion", not a sentence. The label is what the tree renders, so it is capped short; put the full claim in \`statement\` when it needs more than the label conveys.

Common framing axes (pick one that suits the domain):
- **By mechanism**: distinct causal pathways that could produce the same effect
- **By location or layer**: where in the system the cause sits
- **By stage or time**: phase of the process or moment in time
- **By actor or population**: who or what is affected, or who is acting
- **By category**: type of object, condition, or class of agent

State the axis you picked as \`axis\`; it is required, because siblings can only be judged for overlap and coverage against a stated dimension.

Pick it adversarially rather than taking the first that fits: name at least one other axis that could have divided this space, say why the one you chose separates the evidence better, and name what would show it was the wrong choice. A split cannot be redrawn once its children exist — \`add_hypothesis\` adds to it and \`decompose\` divides a second dimension one level lower — so the axis is worth arguing about before you commit to it. Where the domain has an established framing, use it: \`decomposition-templates.md\`, shipped with this server, carries axes for debugging, differential diagnosis, failure analysis, and decision problems.

### Step 2b: Have the structure checked by something that did not write it
A decomposition reviewed only by its author inherits the blind spot that produced it. Before gathering evidence, get an independent read on it — a review subagent if your client can dispatch one (this server ships \`decomposition-evaluator\` for structure and \`hypothesis-challenger\` for a claim), otherwise re-derive each question from the definitions rather than re-reading your own answers:
- Which plausible cause lands in two of these children, and which lands in none?
- Which child is a category and which an instance of that category?
- For each child, what observation would refute it? A child with no such observation is not yet testable.
- Does the declared gate hold for the children as written?

\`validate_decomposition\` reports what can be checked mechanically — child count, labels that contain one another, duplicates, and whether any label reads as a residual branch. It cannot judge exclusivity, coverage, or level of abstraction: those are claims about what the labels denote, so they stay with the reviewer.

State how the children relate as \`gate\`: \`one-of\` for rivals where at most one holds, \`any-of\` for alternatives that may hold together, \`all-of\` for parts that must all hold. Every node is a hypothesis — being a branch is structural, not a different kind of thing; a branch is a claim whose children are the ways it could be true or the parts it requires.

Aim for the underlying set-partition property — overlap is acceptable when the domain genuinely co-instantiates multiple factors:
- **Distinct siblings**: each covers a different possibility unless co-occurrence is real (Mackie's INUS conditions describe this). \`gate=one-of\` declares them exclusive, so two corroborated siblings then need reconciling.
- **Collective coverage**: together they cover the plausible space; an explicit catch-all branch is first-class when exhaustiveness is uncertain.
- **2-5 siblings per level** keeps the tree legible.

Neither exclusivity nor exhaustiveness is checkable from the tree, so both stay advisory: what the tools report is a conflict between what you declared and what the verdicts show.

### Step 3: Gather evidence systematically
For each hypothesis, call \`add_evidence\` with observations that either:
- **support** the hypothesis (raises its standing)
- **refute** the hypothesis (falsifies or weakens it)
- **neutral** (relevant but not discriminating)

When the observation came from a file or a command — a log, a test run, a diff — write the output to a file and pass \`artifactPath\` (with \`command\`, \`exitCode\`, and the \`excerptStartLine\`/\`excerptEndLine\` the claim rests on). The bytes are stored and can be re-read; a retyped log cannot be checked against anything. Keep \`content\` for what the output shows, not a copy of it.

After each piece of evidence, ask: does this also bear on sibling hypotheses?

### Step 4: Eliminate refuted branches
When refuting evidence is decisive, call \`eliminate_hypothesis\` with the reason and the supporting refuting-evidence ids. Eliminated branches stop drawing investigation effort.

To set a branch aside without claiming refutation, use \`set_out_of_scope\` instead — appropriate when the branch is plausible but outside the scope of this investigation.

### Step 5: Go deeper on surviving branches
For remaining live branches, call \`decompose\` again to create sub-hypotheses. Repeat the evidence → eliminate cycle at each level.

### Step 6: Corroborate surviving hypotheses
When a hypothesis has survived the refutation tests applied to it, call \`corroborate_hypothesis\`. Per Popper, corroboration is provisional retention — the verdict can be reopened by later refuting evidence. Ask: does this account for all the relevant observations?

The session resolves only when every other top-level branch is terminal (eliminated, corroborated, or out-of-scope).

### Reading and qualifying what is recorded
\`get_status\` summarizes progress, unexplored branches, and the ids of the project's other sessions; \`get_tree\` reads any of them, resolved ones included, and its \`full\` form is what an export should read. \`qualify_evidence\` marks a record the verdict turns on as \`decisive\`, marks one that does not separate the live alternatives as \`nonDiagnostic\` — retained and still listed, but weighing nothing — and links records that restate one observation under a shared \`linkedGroupId\` so the group counts once.

## Key Principles

- **Never pursue a single path linearly.** Decompose first, then investigate competing hypotheses in parallel (cf. Chamberlin's method of multiple working hypotheses, 1890).
- **Prefer discriminating evidence.** A test that separates two hypotheses is worth more than a test that confirms a favored one (cf. Platt's strong inference, 1964).
- **Eliminate broadly before going deep.** Rule out entire categories before drilling into one.
- **Rank by disproof, not by support.** A hypothesis earns standing by surviving refutation attempts, never by an assigned confidence number (Popper). Heuer's ACH prefers the hypothesis with the fewest inconsistencies, but that comparison assumes its matrix — every observation checked against every hypothesis. Here evidence is attached per hypothesis, so a branch nobody has tested also carries nothing against it: keep the untested apart from the tested-and-still-standing, and pursue whichever discriminating test separates them.
- **Watch for stagnation.** If progress stalls, the reachable moves are \`add_hypothesis\` for a possibility the set misses, \`decompose\` on a surviving child to divide a second dimension below it, and \`set_out_of_scope\` for a branch this investigation will not pursue. Assume the hypothesis you have challenged least is correct, and ask what evidence you would then expect to find.
- **Allow multiple survivors.** Many real-world causes are compound (Mackie's INUS conditions); corroborating one hypothesis does not refute the others.

## Anti-patterns to avoid

- Going down a rabbit hole on the first plausible hypothesis
- Ignoring evidence that contradicts a favored theory (confirmation bias)
- Decomposing into overlapping siblings (e.g., a category and one of its instances at the same level)
- Stopping investigation after finding one factor without checking that it explains everything observed
- Treating corroboration as proof — it is provisional retention, not verification

Begin by calling \`create_tree\` with the problem statement, then \`decompose\` into your initial competing hypotheses.`;
}
