#!/bin/bash
set -e

WORKSPACE="/home/clauder/workspace"
PACKAGES_FILE="$WORKSPACE/.packages"
CLAUDE_MD_SRC="/app/CLAUDE.md"
CLAUDE_MD_DST="$WORKSPACE/CLAUDE.md"

# Copy CLAUDE.md to workspace if not present (first run)
if [ -f "$CLAUDE_MD_SRC" ] && [ ! -f "$CLAUDE_MD_DST" ]; then
  cp "$CLAUDE_MD_SRC" "$CLAUDE_MD_DST"
  echo "[entrypoint] CLAUDE.md copied to workspace."
fi

# Auto-install persisted apk packages
if [ -f "$PACKAGES_FILE" ]; then
  echo "[entrypoint] Installing persisted packages from $PACKAGES_FILE..."
  xargs -r apk add --no-cache < "$PACKAGES_FILE" 2>/dev/null || true
  echo "[entrypoint] Done."
fi

# Ensure workspace ownership (volume mount may override)
chown -R clauder:clauder /home/clauder/workspace 2>/dev/null || true

exec "$@"
