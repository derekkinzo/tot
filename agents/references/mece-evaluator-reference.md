# MECE Evaluator Reference

Reference material for an agent that evaluates hypothesis tree decompositions and identifies structural problems.

---

## 1. MECE Core Theory

### Formal Definition

MECE (Mutually Exclusive, Collectively Exhaustive) is a grouping principle from structured problem-solving methodology (McKinsey, BCG). A set of categories is MECE when:

- **Mutually Exclusive (ME)**: Every item belongs to exactly ONE category. No item can be classified under two categories simultaneously. The categories have zero intersection.
- **Collectively Exhaustive (CE)**: Every possible item belongs to at least one category. The categories, taken together, cover the entire problem space with no gaps.

Formal: Given universe U and partition {C1, C2, ..., Cn}:
- ME: Ci intersect Cj = empty set, for all i != j
- CE: C1 union C2 union ... union Cn = U

### Detecting Overlaps (ME Violations)

A decomposition violates mutual exclusivity when a single observation, root cause, or piece of evidence could legitimately be classified under more than one category.

**Detection heuristics:**

1. **Subset test**: Is category A a specific instance of category B? (e.g., "DNS failure" is a subset of "network issue")
2. **Dual-membership test**: Can you construct a concrete scenario that fits two categories? If yes, the split is not exclusive.
3. **Boundary ambiguity**: If classifying an item requires subjective judgment about which category it belongs to, the boundary is ill-defined.
4. **Causal chain overlap**: If A causes B and both are categories, any instance of B caused by A belongs to both.

### Detecting Gaps (CE Violations)

A decomposition violates collective exhaustiveness when a plausible item exists that does not fit any category.

**Detection heuristics:**

1. **Adversarial scenario**: Try to construct a concrete failure scenario not covered by any hypothesis. If you can, the decomposition has a gap.
2. **Domain boundary check**: Does the decomposition assume constraints that may not hold? (e.g., "either client bug or server bug" ignores network-in-transit)
3. **Temporal blind spots**: Does the decomposition cover only current state but miss historical or transitional states?
4. **Missing "other"**: In diagnostic contexts, a catch-all ("unknown/other") is a pragmatic CE guarantee. Its absence is a signal (not necessarily a flaw) to examine.
5. **Implicit assumptions**: List what the decomposition takes for granted. Each assumption is a potential gap.

### Abstraction Level and MECE Compliance

MECE only holds within a consistent level of abstraction. Mixing levels creates both overlaps and gaps:

- A high-level category ("infrastructure issue") overlaps with any specific instance ("disk full") because the specific is contained within the general.
- Items at different abstraction levels cannot be meaningfully tested for mutual exclusivity — they exist on different planes.

**Rule**: All children of a single parent node must be at the same level of specificity. The test: would investigating each child require approximately the same "depth of zoom"?

---

## 2. Decomposition Strategies

### Issue Trees (McKinsey)

**Principle**: Decompose a question into sub-questions whose answers, combined, answer the parent. Split on a single axis at each level.

**Splitting axes**: Component, cause, time, scope, owner, process stage.

**When to use**: Open-ended problems where the solution space is large and unstructured. Particularly when you need to communicate the investigation structure to others.

**When inappropriate**: When the problem is well-understood and the cause is likely singular. Overhead of full decomposition exceeds value.

**MECE validation**: At each split, ask: (1) Do any two branches share possible answers? (2) If you answered all branches, would you have a complete answer to the parent?

### Logic Trees

Two variants:

**Hypothesis-driven (top-down)**: Start with candidate answers and structure tests. Each branch is "if this hypothesis is true, what would we observe?" Split by potential root cause.

**Analysis-driven (bottom-up)**: Start with available data and organize into categories. Each branch is a data grouping. Split by observable attribute.

**When to use hypothesis-driven**: Debugging, root cause analysis, time-constrained investigation. Prioritizes fast elimination.

**When to use analysis-driven**: Data exploration, unfamiliar domains, when you lack enough context for strong hypotheses.

**MECE validation**: Hypothesis trees — check that hypotheses are mutually exclusive as EXPLANATIONS (one excludes the others). Analysis trees — check that categories are mutually exclusive as CLASSIFICATIONS (each datum has one home).

### Fault Trees (Engineering RCA)

