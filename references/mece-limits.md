# MECE limits — when strict partition is the wrong target

MECE (mutually exclusive, collectively exhaustive) is a useful structuring heuristic at the sibling level, but strict partition is the wrong contract for hypothesis sets. The literature recognises this directly.

## Why strict MECE fails for hypothesis sets

Heuer's *Psychology of Intelligence Analysis* originally assumed MECE for ACH probability calculations. He retracted that assumption explicitly in the 2005 follow-up paper:

> The probability calculations assume that all hypotheses are mutually exclusive (if one hypothesis is true, all other hypotheses must be false), and that the list of hypotheses must exhaust all the possibilities. Most analysts do not normally think in this way, and we saw too many sets of hypotheses that failed to meet this test.

The Inconsistency Score replaces the partition assumption. Each hypothesis is evaluated independently, with the most likely hypothesis defined as the one with the *least evidence against it* — selection by disproof, not by accumulation of positive support.

That comparison presupposes ACH's matrix: every observation is checked against every hypothesis, so a low inconsistency count means the evidence was weighed and did not tell against it. Outside that setting the count means something else. In a tree where evidence is attached per hypothesis, a branch nobody has tested also carries no evidence against it, and ranking on the raw count would put the untested branch on top. Read the two apart: untested, versus tested and still standing.

Mackie's INUS account (1965, *The Cement of the Universe* 1974) reaches the same conclusion from a different direction. A cause is an Insufficient but Necessary part of an Unnecessary but Sufficient condition: real causal structure is a disjunction of conjunctions, where multiple alternative clusters can coexist and each cluster contains several jointly necessary contributors. "Find the cause" is therefore "verify a co-instantiated cluster", not "isolate a single survivor."

In medicine, differential diagnosis frameworks accept overlap directly. Two diagnoses can attach to one patient when symptoms fit either; combined diagnoses (e.g. "primary hyperparathyroidism without cancer", "cancer without primary hyperparathyroidism", and the combined category) are first-class candidates rather than violations to eliminate. The "surgical sieve" is described as presentational, not ontological — its categories overlap by design.

## What survives

The structural goals MECE captures are still useful:

- **Force comparison.** Listing siblings under a parent forces the investigator to think about alternatives, not just the favourite.
- **Expose blind spots.** Asking whether the set covers the parent's space surfaces what's missing.
- **Prevent double-counting.** Sibling overlap that's accidental causes evidence to weigh twice; surfacing it lets the investigator either merge or refine.

The contract is therefore *non-overlapping where the boundary is real, collective coverage at the parent's level of abstraction*, with **catch-all branches as first-class options** and **combined hypotheses (`A and B`) as legitimate children**. Strict partition is not the target.

## In practice

When evaluating a decomposition:

- Treat overlap as a flag, not a fault. Ask whether it reflects accidental redundancy or genuine domain co-occurrence.
- Treat coverage as a flag, not a closure proof. An explicit catch-all is more honest than an enumerated set that quietly assumes completeness.
- Treat granularity as a flag, not a gate. Mixed altitude is worth fixing, but the sibling layer rarely splits cleanly along a single axis at every depth.

## Citations

- Heuer, R. J., Jr. (2005). *How does Analysis of Competing Hypotheses (ACH) improve intelligence analysis?*
- Mackie, J. L. (1965). Causes and conditions. *American Philosophical Quarterly*, 2(4), 245–264.
- Mackie, J. L. (1974). *The cement of the universe*. Oxford University Press.
- Heuer, R. J., Jr. (1999). *Psychology of intelligence analysis*. CIA Center for the Study of Intelligence.
