# MECE and Set Partition

## 1. Set Partition Definition

Let X be a non-empty set (the universe of discourse). A **partition** of X is a
family P = {B_i : i in I} of subsets of X — called **blocks** — satisfying:

1. **Non-empty blocks.** For every i in I, B_i is non-empty (B_i != empty set).
2. **Covering (exhaustiveness).** The union of all blocks equals X:
   union_{i in I} B_i = X.
3. **Pairwise disjointness (exclusivity).** For all i != j in I,
   B_i intersect B_j = empty set.

## 2. MECE as Colloquial Cognate

**MECE** stands for **Mutually Exclusive, Collectively Exhaustive**. It is the
informal, working-vocabulary cognate of the formal partition property:

- *Mutually Exclusive* corresponds to pairwise disjointness (condition 3).
- *Collectively Exhaustive* corresponds to covering (condition 2).

When a set of categories, hypotheses, or causes is described as MECE, the claim
is that those categories form (or approximate) a partition of the relevant
universe.

**Limit of strict partition for hypothesis sets.** Strict MECE is the wrong
target for causal hypothesis sets — Heuer (2005) explicitly relaxed it for
ACH, and Mackie's INUS account treats real causes as disjunctions of
non-exclusive conjunctions. See `mece-limits.md` for the cases where the
underlying property still applies (sibling-level structuring) and where the
partition contract should be replaced with independence + comprehensiveness.

## 3. Cognitive Provenance

The discipline of carving a hypothesis space into disjoint, exhaustive
alternatives long predates the MECE label. Three primary sources:

- **Bacon, F. (1620). *Novum Organum*.** Bacon's eliminative induction presumes
  candidate forms are laid out as competing alternatives to be pruned.

- **Mill, J. S. (1843). *A System of Logic, Ratiocinative and Inductive*,
  Book III, Chapter VIII.** Mill's Method of Residues requires that the set of
  antecedents under consideration be exhaustive: residual phenomena are
  attributed to residual antecedents only when known causes have been
  subtracted from a closed enumeration.

- cf. **Chamberlin, T. C. (1890). "The Method of Multiple Working Hypotheses,"
  *Science*, 15(366)**. Chamberlin argues that a single ruling hypothesis
  biases observation and that the investigator should hold a family of
  competing hypotheses simultaneously, testing evidence against each. The
  method's effectiveness depends on the family being broad enough to include
  the true cause (exhaustive) and on the hypotheses being distinguishable by
  evidence (non-overlapping at the relevant grain).

## 4. Why MECE Matters for Hypothesis Search

Treat hypothesis investigation as search over a tree whose nodes are candidate
explanations. Two MECE properties bear directly on search correctness:

- **Collective Exhaustiveness => search-tree completeness.** If the children of
  a node cover the parent's hypothesis space, then the true explanation lies in
  some child subtree. Without exhaustiveness, search can terminate having
  eliminated every enumerated branch while the true cause sits in an
  unconsidered residual — a silent false negative.

- **Mutual Exclusivity => elimination soundness.** When children are pairwise
  disjoint, evidence that refutes one child does not implicate the others.
  Eliminating a branch removes exactly that branch. If branches overlap,
  evidence ruling out one branch may also (unintentionally) rule out shared
  content in a sibling, or — more dangerously — fail to rule it out where it
  should, because the same cause is split across multiple labels.

Together, these properties make pruning monotone: each elimination strictly
reduces the live hypothesis space without losing the truth.

## 5. Common Failure Modes

- **Overlapping categories.** Splitting "request failures" into
  {timeout, network error, downstream error} when a downstream service timeout
  populates more than one bucket. Evidence cannot cleanly eliminate any single
  branch.
- **Missing residual.** Splitting "process exit cause" into {OOM kill, panic,
  signal from operator} and omitting "normal exit triggered by upstream
  shutdown." The true cause is unrepresented; search exhausts the tree without
  finding it.
- **Mixed granularity.** Splitting "latency regression" into
  {GC pause, full database outage, a specific query plan change}. The branches
  are not at comparable levels of abstraction; coarse and fine alternatives
  compete on uneven footing and weight of evidence becomes hard to compare.
- **Hidden category overlap via shared mechanism.** Two branches named
  differently but driven by the same underlying variable (e.g., "high CPU" and
  "thread starvation" when the starvation is caused by CPU saturation).

## 6. Approximate MECE

Real-world causal structure rarely partitions cleanly. Causes interact: joint
causes (A and B together produce the effect, neither alone), confounders (a
hidden C drives both A and the outcome), and partial mediation all violate
strict disjointness. Demanding a perfect partition before proceeding can stall
investigation indefinitely.

A practical relaxation: permit **approximately MECE** decompositions provided
the overlaps are **named explicitly**. Record, for each pair of branches, any
known shared mechanism or joint-cause possibility, so that evidence
interpretation can account for cross-branch implications. Approximate MECE
preserves the discipline — every hypothesis is sited in an enumerated space,
residuals are surfaced — while acknowledging that the map is not the territory.
