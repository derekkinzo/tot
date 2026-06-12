#!/usr/bin/env bash
#
# SessionStart hook: build the bundled MCP server on first run and after
# plugin updates. The build happens inside ${CLAUDE_PLUGIN_DATA} so
# node_modules, dist, and static all colocate and survive plugin upgrades.
#
# Pattern adopted from the Claude Code plugins-reference (Persistent data
# directory section): compare bundled package-lock against the persisted
# copy, rebuild only when it differs.

set -e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-}"

if [ -z "$PLUGIN_ROOT" ] || [ -z "$PLUGIN_DATA" ]; then
  exit 0
fi
if [ ! -f "$PLUGIN_ROOT/package-lock.json" ]; then
  exit 0
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[tot-mcp] node and npm are required; skipping build." >&2
  exit 0
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 11 ]; }; then
  echo "[tot-mcp] Node 20.11+ required, found $(node --version); skipping build." >&2
  exit 0
fi

mkdir -p "$PLUGIN_DATA"

LOCK="$PLUGIN_DATA/.install.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  flock 9
fi

BUILD_DIR="$PLUGIN_DATA/build"
BUILT_CLI="$BUILD_DIR/packages/server/dist/cli.js"
PERSISTED_LOCK="$PLUGIN_DATA/source-lock.sha256"
SOURCE_LOCK_HASH=$(sha256sum "$PLUGIN_ROOT/package-lock.json" | awk '{print $1}')

if [ -f "$BUILT_CLI" ] && [ -f "$PERSISTED_LOCK" ] \
   && [ "$(cat "$PERSISTED_LOCK")" = "$SOURCE_LOCK_HASH" ]; then
  exit 0
fi

echo "[tot-mcp] Building MCP server in $BUILD_DIR" >&2

LOG="$PLUGIN_DATA/install.log"
STAGE="$PLUGIN_DATA/build.new"
rm -rf "$STAGE"
mkdir -p "$STAGE"

(
  cd "$PLUGIN_ROOT"
  for entry in package.json package-lock.json packages docs README.md LICENSE; do
    [ -e "$entry" ] && cp -RL "$entry" "$STAGE/"
  done
) || {
  echo "[tot-mcp] Failed to stage source for build" >&2
  rm -rf "$STAGE"
  exit 1
}

(
  cd "$STAGE"
  npm ci --no-audit --no-fund --no-progress
  npm run build
) >"$LOG" 2>&1 || {
  echo "[tot-mcp] Build failed; see $LOG" >&2
  rm -rf "$STAGE"
  exit 1
}

if [ ! -f "$STAGE/packages/server/dist/cli.js" ]; then
  echo "[tot-mcp] Build did not produce dist/cli.js; see $LOG" >&2
  rm -rf "$STAGE"
  exit 1
fi
if [ ! -d "$STAGE/packages/server/static" ] || [ -z "$(ls -A "$STAGE/packages/server/static")" ]; then
  echo "[tot-mcp] Build did not produce a populated static/ dir; see $LOG" >&2
  rm -rf "$STAGE"
  exit 1
fi

rm -rf "$BUILD_DIR"
mv "$STAGE" "$BUILD_DIR"

printf '%s' "$SOURCE_LOCK_HASH" >"$PERSISTED_LOCK"

echo "[tot-mcp] MCP server ready at $BUILT_CLI" >&2
