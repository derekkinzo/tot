#!/usr/bin/env bash
#
# Prints a hash over every input the bundled build reads, for the tree given as
# $1 (default: $CLAUDE_PLUGIN_ROOT). The installer compares this against the
# signature it persisted next to the last build and rebuilds when they differ,
# so what is served always corresponds to the sources that produced it.
#
# Inputs are the root manifests and every file under packages/. Paths are hashed
# alongside contents, so adding, renaming, or deleting a source moves the
# signature. Installed dependencies and build outputs are excluded: including
# them would make a build invalidate the signature it had just written.
#
# Exits non-zero when no SHA-256 tool is available or the tree is missing a
# manifest, so a caller can tell "unchanged" from "could not tell".

set -e

ROOT="${1:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "source-signature: no such tree: ${ROOT:-<unset>}" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  sig_hash_file() { sha256sum "$1" | awk '{print $1}'; }
  sig_hash_stream() { sha256sum | awk '{print $1}'; }
  sig_hash_named() { xargs -0 sha256sum; }
elif command -v shasum >/dev/null 2>&1; then
  sig_hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
  sig_hash_stream() { shasum -a 256 | awk '{print $1}'; }
  sig_hash_named() { xargs -0 shasum -a 256; }
else
  echo "source-signature: neither sha256sum nor shasum available" >&2
  exit 3
fi

for manifest in package.json package-lock.json; do
  if [ ! -f "$ROOT/$manifest" ]; then
    echo "source-signature: missing $manifest in $ROOT" >&2
    exit 4
  fi
done

{
  sig_hash_file "$ROOT/package.json"
  sig_hash_file "$ROOT/package-lock.json"
  (
    cd "$ROOT"
    if [ -d packages ]; then
      find packages -type d \( -name node_modules -o -name dist -o -name static \) -prune \
        -o -type f -print \
        | LC_ALL=C sort | tr '\n' '\0' | sig_hash_named
    fi
  )
} | sig_hash_stream
