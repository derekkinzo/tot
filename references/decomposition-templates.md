# Decomposition Templates

These are starting points, not prescriptive. The right axis depends on what cleanly partitions the cause space for the specific problem. A template that is MECE for one instance may overlap or leave gaps for another. Always validate the partition against the actual evidence before committing to a tree.

Where a template's advice conflicts with `mece-limits.md`, that document governs: overlap is a flag to interpret, not a fault to eliminate, and a combined hypothesis or an explicit catch-all is a legitimate child. The per-domain validation notes below say what a clean split would look like, not what is required of one.

## 1. Software Debugging

- **Trigger**: A program produces wrong output, crashes, hangs, or degrades. A reproducible (or partially reproducible) symptom exists.
- **Categories** (pick one axis per branch level):
  - By layer: code / data / infrastructure / external dependency
  - By scope: all users / subset / single user or request
  - By time: pre-change / post-change / gradual drift
  - By failure mode: crash / hang / incorrect result / slow
- **Validation**: Ask which bucket each observed symptom lands in. A symptom that plausibly belongs to two (e.g., "slow because of bad data") is either a sign the axis mixes dimensions, or a genuine co-occurrence — decide which before reading evidence, since one calls for a different axis and the other for a combined hypothesis.
- **Anti-pattern**: Mixing axes in siblings (e.g., "code bug" vs. "affects one user"). The two divide different dimensions, so no observation compares them, and the split records an axis that never described them. Nothing detects this: the axis is displayed, not checked.

## 2. Medical Differential Diagnosis

Differential diagnosis is fundamentally Bayesian: each candidate is weighted by prior probability and updated against evidence (see Wikipedia, "Differential diagnosis").

- **Trigger**: A patient presents with symptoms requiring identification of the underlying cause from competing hypotheses.
- **Categories**:
  - By anatomy: which organ system or region
  - By mechanism: infectious / inflammatory / neoplastic / vascular / metabolic / traumatic / iatrogenic
  - By acuity: acute / subacute / chronic
- **Validation**: The mechanism axis (often abbreviated VINDICATE — Vascular, Infectious, Neoplastic, Drug/Degenerative, Iatrogenic/Idiopathic, Congenital, Autoimmune, Traumatic, Endocrine — or similar mnemonics; see Wikipedia, "List of medical mnemonics") is broadly exhaustive for pathology. Confirm no candidate sits between two categories (e.g., paraneoplastic syndromes blur neoplastic and inflammatory) — if so, refine.
- **Anti-pattern**: Fixating on the most familiar mechanism (availability bias) and skipping low-prior-but-high-consequence buckets like vascular or iatrogenic.

## 3. Intelligence Analysis

The Analysis of Competing Hypotheses (ACH) method (Heuer, 1999, *Psychology of Intelligence Analysis*) requires enumerating hypotheses before weighing evidence, to counter confirmation bias.

- **Trigger**: An observed event of ambiguous origin or intent requires attribution.
- **Categories**:
  - By actor: state / non-state / criminal / accidental
  - By intent: signaling / probing / preparation / opportunistic
  - By capability: requires advanced resources / commodity capability / insider access
- **Validation**: Each hypothesis must be evaluated against every piece of evidence (ACH matrix). MECE holds if no observed indicator is consistent with all hypotheses equally — that means the partition is not discriminating.
- **Anti-pattern**: Anchoring on the most likely actor before considering accidental or false-flag explanations, collapsing the tree prematurely.

## 4. Engineering Root Cause

- **Trigger**: A physical or mechanical system has failed, and the cause must be localized for repair, redesign, or liability.
- **Categories**:
  - By failure stage: design / manufacturing / operation / environment
  - By component: each subsystem or part
  - By failure mode: fatigue / fracture / corrosion / wear / overload / thermal
- **Validation**: For a single failed unit, the failure stage axis is typically MECE. For a fleet, recurring patterns may span stages (e.g., a design flaw revealed only under specific operational stress) — surface that interaction explicitly rather than forcing one bucket.
- **Anti-pattern**: Stopping at the proximate component failure ("the bolt sheared") without continuing to root cause on the failure-stage axis (why did the bolt see that load?).

## 5. Scientific Causal Inference

Mill's canons (Mill, 1843, *A System of Logic*) provide five complementary methods for isolating cause from correlation.

- **Trigger**: A phenomenon recurs under varying conditions and the causal factor must be isolated from confounders.
- **Categories** (Mill's canons):
  - Method of Agreement: factor common to all positive instances
  - Method of Difference: factor present in positive but absent in negative
  - Joint Method of Agreement and Difference: factor identified by combining the two preceding methods across positive and negative instances
  - Method of Concomitant Variation: factor that varies in degree with the effect
  - Method of Residue: factor remaining after known causes are subtracted
- **Validation**: The five methods are complementary, not mutually exclusive — a strong causal claim usually satisfies more than one. Treat them as a checklist, not a partition; "MECE" here means each method has been considered, not that exactly one applies.
- **Anti-pattern**: Relying solely on Agreement (correlation) without applying Difference (controlled comparison), producing spurious causal claims.

## Choosing an Axis

When none of the above templates cleanly fit, derive an axis from the problem itself:
- What dimension of the system, if held constant, would eliminate the symptom?
- What dimension, if varied, reproduces or removes the symptom?
- What categorical distinction matches the granularity of the available evidence?

A good axis produces siblings that divide one dimension, so that an observation can bear on one and not another. Judge a candidate axis before decomposing: a split cannot be redrawn once its children exist, and neither exclusivity nor exhaustiveness can be established from the tree afterwards.

Once a split exists, the reachable moves are `add_hypothesis` for a possibility the set misses, `decompose` on a child to divide a second dimension below it, and `set_out_of_scope` for a branch this investigation will not pursue. Overlap that turns out to be real domain co-occurrence is not a defect to repair — record it as a combined hypothesis and read the evidence accordingly.
