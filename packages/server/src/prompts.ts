import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
}

function buildInvestigatePrompt(problem: string): string {
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

## Key Principles

- **Never pursue a single path linearly.** Decompose first, then investigate competing hypotheses in parallel (cf. Chamberlin's method of multiple working hypotheses, 1890).
- **Prefer discriminating evidence.** A test that separates two hypotheses is worth more than a test that confirms a favored one (cf. Platt's strong inference, 1964).
- **Eliminate broadly before going deep.** Rule out entire categories before drilling into one.
- **Rank by disproof, not by support.** A hypothesis earns standing by surviving refutation attempts, never by an assigned confidence number; pursue the one with the least disconfirming evidence (Popper; Heuer's ACH).
- **Watch for stagnation.** If progress stalls, restructure the decomposition or relax the framing axis.
- **Allow multiple survivors.** Many real-world causes are compound (Mackie's INUS conditions); corroborating one hypothesis does not refute the others.

## Anti-patterns to avoid

- Going down a rabbit hole on the first plausible hypothesis
- Ignoring evidence that contradicts a favored theory (confirmation bias)
- Decomposing into overlapping siblings (e.g., a category and one of its instances at the same level)
- Stopping investigation after finding one factor without checking that it explains everything observed
- Treating corroboration as proof — it is provisional retention, not verification

Begin by calling \`create_tree\` with the problem statement, then \`decompose\` into your initial competing hypotheses.`;
}
