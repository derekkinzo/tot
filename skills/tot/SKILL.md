---
name: tot
description: Use this skill when the user says "open tot", "show the tree", "open my tree", or simply "/tot" to open the live tree visualization scoped to the current project. Distinct from `/tot-dashboard` (which lands on the daemon's last-active project) — `/tot` always lands on this project's tree.
---

# /tot

Open the live Tree of Thought visualization scoped to the current project.

The shared daemon at `http://localhost:6274` serves all projects. The
plain dashboard URL lands on the daemon's last-active project, which can
be confusing when you have several Claude Code sessions open in
different repos. This skill builds a URL with the current project root
encoded as `?project=<path>` so the dashboard opens directly on this
project's tree, regardless of which other sessions touched the daemon
last.

## Instructions

1. **Resolve the current project root.** Use `$CLAUDE_PROJECT_DIR`
   when set (documented Claude Code variable for the workspace root);
   otherwise fall back to `$PWD`:
   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
   ```

2. **Ensure the daemon is running.** First try the `get_status` MCP
   tool (the shim auto-starts the daemon). If MCP is not connected,
   start the bundled CLI directly:
   ```bash
   if [ -z "${CLAUDE_PLUGIN_DATA:-}" ]; then
     echo "CLAUDE_PLUGIN_DATA is not set; this skill must run inside a Claude Code plugin context."
     exit 1
   fi
   CLI="${CLAUDE_PLUGIN_DATA}/build/packages/server/dist/cli.js"
   if [ ! -f "$CLI" ]; then
     echo "MCP server not built yet. Restart Claude Code to trigger the SessionStart install hook."
     exit 1
   fi
   if ! node "$CLI" status >/dev/null 2>&1; then
     LOG_DIR="${HOME}/.tot"
     mkdir -p "$LOG_DIR"
     nohup node "$CLI" serve >"$LOG_DIR/daemon.log" 2>&1 &
     disown
     sleep 1
   fi
   ```

3. **Build the project-scoped URL** with `jq -rR @uri` for proper
   percent-encoding (handles paths with spaces or special characters).
   Falls back to the raw path if `jq` is unavailable, which is fine
   for typical project directories:
   ```bash
   if command -v jq >/dev/null 2>&1; then
     ENCODED=$(printf '%s' "$PROJECT_DIR" | jq -rR @uri)
   else
     ENCODED="$PROJECT_DIR"
   fi
   URL="http://localhost:6274/?project=${ENCODED}"
   ```

4. **Open the browser** to `$URL` using the first command available
   on the platform:
   ```bash
   (command -v xdg-open >/dev/null && xdg-open "$URL") \
     || (command -v open >/dev/null && open "$URL") \
     || (command -v start >/dev/null && start "$URL") \
     || echo "Open this URL manually: $URL"
   ```

5. **Report to the user**, including the URL as a fallback:
   ```
   Tree open at <URL>
   Scoped to: <PROJECT_DIR>
   ```

## Notes

- If no tree exists yet for this project, the dashboard shows an empty
  state. Run `/tot-reason` to start a session.
- For the historical Sessions dropdown across all projects, use
  `/tot-dashboard` instead — it lands on the daemon's last-active
  project rather than the current one.
- `/tot-inspect` returns a textual summary in chat without opening a
  browser; useful when you want a quick read-out without context-switching.
