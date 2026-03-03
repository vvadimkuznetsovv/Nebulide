#!/bin/bash
set -e

WORKSPACE="/home/nebulide/workspace"
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

# SSH setup — /root/.ssh is a persistent volume (ssh_keys)
SSH_TARGET="/root/.ssh"
SSH_SOURCE="/root/.ssh-mount"
mkdir -p "$SSH_TARGET"
chmod 700 "$SSH_TARGET"

# Seed from host mount if available (first run or key update)
if [ -d "$SSH_SOURCE" ] && [ "$(ls -A "$SSH_SOURCE" 2>/dev/null)" ]; then
  for f in "$SSH_SOURCE"/*; do
    [ -f "$f" ] || continue
    cp "$f" "$SSH_TARGET/$(basename "$f")"
  done
  echo "[entrypoint] SSH keys seeded from host mount."
fi

# Fix permissions on all SSH files (volume or seeded)
if [ "$(ls -A "$SSH_TARGET" 2>/dev/null)" ]; then
  chmod 600 "$SSH_TARGET"/id_* 2>/dev/null || true
  chmod 644 "$SSH_TARGET"/*.pub 2>/dev/null || true
  chmod 644 "$SSH_TARGET"/known_hosts 2>/dev/null || true
  chmod 644 "$SSH_TARGET"/config 2>/dev/null || true
  echo "[entrypoint] SSH keys configured."
fi

# Symlink nebulide user SSH → root SSH (same keys, avoids duplication)
ln -sfn "$SSH_TARGET" /home/nebulide/.ssh

# Claude CLI config — symlink /root/.claude.json into the persistent volume
# so it survives container rebuilds (volume mounts /root/.claude/)
CLAUDE_JSON="/root/.claude.json"
CLAUDE_JSON_VOL="/root/.claude/.claude.json"
if [ -f "$CLAUDE_JSON" ] && [ ! -L "$CLAUDE_JSON" ]; then
  # First run after fix: move existing file into volume, then symlink
  mv "$CLAUDE_JSON" "$CLAUDE_JSON_VOL"
fi
if [ -f "$CLAUDE_JSON_VOL" ]; then
  ln -sfn "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
  echo "[entrypoint] Claude CLI config symlinked."
elif [ ! -e "$CLAUDE_JSON" ]; then
  # No config yet — create empty one in volume and symlink
  echo '{}' > "$CLAUDE_JSON_VOL"
  ln -sfn "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
  echo "[entrypoint] Claude CLI config created."
fi

# Ensure workspace ownership (volume mount may override)
chown -R nebulide:nebulide /home/nebulide/workspace 2>/dev/null || true

exec "$@"
