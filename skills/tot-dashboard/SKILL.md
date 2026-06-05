---
name: tot-dashboard
description: Use this skill when the user asks to "open the dashboard", "show the visualization", "view the tree in the browser", or wants to launch the live tot-mcp web UI. Opens the system browser to the running daemon's visualization at http://localhost:6274.
---

# /tot-dashboard

Open the live Tree of Thought visualization in the default browser.

The tot-mcp daemon serves the dashboard on `http://localhost:6274` whenever it is running. The daemon auto-starts on any MCP tool call, so this skill ensures it is up, then launches the browser.

## Instructions

1. **Ensure the daemon is running.** Call the `get_status` MCP tool. The shim auto-starts the daemon if it is not already running. If `get_status` fails (e.g., MCP not connected), fall back to the CLI:
   ```bash
   tot-mcp status
   ```
   If status reports the daemon is down and the CLI is available, start it in the background:
   ```bash
   tot-mcp serve >/tmp/tot-mcp.log 2>&1 &
   ```

2. **Open the browser** to the dashboard URL using the first command available on the platform:
   ```bash
   URL="http://localhost:6274"
   (command -v xdg-open >/dev/null && xdg-open "$URL") \
     || (command -v open >/dev/null && open "$URL") \
     || (command -v start >/dev/null && start "$URL") \
     || echo "Open this URL manually: $URL"
   ```

3. **Report to the user**, including the URL as a fallback:
   ```
   Dashboard open at http://localhost:6274
   - Click nodes to see evidence details
   - Use the Sessions dropdown to switch between historical sessions
   - Status bar shows counts by hypothesis status
   ```

## Notes

- If the browser does not open (headless host, SSH session without forwarding, missing opener), the printed URL is the fallback. The user can also forward the port with `ssh -L 6274:localhost:6274`.
- For a textual summary of the tree without opening a browser, use `/tot-inspect`.
- For a markdown report of a completed investigation, use `/tot-export`.
