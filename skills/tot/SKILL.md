---
name: tot
description: Use this skill when the user says "open tot", "show the tree", "open my tree", or simply "/tot" to open the live tree visualization for the current project in the browser.
---

# /tot

Open the live Tree of Thought visualization for the current project.

Each Claude Code session runs its own tot-mcp server on a private,
OS-assigned port. That server is the only process that knows its own URL,
so the URL is read from the `get_status` MCP tool response rather than a
fixed address.

## Instructions

1. **Call the `get_status` MCP tool.** Its response ends with a line:
   ```
   Visualization: http://localhost:<port>
   ```
   - Present → that `http://localhost:<port>` is the dashboard URL; use it
     verbatim in the next step. It opens on the project's most recent open
     tree, or its most recent tree when none is open, with a Sessions selector
     for the rest — so the URL is valid whether or not an investigation is
     still in progress, and shows an empty state when the project has no tree
     yet.
   - Absent → the in-process HTTP server did not start. Tell the user the
     dashboard is unavailable and offer the `tot-inspect` skill for a text
     read-out.
   - `No session yet for this project` alongside the URL means the project has
     no tree; the dashboard still opens. Mention that the `tot-reason` skill
     starts one.

2. **Open the browser** to that URL, substituting the port you read:
   ```bash
   URL="http://localhost:<port>"   # from the get_status response
   (command -v xdg-open >/dev/null && xdg-open "$URL") \
     || (command -v open >/dev/null && open "$URL") \
     || (command -v start >/dev/null && start "$URL") \
     || echo "Open this URL manually: $URL"
   ```

3. **Report to the user**, including the URL as a fallback.

## Notes

- If no tree exists yet for this project, the dashboard shows an empty
  state. The `tot-reason` skill starts a session.
- On a headless or SSH host, forward the port the dashboard reported:
  `ssh -L <port>:localhost:<port> <host>`, then open `http://localhost:<port>`.
- The `tot-inspect` skill returns a textual summary in chat without opening a
  browser; useful for a quick read-out without context-switching.
