#!/usr/bin/env bash
set -euo pipefail

PLUGIN_BASE="$HOME/.claude/plugins/cache/session-watcher/session-watcher"

# Deploy into whatever version Claude actually loads — the highest installed
# version dir, not package.json's version (the marketplace copy may lag behind).
if [ ! -d "$PLUGIN_BASE" ]; then
  echo "error: plugin not installed — $PLUGIN_BASE not found" >&2
  exit 1
fi
VERSION="$(ls -1 "$PLUGIN_BASE" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
if [ -z "$VERSION" ]; then
  echo "error: no installed version dir found under $PLUGIN_BASE" >&2
  exit 1
fi
PLUGIN_DIST="$PLUGIN_BASE/$VERSION/dist"

node "$(dirname "$0")/build.js"
rm -rf "$PLUGIN_DIST"
cp -r dist "$PLUGIN_DIST"

echo "Deployed → $PLUGIN_DIST"
