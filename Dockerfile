FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata bash curl sudo

# Install Node.js, Python, Git, SSH (required for Claude Code CLI + git ops)
RUN apk add --no-cache nodejs npm git openssh-client python3 py3-pip

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy pre-built Go binary
COPY backend/nebulide .

# Copy pre-built frontend
COPY frontend/dist ./static

# Entrypoint: auto-installs persisted packages on startup
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persist helpers: install packages that survive container rebuilds
COPY scripts/apk-persist /usr/local/bin/apk-persist
COPY scripts/pip-persist /usr/local/bin/pip-persist
RUN chmod +x /usr/local/bin/apk-persist /usr/local/bin/pip-persist

# Create user nebulide with sudo access
RUN adduser -D -s /bin/bash -h /home/nebulide nebulide \
    && echo "nebulide ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Create workspace directory and set ownership
RUN mkdir -p /home/nebulide/workspace \
    && chown -R nebulide:nebulide /home/nebulide

# Claude Code instructions (entrypoint copies to workspace on first run)
COPY workspace-CLAUDE.md /app/CLAUDE.md

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["./nebulide"]
