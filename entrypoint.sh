#!/bin/bash
set -e

WORKSPACE="/home/nebulide/workspace"
WORKSPACES="/home/nebulide/workspaces"
PACKAGES_FILE="$WORKSPACE/.packages"
CLAUDE_MD_SRC="/app/CLAUDE.md"
CLAUDE_MD_DST="$WORKSPACE/CLAUDE.md"

# Ensure per-user workspaces root exists
mkdir -p "$WORKSPACES"

# Shared folder — read+write for all users (setgid so new files inherit group)
SHARED="/home/nebulide/shared"
mkdir -p "$SHARED"
chown nebulide:nebulide "$SHARED"
chmod 2775 "$SHARED"

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

# NOTE: No global SSH symlink — admin SSH keys stay at /root/.ssh (root-only).
# Non-admin users get per-user .ssh in their workspace via sandboxed-shell.

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

# Persistent Python venv — admin workspace only
VENV_DIR="$WORKSPACE/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "[entrypoint] Creating persistent Python venv..."
  python3 -m venv "$VENV_DIR"
  echo "[entrypoint] Python venv created at $VENV_DIR"
fi

# Auto-activate venv for root (admin terminal runs as root)
ROOT_BASHRC="/root/.bashrc"
ACTIVATE_LINE="source $VENV_DIR/bin/activate"
if ! grep -qF "$ACTIVATE_LINE" "$ROOT_BASHRC" 2>/dev/null; then
  echo "$ACTIVATE_LINE" >> "$ROOT_BASHRC"
fi
# Enable shared history across terminal sessions (append, don't overwrite on exit)
if ! grep -qF "histappend" "$ROOT_BASHRC" 2>/dev/null; then
  echo "shopt -s histappend" >> "$ROOT_BASHRC"
fi
# Per-user venv is created by sandboxed-shell on first terminal open.

# Create PostgreSQL dev role for user terminals (idempotent)
if command -v psql >/dev/null 2>&1; then
  psql "host=${DB_HOST:-postgres} port=${DB_PORT:-5432} user=${DB_USER:-nebulide} password=${DB_PASSWORD:-nebulide} dbname=${DB_NAME:-nebulide}" -c "
    DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dev') THEN
        CREATE ROLE dev LOGIN PASSWORD '${DEV_DB_PASSWORD:-devpass}' CREATEDB;
      END IF;
    END \$\$;
    REVOKE ALL ON DATABASE ${DB_NAME:-nebulide} FROM dev;
  " 2>/dev/null && echo "[entrypoint] PostgreSQL dev role ready." || echo "[entrypoint] PostgreSQL dev role setup skipped (DB not ready yet)."
fi

# Ensure workspace ownership (volume mount may override)
chown -R nebulide:nebulide /home/nebulide/workspace 2>/dev/null || true
chown -R nebulide:nebulide /home/nebulide/workspaces 2>/dev/null || true

exec "$@"
