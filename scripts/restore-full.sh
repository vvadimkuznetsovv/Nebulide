#!/bin/bash
# Nebulide — восстановление полного слепка на НОВОМ сервере.
# Разворачивает: .env, SSL, БД (pg_dump), критичные docker-тома.
# Предполагает, что хост уже поднят по SERVER-SETUP.md и репозиторий в /opt/nebulide.
#
# Запуск:  sudo /opt/nebulide/scripts/restore-full.sh <путь-к-nebulide-snapshot-*.tar.gz> [--force]
#
# ВНИМАНИЕ: операция перезапишет .env, /etc/letsencrypt, БД и тома на этом сервере.
set -euo pipefail

PROJECT_DIR=/opt/nebulide
COMPOSE="docker compose -f $PROJECT_DIR/docker-compose.yml"
COMPOSE_PROJECT=nebulide
PG_CONTAINER=nebulide-postgres-1
HELPER_IMAGE=alpine:3.20

ARCHIVE="${1:-}"
FORCE=0; [ "${2:-}" = "--force" ] && FORCE=1

if [ "$(id -u)" -ne 0 ]; then echo "Запусти под root: sudo $0 <архив>" >&2; exit 1; fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Укажи путь к слепку: sudo $0 /path/nebulide-snapshot-YYYYMMDD_HHMMSS.tar.gz [--force]" >&2
  exit 2
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# --- распаковка во временную папку ---
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
log "Распаковка $ARCHIVE"
tar xzf "$ARCHIVE" -C "$TMP"
SNAP=$(find "$TMP" -maxdepth 1 -type d -name 'snapshot-*' | head -1)
[ -z "$SNAP" ] && { echo "В архиве нет каталога snapshot-* — неверный файл" >&2; exit 3; }

# --- проверка контрольных сумм ---
log "Проверка sha256 по MANIFEST"
if [ -f "$SNAP/MANIFEST.txt" ]; then
  ( cd "$SNAP" && sed -n '/--- sha256 ---/,$p' MANIFEST.txt | tail -n +2 | sha256sum -c - ) \
    || { echo "Контрольные суммы НЕ совпали — архив повреждён" >&2; exit 4; }
else
  echo "⚠ MANIFEST.txt отсутствует — пропускаю проверку" >&2
fi
cat "$SNAP/MANIFEST.txt" 2>/dev/null | head -8

# --- подтверждение ---
if [ "$FORCE" != 1 ]; then
  echo
  echo "Будут ПЕРЕЗАПИСАНЫ на этом сервере: .env, /etc/letsencrypt, БД nebulide, тома claude_data/shared_data/ssh_keys/telegram_bot_api_data."
  printf "Продолжить? введи 'yes': "
  read -r ans
  [ "$ans" = "yes" ] || { echo "Отменено."; exit 0; }
fi

# --- остановить стек (тома сохраняются) ---
log "docker compose down"
$COMPOSE down || true

# --- .env (бэкап существующего) ---
if [ -f "$PROJECT_DIR/.env" ]; then cp "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.bak-$(date +%s)"; fi
log ".env → $PROJECT_DIR/.env"
cp "$SNAP/env" "$PROJECT_DIR/.env"

# --- SSL ---
log "letsencrypt → /etc/letsencrypt"
tar xzf "$SNAP/letsencrypt.tar.gz" -C /etc

# --- postgres_data: пересоздать, чтобы init подхватил DB_PASSWORD из нового .env ---
log "Сброс тома postgres_data (рестор идёт из pg_dump)"
docker volume rm "${COMPOSE_PROJECT}_postgres_data" >/dev/null 2>&1 || true

# --- восстановить тома данных (с очисткой перед распаковкой — идемпотентно) ---
restore_volume() {
  local name="$1" file="$SNAP/volumes/$1.tar.gz" vol="${COMPOSE_PROJECT}_$1"
  [ -f "$file" ] || { log "  ⚠ $file нет — пропуск"; return; }
  log "  → том $vol"
  docker volume create "$vol" >/dev/null
  docker run --rm -v "$vol":/dst -v "$SNAP/volumes":/in "$HELPER_IMAGE" \
    sh -c "find /dst -mindepth 1 -delete 2>/dev/null; tar xzf /in/$name.tar.gz -C /dst"
}
log "Тома:"
for v in claude_data shared_data ssh_keys telegram_bot_api_data usr_local code-server-config; do
  restore_volume "$v"
done

# --- поднять только БД, дождаться, загрузить дамп ---
log "Старт postgres + redis"
$COMPOSE up -d postgres redis
log "Жду готовности Postgres"
for i in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U nebulide -d nebulide >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 60 ] && { echo "Postgres не поднялся за 120с" >&2; exit 5; }
done
log "Загрузка дампа БД"
gunzip -c "$SNAP/db.sql.gz" | docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=0 -U nebulide -d nebulide >/dev/null

# --- поднять весь стек ---
log "docker compose up -d (весь стек)"
$COMPOSE up -d

# --- smoke-тест ---
log "=== Проверка ==="
$COMPOSE ps
USERS=$(docker exec "$PG_CONTAINER" psql -U nebulide -d nebulide -t -c "SELECT count(*) FROM users;" 2>/dev/null | tr -d ' ')
log "Пользователей в БД: ${USERS:-?}"
PROJECTS=$(docker exec nebulide-app-1 sh -c 'ls /root/.claude/projects 2>/dev/null | wc -l' || echo 0)
log "Проектов Claude (чаты): ${PROJECTS:-?}"
log "=== ГОТОВО. Проверь https://nebulide.ru (после переключения DNS на этот сервер) ==="
