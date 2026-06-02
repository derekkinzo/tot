# Decomposition Templates

These are starting points, not prescriptive. The right axis depends on what cleanly partitions the cause space for the specific problem. A template that is MECE for one instance may overlap or leave gaps for another. Always validate the partition against the actual evidence before committing to a tree.

## 1. Software Debugging

- **Trigger**: A program produces wrong output, crashes, hangs, or degrades. A reproducible (or partially reproducible) symptom exists.
- **Categories** (pick one axis per branch level):
  - By layer: code / data / infrastructure / external dependency
  - By scope: all users / subset / single user or request
  - By time: pre-change / post-change / gradual drift
  - By failure mode: crash / hang / incorrect result / slow
- **Validation**: Every observed symptom must fit exactly one bucket on the chosen axis. If a symptom plausibly belongs to two (e.g., "slow because of bad data"), the axis is wrong for this case — pick a different one or split further.
- **Anti-pattern**: Mixing axes in siblings (e.g., "code bug" vs. "affects one user") — these are not mutually exclusive and the tree loses meaning.

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

A good axis produces siblings that are evidently mutually exclusive (no candidate fits two) and collectively exhaustive (no plausible candidate fits none). If either property fails, change the axis before deepening the tree.