**Principle**: Start from the undesired event (top) and decompose into combinations of causes using AND/OR gates. Works backward from effect to cause.

**Splitting logic**:
- OR gate: Any single child can independently cause the parent (redundant paths to failure)
- AND gate: All children must be true simultaneously for the parent to occur (conjunctive failure)

**When to use**: Safety-critical systems, hardware failures, well-understood causal mechanisms. When you need to identify ALL paths to failure, not just the most likely.

**When inappropriate**: Exploratory debugging where causal mechanisms are unknown. Software bugs where failure modes are not well-characterized in advance.

**MECE validation**: OR gates must cover all independent paths to the parent event. AND gates must list all necessary conditions. Test: remove one child from an AND gate — can the parent still occur? If yes, the child is not necessary.

### Ishikawa / Fishbone (6M Categories)

**Principle**: Categorize potential causes using standard frames:
- **Man** (People): Training, skill, error, workload
- **Machine** (Equipment): Hardware, software, tools, capacity
- **Method** (Process): Procedure, workflow, configuration, architecture
- **Material** (Inputs): Data quality, upstream feeds, dependencies
- **Measurement** (Metrics): Observability gaps, misleading metrics, alert thresholds
- **Mother Nature** (Environment): Network, infrastructure, external services, load

**When to use**: Brainstorming phase when you need to ensure coverage across domains. Good for generating hypotheses before structuring them into a tree.

**When inappropriate**: As a final decomposition structure. The 6M categories often overlap in software contexts (e.g., a configuration error is both "Method" and "Machine"). Better as a generation tool than an organization tool.

**MECE validation**: The 6M frame is CE by convention (it covers all inputs to a process) but often NOT ME in practice. Use for generation, then re-organize into a properly MECE structure.

### SWIFT (Structured What-If Technique)

**Principle**: Systematically walk through a process asking "what if X deviates from expected?" at each step. Generates failure modes from process deviation.

**When to use**: When you have a clear expected process/flow and want to find where it could go wrong. Good for configuration review, deployment analysis, data pipeline debugging.

**When inappropriate**: When the process itself is unknown or when the failure is emergent rather than localized to a step.

**MECE validation**: SWIFT is CE within its scope (it covers all steps) but may miss cross-cutting concerns that span multiple steps. Check for emergent failures not attributable to any single step.

### 5 Whys

**Principle**: Iteratively ask "why?" to drill from symptom to root cause. Each answer becomes the next question.

**When it works**: Simple causal chains with a single dominant path. Good for shallow problems where the first "why" reveals a clear direction.

**When it leads to false convergence**: Complex systems with multiple contributing causes. The 5 Whys forces a linear chain and cannot represent branching causality. It anchors on the first plausible path and ignores alternatives.

**MECE relationship**: 5 Whys is NOT a MECE decomposition — it is depth-first traversal of a single branch. Use it WITHIN a branch of a MECE tree, never as the tree structure itself.

### Decision Trees vs Hypothesis Trees

| Property | Decision Tree | Hypothesis Tree |
|----------|--------------|-----------------|
| Purpose | Choose an action | Identify a cause |
| Leaves | Outcomes/recommendations | Root causes |
| Traversal | Follow the path matching observations | Investigate all paths in parallel |
| MECE requirement | At each split (observation-based) | At each decomposition (cause-based) |
| Ordering | Splits ordered by information gain | Hypotheses investigated by discriminating power |

---

## 3. Common Anti-Patterns

### 3.1 Overlapping Categories (ME Violation)

**Pattern**: Two categories where one is a subset, instance, or consequence of the other.

**Examples**:
- BAD: ["Network issue", "DNS failure", "Timeout"] — DNS is a type of network issue; timeout is a symptom of either
- BAD: ["Code bug", "Null pointer exception"] — NPE is a specific code bug
- BAD: ["Database problem", "Slow queries"] — slow queries are one manifestation of a database problem
- BAD: ["Authentication failure", "Expired token"] — expired token is one cause of auth failure

**Fix**: Choose a single axis. Either decompose by component (DNS / routing / TLS / application-layer) or by symptom (timeout / wrong response / connection refused), not both.

### 3.2 Missing Catch-All (CE Violation)

**Pattern**: A decomposition that feels complete but excludes edge cases, compound causes, or unknown unknowns.

