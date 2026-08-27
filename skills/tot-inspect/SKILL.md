---
name: tot-inspect
description: Use this skill when the user asks to "show the tree", "check tot status", "what hypotheses do we have", "tree progress", or wants to view/resume an existing reasoning session.
argument-hint: [sessionId]
---

# /tot-inspect

View and interpret the current hypothesis tree state.

## Instructions

1. Call `get_status` to see the session summary: progress, unexplored branches,
   a stagnation check, and the ids of the project's other sessions.

2. Call `get_tree` with format `compact` for an overview, or `full` for complete
   details. With no argument it reads the session `get_status` just summarized;
   pass `sessionId` (a full id, as given for `$1` or listed by `get_status`) to
   read any other session of the project, resolved ones included.

3. Report to the user:
   - Problem statement
   - Progress: N/M hypotheses resolved
   - Live hypotheses still standing, split into the untested ones (no evidence
     yet — `get_status` lists these as unexplored) and the ones that have
     survived the tests applied to them. Untested is not strength: a branch
     nobody has attacked has no refuting evidence either.
   - Any stagnation warning, and the reframing it suggests

4. When `get_status` names other sessions, list them for the user with their
   status and problem, and ask which to inspect. Pass the full id it printed to
   `get_tree(sessionId)`.

5. Remind the user that the live visualization is available — the
   `get_status` response ends with a `Visualization: http://localhost:<port>`
   line (each session has its own port). Open it (or use the `tot-dashboard`
   skill) to:
   - Click nodes to see evidence details
   - Use Sessions dropdown to switch between this project's sessions
   - Status bar shows counts by status

## Interpreting the Tree

- **Pending** (○, blue): Not yet investigated — needs evidence
- **Exploring** (◉, yellow): Evidence gathered, not yet resolved
- **Eliminated** (✗, grey and dimmed): Refuted with documented reasoning
- **Corroborated** (✓, green): Surviving hypothesis — has withstood the refutation tests applied to it. Provisional, not verified.
- **Out of scope** (⊘, purple): Set aside as outside this investigation. Not refuted — the branch is untested, and saying so is the point of the status.

## Resuming Investigation

If the tree shows active hypotheses without resolution:
1. Identify which hypotheses have no evidence (unexplored)
2. Identify which have evidence but no conclusion (stalled)
3. Suggest the next discriminating test to make progress
