#!/usr/bin/env bash
#
# SessionStart hook: build the bundled MCP server on first run and after
# plugin updates. The build happens inside ${CLAUDE_PLUGIN_DATA} so
# node_modules, dist, and static all colocate and survive plugin upgrades.
#
# Pattern adopted from the Claude Code plugins-reference (Persistent data
# directory section): compare a bundled source signature against the
# persisted copy, rebuild only when it differs.

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

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo "")
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || ! [[ "$NODE_MINOR" =~ ^[0-9]+$ ]]; then
  echo "[tot-mcp] Could not detect Node version; skipping build." >&2
  exit 0
fi
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 11 ]; }; then
  echo "[tot-mcp] Node 20.11+ required, found $(node --version); skipping build." >&2
  exit 0
fi

mkdir -p "$PLUGIN_DATA"

LOCK="$PLUGIN_DATA/.install.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  flock -w 600 9 || {
    echo "[tot-mcp] Timed out waiting for prior install to finish." >&2
    exit 0
  }
fi

BUILD_DIR="$PLUGIN_DATA/build"
BUILD_OLD="$PLUGIN_DATA/build.old"
BUILT_CLI="$BUILD_DIR/packages/server/dist/cli.js"
BUILT_INDEX="$BUILD_DIR/packages/server/static/index.html"
PERSISTED_SIG="$PLUGIN_DATA/source-signature"

# Signing the build over its inputs is what makes "rebuild only when something
# changed" true; without a usable signature there is no way to tell a current
# build from a stale one, so leave the previous build in place rather than
# serving it against sources it may not match.
if ! SOURCE_SIG=$(bash "$PLUGIN_ROOT/hooks/source-signature.sh" "$PLUGIN_ROOT" 2>/dev/null); then
  echo "[tot-mcp] Could not sign the plugin sources; skipping build." >&2
  exit 0
fi

if [ -f "$BUILT_CLI" ] && [ -f "$BUILT_INDEX" ] && [ -f "$PERSISTED_SIG" ] \
   && [ "$(cat "$PERSISTED_SIG")" = "$SOURCE_SIG" ]; then
  exit 0
fi

# One-shot cleanup of stale user-scope `tot` MCP registration left by an
# older install pattern (the previous /tot-init skill called
# `claude mcp add tot ...` directly). Gated by a marker so it only runs
# once per install dir, even if the registration was already cleaned up.
CLEANUP_MARKER="$PLUGIN_DATA/.legacy-cleanup-done"
if [ ! -f "$CLEANUP_MARKER" ] && command -v claude >/dev/null 2>&1; then
  claude mcp remove tot --scope user >/dev/null 2>&1 || true
  : >"$CLEANUP_MARKER"
fi

echo "[tot-mcp] Building MCP server in $BUILD_DIR (this can take a minute on first run)." >&2

LOG="$PLUGIN_DATA/install.log"
STAGE="$PLUGIN_DATA/build.new"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Stage source. cp -R preserves symlinks so we don't follow workspace
# node_modules into a recursive copy if the user's PLUGIN_ROOT was a
# developer checkout.
stage_entries() {
  set -e
  cd "$PLUGIN_ROOT"
  for entry in package.json package-lock.json packages; do
    if [ ! -e "$entry" ]; then
      echo "[tot-mcp] Required entry missing in plugin root: $entry" >&2
      exit 1
    fi
    cp -R "$entry" "$STAGE/"
  done
  find "$STAGE" -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
  find "$STAGE" -name dist -prune -exec rm -rf {} + 2>/dev/null || true
  find "$STAGE" -name static -prune -exec rm -rf {} + 2>/dev/null || true
}

# Run in a subshell so the function's `exit 1` fails this `if` instead of
# leaving the script — otherwise a missing entry orphans the staging tree.
if ! ( stage_entries ); then
  rm -rf "$STAGE"
  exit 1
fi

if ! ( set -e; cd "$STAGE" && npm ci --ignore-scripts --no-audit --no-fund --no-progress && npm run build ) >"$LOG" 2>&1; then
  echo "[tot-mcp] Build failed; see $LOG" >&2
  rm -rf "$STAGE"
  exit 1
fi

if [ ! -f "$STAGE/packages/server/dist/cli.js" ]; then
  echo "[tot-mcp] Build did not produce dist/cli.js; see $LOG" >&2
  rm -rf "$STAGE"
  exit 1
fi
if [ ! -f "$STAGE/packages/server/static/index.html" ]; then
  echo "[tot-mcp] Build did not produce static/index.html; see $LOG" >&2
  rm -rf "$STAGE"
  exit 1
fi

# Atomic-ish swap: keep BUILD_DIR present continuously by renaming the old
# tree aside, moving the new one in, then removing the old. A concurrent
# reader during the window sees the old build until the rename completes.
rm -rf "$BUILD_OLD"
if [ -d "$BUILD_DIR" ]; then
  mv "$BUILD_DIR" "$BUILD_OLD"
fi
mv "$STAGE" "$BUILD_DIR"
rm -rf "$BUILD_OLD"

printf '%s' "$SOURCE_SIG" >"$PERSISTED_SIG"

echo "[tot-mcp] MCP server ready at $BUILT_CLI" >&2