**Examples**:
- BAD: ["Client bug", "Server bug"] — misses network, data corruption, configuration, infrastructure
- BAD: ["Code change caused it", "Config change caused it"] — misses data change, external dependency change, gradual degradation

**Fix**: Add an explicit "Other / Unknown" category when the domain is not fully enumerable. This is not laziness — it is an honest acknowledgment of epistemic limits. The catch-all can be decomposed later if evidence points there.

### 3.3 Wrong Abstraction Level (Level Mixing)

**Pattern**: Sibling hypotheses at different depths of specificity. One is broad and one is narrow.

**Examples**:
- BAD: ["Server crashed", "Memory leak in RequestHandler.processAsync()"] — the second is several levels deeper than the first
- BAD: ["Infrastructure issue", "The us-east-1a AZ had a network partition at 3:42pm"] — mixing a category with a specific finding
- BAD: ["Performance regression", "Added N+1 query in commit abc123"] — one is a symptom class, the other is an already-diagnosed cause

**Fix**: All siblings must answer the same question at the same granularity. If one hypothesis requires a single test to verify and another requires an entire sub-investigation, they are at different levels.

**Diagnostic**: Count the "steps to verify" for each sibling. If they vary by more than 2x, suspect level mixing.

### 3.4 Circular Decomposition (Tautology)

**Pattern**: Sub-hypotheses that restate the parent problem rather than breaking it into distinct failure modes.

**Examples**:
- Parent: "API is slow"
- BAD children: ["API response time is high", "API latency exceeds SLA"] — these restate the parent
- GOOD children: ["CPU-bound processing in handler", "Database query latency", "Network hop latency", "Serialization overhead"]

- Parent: "Users cannot log in"
- BAD children: ["Login is broken", "Authentication is failing"] — synonyms of the parent
- GOOD children: ["Credential validation fails", "Session creation fails", "Redirect loop after auth", "IdP unreachable"]

**Fix**: Each child must name a MECHANISM or LOCATION, not a restatement of the symptom. Test: if you replaced the child with the parent, would the meaning change? If not, it is circular.

### 3.5 False Dichotomy (Incomplete Binary Split)

**Pattern**: Splitting into exactly two options when the real space has more, often driven by a desire for simplicity.

**Examples**:
- BAD: ["It's a code bug" vs "It's an infrastructure issue"] — misses configuration, data, external dependencies
- BAD: ["The change caused it" vs "The change didn't cause it"] — true but useless; if it didn't cause it, WHAT did?
- BAD: ["Client-side" vs "Server-side"] — misses network-in-transit, CDN, proxy layer

**Fix**: When tempted to binary split, ask: "What third option am I assuming away?" Exhaust at least 3-5 genuine categories before accepting a binary split. Binary splits are valid only when the axis is truly binary (e.g., "before timestamp T / after timestamp T").

### 3.6 Premature Specificity

**Pattern**: Jumping directly to solution-level hypotheses without first establishing problem-level decomposition.

**Examples**:
- BAD first decomposition: ["Memory leak in AuthService", "Race condition in QueueProcessor", "Missing index on users table"]
- These are all plausible root causes, but they skip the structural frame that would organize the search.
- GOOD first decomposition: ["Application code issue", "Data/state issue", "Infrastructure issue", "External dependency issue"]
- Then drill into each with specific mechanisms.

**Why it matters**: Premature specificity anchors the investigation on early guesses and makes it hard to discover causes outside your initial mental model. It also tends to produce non-MECE sets (the specific causes might overlap in their parent category).

**Fix**: Decompose in layers. First level: broad categories. Second level: mechanisms within each category. Third level: specific instances. Each level's hypotheses are testable at that level's granularity.

### 3.7 Correlation as Causation (Symptom-Based Decomposition)

**Pattern**: Decomposing by observed symptoms rather than by causal mechanisms. Symptoms can co-occur, making them non-exclusive. Multiple symptoms may share a single cause.

**Examples**:
- BAD: ["High latency", "Error rate spike", "Memory growth"] — these are symptoms; a single root cause might produce all three
- GOOD: ["Resource exhaustion", "Upstream dependency failure", "Code regression", "Traffic spike"] — these are mechanisms

**Why it matters**: Symptom-based decomposition leads to "confirming" multiple hypotheses simultaneously (because they share a cause) and never converging on the actual root cause.

