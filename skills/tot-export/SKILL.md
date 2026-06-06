---
name: tot-export
description: Use this skill when the user asks to "summarize the investigation", "export reasoning tree", "generate report from tot", or wants a markdown summary of findings.
argument-hint: [sessionId]
---

# /tot-export

Export a completed (or in-progress) hypothesis tree as a structured Markdown report.

## Instructions

1. Call `get_tree` with format `full` to get the complete tree state.

2. Generate a Markdown report with this structure:

```markdown
# Investigation Report

## Problem
{problem statement}

## Summary
{1-2 sentence conclusion: what was found and why}

## Hypothesis Tree

### Corroborated Hypotheses
- **{hypothesis content}** (confidence: {score})
  - Reason: {corroboration reason}
  - Evidence:
    - [supports] {evidence content}
    - [supports] {evidence content}

### Eliminated Hypotheses
- ~~{hypothesis content}~~
  - Reason: {elimination reason}
  - Evidence: {refuting evidence}

### Unresolved (if any)
- {hypothesis content} — {current state}

## Evidence Trail
{chronological list of key evidence gathered}

## Methodology
Investigation used Tree of Thought reasoning with sibling-level decomposition.
{N} hypotheses explored, {M} eliminated with evidence, {K} corroborated.
Corroboration is provisional retention pending falsification (Popper).
```

3. Present the report to the user. Offer to:
   - Copy to clipboard
   - Write to a file (e.g., `investigation-report.md`)
   - Include in a PR description or commit message
