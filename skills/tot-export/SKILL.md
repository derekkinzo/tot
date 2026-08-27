---
name: tot-export
description: Use this skill when the user asks to "summarize the investigation", "export reasoning tree", "generate report from tot", or wants a markdown summary of findings.
argument-hint: [sessionId]
---

# /tot-export

Export a completed (or in-progress) hypothesis tree as a structured Markdown report.

## Instructions

1. Call `get_tree` with format `full` to get the complete tree state. Pass
   `sessionId` when `$1` names one, or when `get_status` lists the finished
   session the user asked about; with no argument it reads the most recent
   session. A resolved session reads the same as a live one.

2. Read the payload's own fields. Each hypothesis carries `title` (the short
   label), `statement` (the full claim, when one was authored), `status`,
   `evidence`, `conclusion`, and `decomposition` (`axis`, and `gate` when
   declared). Each evidence record carries `type`, `kind` (`artifact` for
   captured bytes, `transcription` for a retelling of them), `content`,
   `source`, and the `decisive` / `nonDiagnostic` / `linkedGroupId` marks.

3. Generate a Markdown report with this structure. Every verdict prints the
   reason recorded with it — a verdict without its ground is an assertion the
   tree does not support.

```markdown
# Investigation Report

## Problem
{session.problem}

## Summary
{1-2 sentences: which hypotheses survived, on what evidence, and what was left
untested. Say "no hypothesis survived" when that is the outcome.}

## Hypothesis Tree

### Corroborated
- **{title}** — {statement, when present}
  - Reason: {conclusion.reason}
  - Survived: {the refutation tests that were applied and did not refute it}
  - Evidence:
    - [{type}, {verbatim|paraphrase}] {content} {(source), when present}

### Eliminated
- ~~{title}~~ — {statement, when present}
  - Reason: {conclusion.reason}
  - Refuted by: {the refutes-typed records the verdict was bound to}

### Set aside (out of scope)
- {title} — {statement, when present}
  - Reason: {conclusion.reason}
  - Not refuted: this branch was left uninvestigated, so nothing here counts
    against it.

### Still open (if any)
- {title} — {no evidence yet | evidence gathered, no verdict}

## How the space was divided
For each decomposed node, one line: {parent title} split {decomposition.axis}
as {gate}, into {child titles}. Note any node whose declared gate the outcome
contradicts — two corroborated rivals under `one-of`, or an `all-of` part
eliminated while the parent still stands.

## Evidence Trail
Records in the order they were added, each marked verbatim or paraphrase, with
decisive records called out. Note any record marked as not discriminating and
any linked group, which counts as one observation however many records it holds.

## Methodology
Investigation used Tree of Thought reasoning with sibling-level decomposition.
{N} hypotheses in the tree, {M} eliminated with refuting evidence, {K}
corroborated, {J} set aside as out of scope.
Corroboration is provisional retention pending falsification (Popper);
out-of-scope marks a branch nobody tested, not one that was refuted.
```

4. Present the report to the user. Offer to:
   - Copy to clipboard
   - Write to a file (e.g., `investigation-report.md`)
   - Include in a PR description or commit message
