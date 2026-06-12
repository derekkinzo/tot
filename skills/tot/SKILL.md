---
name: tot
description: Use this skill when the user says "open tot", "show the tree", "open my tree", or simply "/tot" to open the live tree visualization scoped to the current project. Distinct from `/tot-dashboard` (which lands on the daemon's last-active project) — `/tot` always lands on this project's tree.
---

# /tot

Open the live Tree of Thought visualization scoped to the current project.

The shared daemon at `http://localhost:6274` serves all projects. The
plain dashboard URL lands on the daemon's last-active project, which can
be confusing when several Claude Code sessions are open in different
repos. This skill builds a URL with the current project root encoded as
`?project=<path>` so the dashboard opens directly on this project's
tree, regardless of which other sessions touched the daemon last.

## Instructions

Run the entire setup as a single Bash invocation so shell variables
propagate across steps. Pasting these lines into separate Bash tool
calls will leave variables undefined; keep them in one fenced block.

```bash
set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ -z "$PROJECT_DIR" ]; then
  echo "Cannot resolve project directory: CLAUDE_PROJECT_DIR and PWD are both unset."
  exit 1
fi

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
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null --max-time 1 "http://localhost:6274/api/info"; then break; fi
    sleep 0.5
  done
fi

if ! curl -fsS -o /dev/null --max-time 1 "http://localhost:6274/api/info"; then
  echo "Daemon failed to bind http://localhost:6274 — see ${HOME}/.tot/daemon.log"
  exit 1
fi

ENCODED=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PROJECT_DIR")
URL="http://localhost:6274/?project=${ENCODED}"

(command -v xdg-open >/dev/null && xdg-open "$URL") \
  || (command -v open >/dev/null && open "$URL") \
  || (command -v start >/dev/null && start "$URL") \
  || true

echo "Tree open at $URL"
echo "Scoped to: $PROJECT_DIR"
```

## Notes

- If no tree exists yet for this project, the dashboard shows an empty
  state. Run `/tot-reason` to start a session.
- For the historical Sessions dropdown across all projects, use
  `/tot-dashboard` instead — it lands on the daemon's last-active
  project rather than the current one.
- `/tot-inspect` returns a textual summary in chat without opening a
  browser; useful when you want a quick read-out without context-switching.