**Fix**: Decompose by MECHANISM (what could cause the observed symptoms) not by SYMPTOM (what you observe). Symptoms are evidence, not hypotheses.

---

## 4. Domain-Specific MECE Templates (Software Debugging)

These are pre-validated decomposition frames for common software investigation scenarios. Each frame provides an axis that is MECE by construction for its domain.

### By System Layer

```
[Application code] | [Data/state] | [Infrastructure] | [Network] | [External dependency]
```

- **Application code**: Logic bugs, regressions, misconfigurations in application code
- **Data/state**: Corrupt data, unexpected input, stale cache, inconsistent state
- **Infrastructure**: Host issues, resource exhaustion, deployment artifacts, runtime environment
- **Network**: DNS, routing, TLS, connectivity, bandwidth, latency
- **External dependency**: Third-party API, upstream service, shared resource degradation

**Validation**: These are ME because they represent distinct layers of the stack. CE because any software system failure must manifest at one of these layers.

### By Scope (Who Is Affected)

```
[All users/requests] | [Subset of users] | [Single user/request] | [Specific conditions only]
```

- **All**: Universal failure — points to systemic cause
- **Subset**: Correlated subset — points to shared attribute (region, account type, shard)
- **Single**: Isolated — points to user-specific state or data
- **Specific conditions**: Trigger-dependent — points to input validation, edge case, race condition

**Validation**: ME because scope categories are by definition non-overlapping (a failure either affects all or it does not). CE because these cover the full range from universal to singular.

### By Temporal Pattern

```
[Sudden onset after change] | [Gradual degradation] | [Periodic/cyclical] | [Always present (newly detected)]
```

- **Sudden onset**: Correlates with deployment, config change, or external event
- **Gradual**: Resource leak, data accumulation, drift over time
- **Periodic**: Cron jobs, traffic patterns, cert rotation, cache expiry
- **Always present**: Pre-existing condition newly observed due to monitoring change or threshold crossed

**Validation**: ME because temporal signatures are distinct observable patterns. CE because any failure must have one of these temporal profiles.

### By Component (Service-Oriented)

```
[Service A] | [Service B] | [Integration between A and B] | [Shared dependency]
```

Adapt to actual architecture. The key insight is that **integration** is its own category — many failures occur not within a service but in the contract between services (serialization, protocol, version mismatch, timeout mismatch).

### By Failure Mode

```
[Crash/exception] | [Hang/deadlock] | [Incorrect result] | [Performance degradation] | [Partial failure]
```

- **Crash**: Process terminates abnormally
- **Hang**: Process alive but not progressing
- **Incorrect result**: Completes but wrong output
- **Performance**: Correct but too slow
- **Partial**: Some requests succeed, others fail

**Validation**: ME because these are distinct observable behaviors (a request either crashes OR hangs OR returns wrong data — not two simultaneously from the same cause). CE for synchronous request-response systems; may need extension for async/streaming.

### By Root Cause Category

```
[Code bug] | [Configuration error] | [Data corruption] | [Resource exhaustion] | [Dependency failure] | [Concurrency issue]
```

- **Code bug**: Logic error in application code (regression, missing case, wrong algorithm)
- **Configuration**: Correct code with wrong settings (feature flag, threshold, endpoint URL)
- **Data corruption**: Valid code + valid config but bad state (schema drift, encoding, stale record)
- **Resource exhaustion**: System limits hit (memory, disk, file descriptors, connections, rate limits)
- **Dependency failure**: External system unavailable or degraded (database, cache, API, DNS)
- **Concurrency**: Race condition, deadlock, ordering violation (correct in isolation, fails under parallelism)

**Validation**: These are ME as categories of mechanism. Note: a real root cause may COMBINE categories (e.g., "code bug triggers resource exhaustion"), but the PRIMARY mechanism belongs to one. If the real answer is a chain, the deepest WHY determines the category.

---

## 5. Evaluation Criteria

Use these tests to evaluate whether a decomposition is structurally sound.

### Completeness Test (CE)

**Question**: Can every possible root cause fit into exactly one bucket?

**Procedure**:
1. Generate 3 adversarial scenarios not obviously covered by the existing hypotheses.
2. For each scenario, attempt to classify it. If classification requires stretching a category's definition, the decomposition has a gap.
3. Check domain boundaries: does the decomposition assume constraints that may not hold? (e.g., "the problem is in our code" assumes it cannot be in a dependency)

