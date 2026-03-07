# Nebulide Server Environment

You are running inside a Docker container (Alpine Linux) on a VPS server.

## Environment

- OS: Alpine Linux 3.20
- Shell: bash
- Working directory: /home/nebulide/workspace
- Temp directory: /tmp (persisted at /tmp/nebulide on host)
- Git: configured, SSH key available for GitHub
- Node.js + npm: available
- PostgreSQL: accessible at host `postgres`, port 5432 (credentials in environment)

## Installing Packages

IMPORTANT: This container can restart. Regular `apk add` installs are lost on restart.

**System packages (apk)** — use `apk-persist` instead of `apk add`:
```bash
apk-persist python3 postgresql-client make gcc
```
This installs the packages AND saves them to `.packages` file so they auto-install on next container start.

**npm global packages** — use `npm install -g` as usual, they persist automatically:
```bash
npm install -g typescript prettier
```

**pip packages** — install normally, they persist automatically:
```bash
pip install requests flask
```

## Database Access

PostgreSQL is available inside the Docker network:
```bash
# First install the client (persistently):
apk-persist postgresql-client

# Then connect:
psql -h postgres -U $DB_USER -d $DB_NAME
# Password is in $DB_PASSWORD environment variable
```

## Git

Git is configured with SSH access to GitHub. You can clone, push, pull:
```bash
git clone git@github.com:user/repo.git
git add . && git commit -m "message" && git push
```

## SSH to Other Servers

SSH keys are available inside the container at `/root/.ssh/` (copied from host with correct permissions on startup). To connect to another server:
```bash
ssh user@server-ip
```

If connecting for the first time, the host key will be automatically added to known_hosts.

## Shared Folder

A shared folder is available at `/home/nebulide/shared/` — all users can read and write files here.
Use it to share files between users:
```bash
cp myfile.txt /home/nebulide/shared/
ls /home/nebulide/shared/
```

## Sending Files to Telegram

Use `tg-send` to send files from your workspace to your Telegram:
```bash
tg-send myfile.txt
tg-send /home/nebulide/shared/report.pdf
```
Requires Telegram ID to be configured in Nebulide Settings.
The Telegram bot also accepts files sent to it — they are saved to `~/uploads/`.

## File Structure

```
/home/nebulide/workspace/     ← your main working directory (persisted)
  projects/                  ← project files go here
  uploads/                   ← files received from Telegram bot
  .packages                  ← auto-generated list of persisted apk packages
/home/nebulide/shared/       ← shared folder (read+write for all users)
/tmp/                        ← temporary files (persisted between restarts)
```

All files in /home/nebulide/workspace/, /home/nebulide/shared/, and /tmp/ survive container restarts.
