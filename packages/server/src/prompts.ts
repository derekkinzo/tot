import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt('debug-mece', {
    title: 'MECE Debugging',
    description: 'Systematically debug a problem using MECE (Mutually Exclusive, Collectively Exhaustive) decomposition. Creates a hypothesis tree and guides structured elimination.',
    argsSchema: {
      problem: z.string().describe('The problem to debug (e.g., "API returns 500 for 5% of requests")'),
    },
  }, ({ problem }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: buildDebugPrompt(problem),
      },
    }],
  }));
}

function buildDebugPrompt(problem: string): string {
  return `Debug this problem using structured MECE reasoning with the tot-mcp tools:

**Problem:** ${problem}

## Methodology

Follow this systematic approach:

### Step 1: Create the tree
Call \`create_tree\` with the problem statement.

### Step 2: Decompose into MECE hypotheses
Call \`decompose\` to split the problem into 2-5 **mutually exclusive, collectively exhaustive** categories.

Good decomposition strategies:
- **By system layer**: network, application, data, infrastructure
- **By time**: before deploy, during deploy, after deploy
- **By component**: service A, service B, database, cache
- **By causality**: code bug, configuration, data issue, external dependency

Rules:
- Each hypothesis must be DISTINCT (no overlap between categories)
- Together they must COVER ALL possibilities (nothing missed)
- If unsure about exhaustiveness, add an "Other/Unknown" catch-all
- 2-5 hypotheses per level is ideal

### Step 3: Gather evidence systematically
For each hypothesis, call \`add_evidence\` with observations that either:
- **support** the hypothesis (makes it more likely)
- **refute** the hypothesis (makes it less likely)
- **neutral** (relevant but doesn't distinguish)

After each piece of evidence, consider: does this also affect sibling hypotheses?

### Step 4: Eliminate dead ends
When evidence clearly refutes a hypothesis, call \`eliminate_hypothesis\` with the reason.
Move on — don't spend more time on eliminated branches.

### Step 5: Go deeper
For the remaining hypotheses, call \`decompose\` again to create sub-hypotheses.
Repeat the evidence → eliminate cycle at each level.

### Step 6: Confirm root cause
When you have strong evidence pointing to a specific cause, call \`confirm_hypothesis\`.
Ask yourself: does this explain ALL observed symptoms?

## Key Principles

- **Never explore a single path linearly.** Always decompose first, then investigate.
- **Eliminate broadly before going deep.** Rule out entire categories before drilling into one.
- **Track your confidence.** Use \`score_hypothesis\` to maintain relative rankings.
- **Watch for stagnation.** If you're not making progress, restructure your decomposition.
- **Evidence must be discriminating.** Prefer evidence that distinguishes between hypotheses over evidence that confirms what you already suspect.

## Anti-patterns to avoid

- Going down a rabbit hole on the first plausible hypothesis
- Ignoring evidence that contradicts your favorite theory
- Decomposing into overlapping categories (e.g., "code bug" and "null pointer" are not exclusive)
- Stopping investigation after finding one issue without checking if it explains everything

Begin by calling \`create_tree\` with the problem statement, then \`decompose\` into your initial MECE hypotheses.`;
}
