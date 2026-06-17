#!/bin/bash
# Nebulide — полный слепок для переноса сервер→сервер.
# Снимает: БД (pg_dump), критичные docker-тома, .env, SSL-сертификаты.
# Не входит (пересобираемое/эфемерное): workspace(s), usr_local, code-server,
# redis, nginx-логи, scrollback — см. флаги --with-* для расширения.
#
# Запуск:  sudo /opt/nebulide/scripts/backup-full.sh [--with-workspaces] [--with-usrlocal] [--with-codeserver]
# Результат: /opt/nebulide/backups/nebulide-snapshot-<TS>.tar.gz  (владелец — вызвавший пользователь)
#
# Восстановление: scripts/restore-full.sh на новом сервере.
set -euo pipefail

PROJECT_DIR=/opt/nebulide
COMPOSE_PROJECT=nebulide          # префикс имён томов: docker volume ls → nebulide_*
PG_CONTAINER=nebulide-postgres-1
ENV_FILE="$PROJECT_DIR/.env"
HELPER_IMAGE=alpine:3.20          # базовый слой образа app уже закэширован — без скачивания

# Тома, которые всегда входят в слепок (без префикса проекта)
CORE_VOLUMES="claude_data shared_data ssh_keys telegram_bot_api_data"

# --- разбор флагов ---
WITH_WORKSPACES=0; WITH_USRLOCAL=0; WITH_CODESERVER=0
for arg in "$@"; do
  case "$arg" in
    --with-workspaces) WITH_WORKSPACES=1 ;;
    --with-usrlocal)   WITH_USRLOCAL=1 ;;
    --with-codeserver) WITH_CODESERVER=1 ;;
    *) echo "Неизвестный флаг: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Запусти под root: sudo $0" >&2
  exit 1
fi

TS=$(date +%Y%m%d_%H%M%S)
WORK="$PROJECT_DIR/backups/snapshot-$TS"
ARCHIVE="$PROJECT_DIR/backups/nebulide-snapshot-$TS.tar.gz"
mkdir -p "$WORK/volumes"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Сохраняет один docker-том в volumes/<name>.tar.gz
backup_volume() {
  local name="$1" vol="${COMPOSE_PROJECT}_$1"
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    log "  ⚠ том $vol не найден — пропуск"
    return
  fi
  log "  → том $vol"
  docker run --rm -v "$vol":/src:ro -v "$WORK/volumes":/out "$HELPER_IMAGE" \
    tar czf "/out/$name.tar.gz" -C /src .
}

log "=== Nebulide full backup → $ARCHIVE ==="

# 1. База данных (с --clean --if-exists — рестор идемпотентен поверх авто-миграции)
log "БД: pg_dump"
docker exec "$PG_CONTAINER" pg_dump --clean --if-exists -U nebulide -d nebulide | gzip > "$WORK/db.sql.gz"

# 2. Тома
log "Тома (core):"
for v in $CORE_VOLUMES; do backup_volume "$v"; done
[ "$WITH_USRLOCAL" = 1 ]   && { log "Тома (опц): usr_local";          backup_volume usr_local; }
[ "$WITH_CODESERVER" = 1 ] && { log "Тома (опц): code-server-config"; backup_volume "code-server-config"; }

# 3. Bind-mount workspace(s) — опционально (большие, обычно сборки из GitHub)
if [ "$WITH_WORKSPACES" = 1 ]; then
  log "Workspaces: /home/nebulide/workspace + /home/nebulide/workspaces"
  tar czf "$WORK/workspace.tar.gz"  -C /home/nebulide workspace
  tar czf "$WORK/workspaces.tar.gz" -C /home/nebulide workspaces
fi

# 4. Секреты
log ".env"
cp "$ENV_FILE" "$WORK/env"

# 5. SSL-сертификаты
log "letsencrypt"
tar czf "$WORK/letsencrypt.tar.gz" -C /etc letsencrypt

# 6. MANIFEST + контрольные суммы
log "MANIFEST"
{
  echo "Nebulide snapshot $TS"
  echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "git: $(git -C "$PROJECT_DIR" log -1 --format='%h %s' 2>/dev/null || echo n/a)"
  echo "claude_cli: $(docker exec nebulide-app-1 claude --version 2>/dev/null || echo n/a)"
  echo "core_volumes: $CORE_VOLUMES"
  echo "with_workspaces=$WITH_WORKSPACES with_usrlocal=$WITH_USRLOCAL with_codeserver=$WITH_CODESERVER"
  echo "--- sha256 ---"
} > "$WORK/MANIFEST.txt"
( cd "$WORK" && find . -type f ! -name MANIFEST.txt -exec sha256sum {} \; ) >> "$WORK/MANIFEST.txt"

# 7. Упаковать в один архив
log "Упаковка → $ARCHIVE"
tar czf "$ARCHIVE" -C "$PROJECT_DIR/backups" "snapshot-$TS"
rm -rf "$WORK"

# 8. Сделать архив читаемым для пользователя (scp без root)
OWNER="${SUDO_USER:-nebulide}"
chown "$OWNER":"$OWNER" "$ARCHIVE" 2>/dev/null || true

SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "=== ГОТОВО: $ARCHIVE ($SIZE) ==="
echo
echo "Стянуть на свою машину:"
echo "  scp -P <ssh-port> nebulide:$ARCHIVE ."
