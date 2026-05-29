# Evidence & Hypothesis Challenge Reference

Reference material for agents that challenge hypotheses and review evidence quality.

---

## Evidence Hierarchy (Strongest to Weakest)

| Level | Type | Example | Sufficiency |
|-------|------|---------|-------------|
| 1 | Intervention/Reproduction | Fix applied AND problem disappears | Definitive |
| 2 | Direct observation of mechanism | Stack trace, memory dump, packet capture | Very strong |
| 3 | Controlled comparison | Before/after with single variable (rollback, toggle) | Strong |
| 4 | Multiple independent corroborations | 3+ sources pointing to same cause | Moderate-strong |
| 5 | Single direct observation | One log entry, one metric spike | Moderate |
| 6 | Inference from documentation | "Docs say this throws when..." | Weak |
| 7 | Analogy to past incidents | "Last time this pattern meant..." | Very weak |

**Rule**: Do not confirm a hypothesis without at least Level 3 evidence. Levels 5-7 guide investigation but cannot confirm.

---

## Independence Assessment

**Independent** (genuinely separate observations):
- Log analysis + independent reproduction attempt
- Metric from service A + metric from unrelated service B
- Code review finding + runtime observation confirming it

**Dependent** (same observation counted twice):
- Multiple log lines from the same request trace
- A metric alarm AND the logs that generated the metric
- Two symptoms of the same downstream failure

**Test**: "If I removed evidence X, would evidence Y still exist and point the same direction?"

---

## Diagnosticity Assessment

Evidence is diagnostic when it has different probabilities under competing hypotheses.

- **High diagnosticity**: "Error only occurs on hosts running v2.3.1" (separates code bug from infra issue)
- **Low diagnosticity**: "CPU is elevated" (consistent with many hypotheses)
- **Zero diagnosticity**: "The system has logs" (true regardless of cause)

**Test**: "Would this evidence look the same if [alternative hypothesis] were true?"

---

## Hypothesis Challenge Techniques

### 1. Inversion Testing
If H claims "X causes Y": look for X without Y, or Y without X.

### 2. Alternative Generation
For any symptom set, enumerate ALL plausible causes before investigating any one.

### 3. Mechanism Tracing
Trace the causal chain link by link. A → B → C → Effect. Verify each link independently.

### 4. Boundary Testing
Does the hypothesis explain ALL instances? If only some, it's incomplete or wrong.

### 5. Parsimony Check
How many assumptions does this require? Is there a simpler single-cause explanation?

### 6. Prediction Testing
If hypothesis is correct, what ELSE must be true? Test those predictions.

### 7. Steel-Manning
Build the strongest case for the LEAST likely alternative. What evidence would exist?

---

## Cognitive Bias Detection

| Bias | Observable Pattern | Detection Signal |
|------|-------------------|-----------------|
| Confirmation | 3+ supporting, 0 refuting | Unidirectional evidence |
| Anchoring | First hypothesis scored highest despite equal evidence | Position bias |
| Tunnel vision | One branch at depth 3+ while siblings unexplored | Depth imbalance |
| Premature closure | Confirmed with <3 evidence, siblings not eliminated | Insufficient rigor |
| Narrative bias | All evidence uses inference language ("suggests", "likely") | No direct observations |
| Sunk cost | 5+ evidence items but net refuting, still not eliminated | Refusing to abandon |

---

## Stopping Criteria

### Ready to Confirm
- Level 1-3 evidence obtained
- All alternatives eliminated with evidence (not ignored)
- Refutation attempted and survived
- Novel prediction tested
- Mechanism at least partially traced

### Ready to Eliminate
- Level 2+ evidence directly contradicts mechanism, OR
- Controlled comparison shows no effect, OR
- 2+ independent observations inconsistent with hypothesis

### Need More Evidence
- Score between 0.3 and 0.85
- Fewer than 2 pieces of diagnostic evidence
- No refutation attempt made
- Evidence from single source only

---

## Key References

- Platt (1964) "Strong Inference" — crucial experiments
- Heuer (1999) "Psychology of Intelligence Analysis" — ACH, diagnosticity
- Popper (1959) "Logic of Scientific Discovery" — falsification
- Hill (1965) "The Environment and Disease" — causal criteria
- Zeller (2009) "Why Programs Fail" — scientific debugging
- Ko & Myers (2004) — how developers form/test hypotheses
