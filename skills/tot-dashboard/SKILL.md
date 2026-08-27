---
name: tot-dashboard
description: Use this skill when the user asks to "open the dashboard", "show the visualization", "view the tree in the browser", or wants to launch the live tot-mcp web UI in the system browser.
---

# /tot-dashboard

Open the live Tree of Thought visualization in the default browser.

Each Claude Code session runs its own tot-mcp server on a private,
OS-assigned port. The server reports its own dashboard URL through the
`get_status` MCP tool — there is no fixed address and no separate process
to start.

## Instructions

1. **Call the `get_status` MCP tool.** Read the final line of its response:
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

3. **Report to the user**, including the URL as a fallback:
   ```
   Dashboard open at http://localhost:<port>
   - Click nodes to see evidence details
   - Use the Sessions dropdown to switch between this project's sessions
   - Status bar shows counts by hypothesis status
   ```

## Notes

- If the browser does not open (headless host, SSH session without
  forwarding, missing opener), the printed URL is the fallback. Forward the
  reported port with `ssh -L <port>:localhost:<port> <host>`.
- For a textual summary of the tree without opening a browser, use the `tot-inspect` skill.
- For a markdown report of a completed investigation, use the `tot-export` skill.
