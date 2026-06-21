FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata bash curl sudo util-linux libreoffice jq tmux

# Install Node.js, Python, Git, SSH (required for Claude Code CLI + git ops)
RUN apk add --no-cache nodejs npm git openssh-client python3 py3-pip postgresql-client

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.175

# Tailscale — pinned static binary (Alpine apk lags far behind + gets wiped on every
# rebuild). Static binaries are musl-safe. entrypoint.sh starts tailscaled with the
# persisted state so the node reconnects automatically after each deploy.
RUN curl -fsSL https://pkgs.tailscale.com/stable/tailscale_1.98.4_amd64.tgz -o /tmp/ts.tgz \
    && tar -xzf /tmp/ts.tgz -C /tmp \
    && mv /tmp/tailscale_1.98.4_amd64/tailscale /tmp/tailscale_1.98.4_amd64/tailscaled /usr/local/bin/ \
    && rm -rf /tmp/ts.tgz /tmp/tailscale_1.98.4_amd64 \
    && /usr/local/bin/tailscale version | head -1

WORKDIR /app

# Copy pre-built Go binary
COPY backend/nebulide .

# Copy pre-built frontend
COPY frontend/dist ./static

# Claude Code hooks + statusLine — КРОСС-ПЛАТФОРМЕННЫЕ Node-скрипты (один код Linux+Windows).
# Регистрирует их сам бэкенд (Go) на старте в ~/.claude/settings.json (backend/services/claudehooks.go).
# Запускаются через `node`, поэтому +x не нужен.
COPY hooks/nebulide-hook.mjs /app/hooks/nebulide-hook.mjs
COPY hooks/nebulide-statusline.mjs /app/hooks/nebulide-statusline.mjs

# Entrypoint: auto-installs persisted packages on startup
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persist helpers: install packages that survive container rebuilds
COPY scripts/apk-persist /usr/local/bin/apk-persist
COPY scripts/pip-persist /usr/local/bin/pip-persist
COPY scripts/tg-send /usr/local/bin/tg-send
RUN chmod +x /usr/local/bin/apk-persist /usr/local/bin/pip-persist /usr/local/bin/tg-send

# Create user nebulide with sudo access
RUN adduser -D -s /bin/bash -h /home/nebulide nebulide \
    && echo "nebulide ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Create workspace directories and set ownership
RUN mkdir -p /home/nebulide/workspace /home/nebulide/workspaces /home/nebulide/shared \
    && chown -R nebulide:nebulide /home/nebulide

# Claude Code instructions (entrypoint copies to workspace on first run)
COPY workspace-CLAUDE.md /app/CLAUDE.md

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["./nebulide"]
