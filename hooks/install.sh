#!/usr/bin/env bash
#
# SessionStart hook: build the bundled MCP server on first run and after
# plugin updates that change package.json. The built artifact is staged in
# ${CLAUDE_PLUGIN_DATA} so it survives plugin upgrades.
#
# Pattern adopted from the Claude Code plugins-reference (Persistent data
# directory section): compare bundled manifest against the persisted copy,
# rebuild only when they differ.

set -e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-}"

if [ -z "$PLUGIN_ROOT" ] || [ -z "$PLUGIN_DATA" ]; then
  exit 0
fi

SERVER_SRC="$PLUGIN_ROOT/packages/server"
SERVER_MANIFEST="$SERVER_SRC/package.json"
PERSISTED_MANIFEST="$PLUGIN_DATA/server-package.json"
BUILT_CLI="$PLUGIN_DATA/dist/cli.js"

if [ ! -f "$SERVER_MANIFEST" ]; then
  exit 0
fi

if [ -f "$BUILT_CLI" ] && [ -f "$PERSISTED_MANIFEST" ] \
   && diff -q "$SERVER_MANIFEST" "$PERSISTED_MANIFEST" >/dev/null 2>&1; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[tot-mcp] node not found on PATH; skipping MCP server build." >&2
  exit 0
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[tot-mcp] npm not found on PATH; skipping MCP server build." >&2
  exit 0
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 11 ]; }; then
  echo "[tot-mcp] Node 20.11+ required, found $(node --version); skipping build." >&2
  exit 0
fi

echo "[tot-mcp] Building MCP server (first run or plugin updated)..." >&2

LOG="$PLUGIN_DATA/install.log"
mkdir -p "$PLUGIN_DATA"

(
  cd "$SERVER_SRC"
  npm install --no-audit --no-fund --no-progress
  npm run build
) >"$LOG" 2>&1 || {
  echo "[tot-mcp] Build failed; see $LOG" >&2
  exit 0
}

if [ ! -f "$SERVER_SRC/dist/cli.js" ]; then
  echo "[tot-mcp] Build did not produce dist/cli.js; see $LOG" >&2
  exit 0
fi

rm -rf "$PLUGIN_DATA/dist.new"
cp -r "$SERVER_SRC/dist" "$PLUGIN_DATA/dist.new"
rm -rf "$PLUGIN_DATA/dist"
mv "$PLUGIN_DATA/dist.new" "$PLUGIN_DATA/dist"

cp "$SERVER_MANIFEST" "$PERSISTED_MANIFEST"

echo "[tot-mcp] MCP server ready at $BUILT_CLI" >&2
