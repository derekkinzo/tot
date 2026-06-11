---
name: tot-init
description: Use this skill once after installing the tot-mcp plugin to build the MCP server and register it with Claude Code. Idempotent — safe to re-run.
---

# /tot-init

Build the bundled MCP server and register it with Claude Code so the `tot` tools become available on the next Claude Code restart.

This is the one-time setup step after `/plugin install tot-mcp`. The plugin ships source code; this skill runs `npm install`, `npm run build`, and `claude mcp add` against the resolved plugin path. It is idempotent: re-running it rebuilds and re-registers without duplicating entries.

## Instructions

1. **Resolve the plugin root** and confirm the workspace is intact:
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
   if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/package.json" ]; then
     echo "Error: CLAUDE_PLUGIN_ROOT is not set or does not contain package.json."
     echo "Reinstall the plugin: /plugin marketplace add derekkinzo/tot && /plugin install tot-mcp"
     exit 1
   fi
   echo "Plugin root: $PLUGIN_ROOT"
   ```

2. **Check Node.js version** (the server requires Node 20.11+):
   ```bash
   node --version
   ```
   If the version is below 20.11, instruct the user to upgrade Node before continuing.

3. **Install dependencies and build the server.** The plugin ships source code, not built artifacts, so the first run takes a minute:
   ```bash
   cd "$PLUGIN_ROOT" && npm install --silent && npm run build --silent
   ```
   Verify the executable exists:
   ```bash
   CLI_PATH="$PLUGIN_ROOT/packages/server/dist/cli.js"
   [ -f "$CLI_PATH" ] || { echo "Build failed: $CLI_PATH not found"; exit 1; }
   ```

4. **Register the MCP server with Claude Code.** Use the absolute path so the registration survives plugin updates:
   ```bash
   claude mcp remove tot 2>/dev/null || true
   claude mcp add tot -- node "$CLI_PATH"
   ```

5. **Report success and next steps to the user**:
   ```
   tot-mcp is built and registered.

   Restart Claude Code to load the MCP server, then:
     /tot-reason  — start a structured reasoning session
     /tot-dashboard — open the live tree visualization
     /tot-inspect — view current tree state
     /tot-export — export a Markdown report

   The visualization runs at http://localhost:6274 once any tool call has started the daemon.
   ```

## Notes

- The MCP server is loaded by Claude Code at startup, so the `claude mcp add` registration takes effect after the next restart.
- To uninstall the MCP server registration without removing the plugin: `claude mcp remove tot`.
- Re-run this skill any time the plugin updates or after pulling new commits in the source tree.
