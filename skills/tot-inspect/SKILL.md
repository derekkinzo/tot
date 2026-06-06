---
name: tot-inspect
description: Use this skill when the user asks to "show the tree", "check tot status", "what hypotheses do we have", "tree progress", or wants to view/resume an existing reasoning session.
argument-hint: [sessionId]
---

# /tot-inspect

View and interpret the current hypothesis tree state.

## Instructions

1. Call `get_status` to see the current session summary (progress, best lead, stagnation).

2. Call `get_tree` with format `compact` for an overview, or `full` for complete details.

3. Report to the user:
   - Problem statement
   - Progress: N/M hypotheses resolved
   - Current best lead (highest scored, non-eliminated)
   - Any stagnation warnings
   - Unexplored hypotheses that need attention

4. If there are multiple sessions, list them and ask which to inspect.

5. Remind the user that the visualization is live at `http://localhost:6274`:
   - Click nodes to see evidence details
   - Use Sessions dropdown to switch between historical sessions
   - Status bar shows counts by status

## Interpreting the Tree

- **Pending** (blue): Not yet investigated — needs evidence
- **Exploring** (yellow): Evidence gathered, not yet resolved
- **Eliminated** (red/dimmed): Refuted with documented reasoning
- **Corroborated** (green): Surviving hypothesis — has withstood the refutation tests applied to it. Provisional, not verified.

## Resuming Investigation

If the tree shows active hypotheses without resolution:
1. Identify which hypotheses have no evidence (unexplored)
2. Identify which have evidence but no conclusion (stalled)
3. Suggest the next discriminating test to make progress
