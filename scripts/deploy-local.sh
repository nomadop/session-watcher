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

# Config + registration files — sync to plugin root so CC picks up changes.
PLUGIN_ROOT="$PLUGIN_BASE/$VERSION"
cp "$(dirname "$0")/../.claude-plugin/plugin.json" "$PLUGIN_ROOT/.claude-plugin/plugin.json"
cp "$(dirname "$0")/../hooks/hooks.json" "$PLUGIN_ROOT/hooks/hooks.json"

# Skills are source-level markdown (not bundled) — sync directly to plugin root.
if [ -d "$(dirname "$0")/../skills" ]; then
  rm -rf "$PLUGIN_ROOT/skills"
  cp -r "$(dirname "$0")/../skills" "$PLUGIN_ROOT/skills"
fi

echo "Deployed → $PLUGIN_DIST"