**Pass criteria**: Every plausible cause maps to exactly one category without stretching definitions. Alternatively, an explicit catch-all exists.

### Overlap Test (ME)

**Question**: If you found evidence for hypothesis A, could that same evidence also count as evidence for hypothesis B?

**Procedure**:
1. For each pair of siblings, construct a concrete scenario that fits both.
2. If such a scenario exists AND is plausible (not a pathological edge case), the pair overlaps.
3. Check for subset relationships: is A a specific instance of B?
4. Check for causal chains: does A cause B or vice versa?

**Pass criteria**: No plausible scenario fits two categories. Or: the overlap is acknowledged and the tie-breaking rule is explicit.

### Testability Test

**Question**: Can each hypothesis be independently confirmed or refuted by observable evidence?

**Procedure**:
1. For each hypothesis, state what evidence would REFUTE it.
2. For each hypothesis, state what evidence would CONFIRM it (beyond "consistent with").
3. If you cannot articulate a falsification test, the hypothesis is untestable (too vague, too abstract, or circular).

**Pass criteria**: Each hypothesis has at least one specific, executable test whose outcome differs depending on whether the hypothesis is true or false.

### Actionability Test

**Question**: If confirmed, does each hypothesis suggest a specific next step or fix?

**Procedure**:
1. For each hypothesis, assume it is the confirmed root cause. What do you DO?
2. If the answer is "investigate further" rather than "fix X", the hypothesis is too abstract and should be decomposed further.
3. Leaf-level hypotheses should map to concrete actions.

**Pass criteria**: Confirmed hypotheses at the current investigation depth imply clear actions. (Non-leaf hypotheses get decomposed rather than actioned, which is fine.)

### Level Alignment Test

**Question**: Are all sibling hypotheses at the same depth of specificity?

**Procedure**:
1. For each sibling, estimate "steps to verify" — how many tests or investigations would it take to confirm/refute?
2. Compare the estimates across siblings. If they vary by more than 3x, suspect level mixing.
3. Count words in each hypothesis label. If labels vary by more than 3x in length, this correlates with abstraction mismatch.
4. Check: could one sibling be a CHILD of another sibling? If yes, they are at different levels.

**Pass criteria**: All siblings require approximately the same depth of investigation. No sibling is a subset or instance of another sibling.

### Diagnosticity Test

**Question**: Does each hypothesis predict different observations from its siblings?

**Procedure**:
1. For each hypothesis, list what observations you would expect if it were true.
2. Compare predicted observations across siblings. If two siblings predict the same observations, they are not diagnostically distinct — evidence cannot separate them.
3. If hypotheses cannot be distinguished by any feasible test, they should either be merged or re-split on a different axis.

**Pass criteria**: For each pair of siblings, there exists at least one observable that would have different values depending on which sibling is true.

---

## 6. Evaluation Workflow

When evaluating a decomposition, apply checks in this order:

1. **Level Alignment** — fast to check, foundational issue
2. **Overlap (ME)** — pairwise comparison of siblings
3. **Completeness (CE)** — adversarial scenario generation
4. **Testability** — can each be falsified?
5. **Diagnosticity** — can siblings be distinguished?
6. **Actionability** — does confirmation lead to action?

Report findings as:
- **Critical** (blocks progress): overlaps, circular decomposition, untestable hypotheses
- **Warning** (reduces efficiency): missing catch-all, level misalignment, low diagnosticity
- **Note** (suggestion): could reframe for clarity, alternative axis might be stronger

---

## 7. Repair Strategies

When violations are detected, apply these corrective patterns:

| Violation | Repair |
|-----------|--------|
| Subset overlap (A contains B) | Promote B to be a child of A, or replace A with "A excluding B" |
| Causal chain overlap (A causes B) | Keep the deeper cause (A), remove the symptom (B) |
| Missing coverage | Add explicit catch-all, OR identify the missing axis and add categories |
| Level mixing | Demote the specific item to be a child of its abstract sibling |
| Circular restatement | Replace with mechanism-level hypotheses (HOW, not WHAT) |
| False dichotomy | Expand to 3-5 categories by questioning implicit assumptions |
| Premature specificity | Insert an intermediate abstraction layer above the specific hypotheses |
| Symptom-based split | Re-decompose by causal mechanism rather than observable symptom |
