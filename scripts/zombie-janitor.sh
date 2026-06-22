#!/usr/bin/env bash
# zombie-janitor — СТРАХОВКА от зомби-процессов. Основной фикс — `init: true` (tini) в docker-compose
# (реапит сирот мгновенно). Этот janitor — последний рубеж: если зомби ВСЁ РАВНО накопились сверх
# порога (например, tini не активен / контейнер не пересоздан), перезапускает контейнер (PID 1
# пересоздаётся → зомби зачищаются) и шлёт Telegram-алерт.
#
# Установка (на сервере, root) — cron каждые 10 минут:
#   cp scripts/zombie-janitor.sh /opt/nebulide/scripts/ && chmod +x /opt/nebulide/scripts/zombie-janitor.sh
#   ( crontab -l 2>/dev/null; echo '*/10 * * * * /opt/nebulide/scripts/zombie-janitor.sh' ) | crontab -
set -uo pipefail

THRESHOLD="${ZOMBIE_THRESHOLD:-500}"      # сколько зомби терпим, прежде чем рестартить
CONTAINER="${ZOMBIE_CONTAINER:-nebulide-app-1}"
LOG="${ZOMBIE_LOG:-/var/log/zombie-janitor.log}"

ts() { date '+%F %T'; }

# Число зомби (stat начинается с Z) во ВСЕЙ системе (контейнерные процессы видны и с хоста).
Z=$(ps -eo stat --no-headers 2>/dev/null | awk '$1 ~ /^Z/' | wc -l)

if [ "${Z:-0}" -le "$THRESHOLD" ]; then
  echo "$(ts) ok zombies=$Z (порог $THRESHOLD)" >> "$LOG" 2>/dev/null || true
  exit 0
fi

echo "$(ts) ВНИМАНИЕ zombies=$Z > $THRESHOLD → перезапуск $CONTAINER" >> "$LOG" 2>/dev/null || true
docker restart "$CONTAINER" >> "$LOG" 2>&1 || echo "$(ts) docker restart FAILED" >> "$LOG"

# Telegram-алерт (берём токен/чат из окружения или из /opt/nebulide/.env).
[ -f /opt/nebulide/.env ] && { set -a; . /opt/nebulide/.env 2>/dev/null; set +a; }
TOK="${TELEGRAM_BOT_TOKEN:-${TG_TOKEN:-}}"
CHAT="${TELEGRAM_ADMIN_CHAT:-${TG_CHAT:-${ADMIN_CHAT_ID:-}}}"
if [ -n "$TOK" ] && [ -n "$CHAT" ]; then
  curl -s -m 5 -X POST "https://api.telegram.org/bot${TOK}/sendMessage" \
    -d chat_id="$CHAT" \
    -d text="🧟 zombie-janitor: было ${Z} зомби (> ${THRESHOLD}) → перезапустил ${CONTAINER}. Проверь init:true (tini) и источники curl-циклов." >/dev/null 2>&1 || true
fi
