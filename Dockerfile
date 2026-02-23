FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata bash curl sudo

# Install Node.js, Git, SSH (required for Claude Code CLI + git ops)
RUN apk add --no-cache nodejs npm git openssh-client

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy pre-built Go binary
COPY backend/clauder .

# Copy pre-built frontend
COPY frontend/dist ./static

# Entrypoint: auto-installs persisted packages on startup
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# apk-persist: install packages + save them so they survive restarts
COPY scripts/apk-persist /usr/local/bin/apk-persist
RUN chmod +x /usr/local/bin/apk-persist

# Create user clauder with sudo access
RUN adduser -D -s /bin/bash -h /home/clauder clauder \
    && echo "clauder ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Create workspace directory and set ownership
RUN mkdir -p /home/clauder/workspace \
    && chown -R clauder:clauder /home/clauder

# Claude Code instructions (entrypoint copies to workspace on first run)
COPY workspace-CLAUDE.md /app/CLAUDE.md

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["./clauder"]
