---
name: tot-reason
description: Use this skill when investigating a problem with multiple competing hypotheses — root cause analysis, differential diagnosis, scientific inquiry, intelligence analysis, multi-factor decision-making — or when the user asks to "use tree of thought", "investigate this systematically", or "build a hypothesis tree". Provides structured hypothesis tree reasoning grounded in falsificationism and eliminative induction.
argument-hint: [problem-description]
---

# /tot-reason

Initiate structured Tree of Thought reasoning for systematic investigation of a problem with rival explanations.

## When to Use

- Root cause analysis across any system (technical, biological, organizational, environmental) where multiple causes compete
- Differential diagnosis: which condition best explains the observations
- Scientific inquiry: choosing among rival hypotheses for an empirical question
- Intelligence analysis: weighing competing explanations against fragmentary evidence
- Multi-factor decisions where the right answer depends on disentangling correlated possibilities
- Any investigation where linear reasoning would lead down a single rabbit hole

## Protocol

### Domain investigation

BEFORE creating hypotheses, investigate the problem domain thoroughly:

1. **Gather context**: What is the relevant background? What is already known? What is the data set, the population, the system, or the situation?
2. **Characterize the question**: What observations are being explained, or what decision is being made? What is the scope?
3. **Identify boundaries**: What is IN scope vs OUT of scope? (Mill's Method of Difference: contrast cases where the effect occurs against cases where it does not.)

Fan out subagents to research the domain from multiple angles simultaneously.

### Create the tree

Call `create_tree` with a clear, specific problem statement. Include the observations, the scope, and any relevant background.

### Decompose into competing hypotheses

Call `decompose` with 2-5 sibling hypotheses that are comparable along a single framing axis:

- **By mechanism**: distinct causal pathways that could produce the same effect
- **By location or layer**: where in the system the cause sits
- **By stage or time**: phase of the process or moment in time
- **By actor or population**: who or what is affected, or who is acting
- **By category**: type of object, condition, or class of agent

The siblings form a partition of the explanation space (cf. Chamberlin's method of multiple working hypotheses, 1890; Mill's joint methods, 1843):
- **Distinct siblings**: each hypothesis covers a different possibility unless co-occurrence is real (Mackie's INUS conditions describe genuinely compound causes).
- **Collective coverage**: together they cover the plausible space; an explicit catch-all branch is first-class when exhaustiveness is uncertain.

After decomposing, STOP and review:
- Dispatch the `decomposition-evaluator` subagent to advise on overlap, coverage, level of abstraction, and testability.
- Dispatch the `hypothesis-challenger` subagent on each child to surface missing alternatives and hidden assumptions.
- Could a single observation belong to two of these by accident? If yes, refine boundaries.
- Is there a plausible explanation NOT covered by any sibling or catch-all? If yes, add it.

### Gather evidence

For EACH hypothesis, seek REFUTING evidence (falsification-first per Popper):

1. Define what observation would REFUTE this hypothesis.
2. Execute the most discriminating test first (one whose outcome is predicted by one sibling but not the others — cf. Platt's strong inference, 1964).
3. Call `add_evidence` with type `supports`, `refutes`, or `neutral`.
4. Fan out subagents to investigate from independent data sources, then dispatch the `evidence-reviewer` subagent to audit directness, source diversity, and diagnosticity before relying on the result.

Key principles:
- Seek evidence that DISCRIMINATES between hypotheses, not just confirms a favored one.
- Triangulate from multiple independent sources (records, measurements, observations, controlled tests).
- A strong test predicts different outcomes for different hypotheses.

### Eliminate, set aside, or corroborate

- Call `eliminate_hypothesis` when refuting evidence is decisive. Bind the verdict to the supporting refuting-evidence ids so the audit trail is preserved.
- Call `set_out_of_scope` when a branch is plausible but outside the scope of this investigation. Distinct from elimination — it sets a branch aside without claiming refutation.
- Call `score_hypothesis` to track relative confidence among live siblings.
- Drill deeper: call `decompose` on surviving hypotheses to test sub-causes.
- Call `corroborate_hypothesis` when the hypothesis has survived the refutation tests applied to it. Per Popper, corroboration is provisional retention, not verification — the verdict can be reopened by later refuting evidence.

The session resolves only when every other top-level branch is terminal (eliminated, corroborated, or out-of-scope). Multiple corroborated branches are valid: many real-world outcomes have compound causes.

### Verify

Before declaring done:
- Does the surviving hypothesis (or set of hypotheses) account for all the relevant observations?
- Have you considered whether multiple factors jointly produced the outcome?
- Could new evidence reopen the verdict?

## Visualization

The tree is visible in real-time at `http://localhost:6274`. Open it to see:
- Color-coded hypothesis statuses (blue=pending, yellow=exploring, red=eliminated, green=corroborated, purple=out-of-scope)
- Evidence attached to each node
- Path highlighting from root to selected hypothesis

## Tips

- Never investigate linearly — always maintain multiple competing hypotheses (cf. Chamberlin's method of multiple working hypotheses, 1890).
- If stuck (stagnation), apply devil's advocate: assume your LOWEST-scored hypothesis is correct and look for evidence that would corroborate it.
- Deep decompositions (depth 3+) risk fragmenting — ask if the parent is directly testable instead.
- Always seek the CRUCIAL EXPERIMENT: one observation that gives different results under different hypotheses.
