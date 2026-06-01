---
name: tot-reason
description: Use this skill when investigating bugs, debugging failures, performing root cause analysis, or when the user asks to "use tree of thought", "debug this systematically", "investigate this", or "MECE analysis". Provides structured hypothesis tree reasoning with scientific protocols.
argument-hint: [problem-description]
---

# /tot-reason

Initiate structured Tree of Thought reasoning for systematic problem investigation.

## When to Use

- Debugging complex failures (500 errors, intermittent issues, performance regressions)
- Root cause analysis where multiple competing hypotheses exist
- Any investigation where linear reasoning leads to rabbit holes
- When the user explicitly requests structured/systematic debugging

## Protocol

### Phase 1: Domain Investigation

BEFORE creating hypotheses, investigate the problem domain thoroughly:

1. **Gather context**: What is the problem domain? What changed recently in the system or environment? When did it start?
2. **Characterize symptoms**: Who/what is affected? What is the scope? Is it intermittent or constant?
3. **Identify boundaries**: What is IN scope vs OUT of scope? (Mill's Method of Difference: contrast cases where the effect occurs against cases where it does not.)

Fan out subagents to research the domain from multiple angles simultaneously.

### Phase 2: Create Tree

Call `create_tree` with a clear, specific problem statement. Include:
- The symptom (what is observed)
- The scope (who/what is affected)
- The timeline (when it started, what changed)

### Phase 3: MECE Decomposition

Call `decompose` with 2-5 hypotheses that are:
- **Mutually Exclusive**: Each covers a DISTINCT failure mode — no overlaps
- **Collectively Exhaustive**: Together they cover ALL plausible explanations

Decomposition forms a partition of the cause space (Chamberlin 1890; Mill 1843).

Decomposition strategies:
- By system layer (code / data / infrastructure / external)
- By scope (all users / subset / specific conditions)
- By time (before/after change / gradual degradation)
- By component (service A / service B / integration layer)

After decomposing, STOP and review:
- Fan out subagents to validate each hypothesis is truly distinct
- Check: Could a single cause belong to two categories? If yes, refine boundaries.
- Check: Can you imagine a cause NOT covered? If yes, add it.

### Phase 4: Evidence Gathering

For EACH hypothesis, seek REFUTING evidence (falsification-first):
1. Define what test would REFUTE this hypothesis
2. Execute the most discriminating test first (one that separates hypotheses)
3. Call `add_evidence` with type `supports`, `refutes`, or `neutral`
4. Fan out subagents to investigate from independent angles

Key principles:
- Seek evidence that DISCRIMINATES between hypotheses, not just confirms one
- Test from multiple independent data sources (logs, metrics, code, reproduction)
- A strong test is one whose outcome is predicted by ONE hypothesis but NOT its siblings

### Phase 5: Eliminate and Confirm

- Call `eliminate_hypothesis` when 2+ refuting evidence with documented reasoning
- Call `score_hypothesis` to track relative confidence
- Drill deeper: call `decompose` on surviving hypotheses to test sub-causes
- Call `confirm_hypothesis` only when:
  1. You can REPRODUCE the issue by triggering this cause
  2. All competing hypotheses were eliminated with evidence
  3. The cause preceded the failure in time (temporality)
  4. The cause explains THIS specific failure pattern (specificity)

### Phase 6: Verification

Before declaring done:
- Can you reproduce the failure?
- Does the fix actually resolve it?
- Are there contributing factors beyond the root cause?

## Visualization

The tree is visible in real-time at `http://localhost:6274`. Open it to see:
- Color-coded hypothesis statuses (blue=pending, yellow=exploring, red=eliminated, green=confirmed)
- Evidence attached to each node
- Path highlighting from root to selected hypothesis

## Tips

- Never investigate linearly — always maintain multiple competing hypotheses
- If stuck (stagnation), apply devil's advocate: assume your LOWEST-scored hypothesis is correct
- Deep decompositions (depth 3+) risk fragmenting — ask if the parent is testable directly
- Always seek the CRUCIAL EXPERIMENT: one observation that gives different results per hypothesis
