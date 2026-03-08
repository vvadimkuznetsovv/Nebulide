#!/bin/bash
# SSH failed login attempt watcher — monitors auth.log in real-time
# Debounce: 30s per IP

TOKEN=$(grep TELEGRAM_BOT_TOKEN /opt/nebulide/.env | cut -d= -f2)
[ -z "$TOKEN" ] && { echo "No TELEGRAM_BOT_TOKEN in .env"; exit 1; }

CHAT_ID=289626498
LOG="/var/log/auth.log"
STATE_DIR="/tmp/ssh-watcher"
mkdir -p "$STATE_DIR"

send_tg() {
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d text="$1" \
    -d parse_mode=HTML \
    -d disable_notification=false >/dev/null 2>&1
}

should_notify() {
  local ip="$1" now=$(date +%s)
  local file="$STATE_DIR/ip_$(echo "$ip" | tr '.' '_')"
  if [ -f "$file" ]; then
    local last=$(cat "$file")
    [ $((now - last)) -lt 30 ] && return 1
  fi
  echo "$now" > "$file"
  return 0
}

cleanup() { find "$STATE_DIR" -name 'ip_*' -mmin +60 -delete 2>/dev/null; }

echo "SSH watcher started, monitoring $LOG"

tail -n 0 -F "$LOG" 2>/dev/null | while read -r line; do

  if echo "$line" | grep -q "Failed password"; then
    USER=$(echo "$line" | grep -oP 'for (invalid user )?\K\S+')
    IP=$(echo "$line" | grep -oP 'from \K[\d.]+')
    PORT=$(echo "$line" | grep -oP 'port \K\d+')
    if should_notify "$IP"; then
      send_tg "❌ <b>SSH попытка входа</b>
🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧
👤 <code>${USER:-unknown}</code>
🌐 <code>${IP:-unknown}</code>
🔌 ${PORT:-?}
🕐 $(date '+%Y-%m-%d %H:%M:%S %Z')
🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧"
    fi
  fi

  if echo "$line" | grep -q "Invalid user"; then
    USER=$(echo "$line" | grep -oP 'Invalid user \K\S+')
    IP=$(echo "$line" | grep -oP 'from \K[\d.]+')
    if should_notify "$IP"; then
      send_tg "⚠️ <b>SSH неизвестный пользователь</b>
🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧
👻 <code>${USER:-unknown}</code>
🌐 <code>${IP:-unknown}</code>
🕐 $(date '+%Y-%m-%d %H:%M:%S %Z')
🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧"
    fi
  fi

  if echo "$line" | grep -q "maximum authentication attempts exceeded\|Too many authentication failures"; then
    IP=$(echo "$line" | grep -oP 'from \K[\d.]+')
    USER=$(echo "$line" | grep -oP 'for \K\S+' | head -1)
    if should_notify "brute_${IP}"; then
      send_tg "🚨 <b>SSH брутфорс</b>
🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥
👤 <code>${USER:-unknown}</code>
🌐 <code>${IP:-unknown}</code>
🕐 $(date '+%Y-%m-%d %H:%M:%S %Z')
⛔ Превышен лимит попыток
🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥"
    fi
  fi

  cleanup
done
