#!/bin/bash
# SSH failed login attempt watcher — monitors auth.log in real-time
# Sends Telegram alerts for: failed passwords, invalid users, brute force
# Install as systemd service: ssh-watcher.service
#
# Debounce: aggregates multiple failures from same IP within 30s window

TOKEN=$(grep TELEGRAM_BOT_TOKEN /opt/nebulide/.env | cut -d= -f2)
[ -z "$TOKEN" ] && { echo "No TELEGRAM_BOT_TOKEN in .env"; exit 1; }

CHAT_ID=289626498
LOG="/var/log/auth.log"
STATE_DIR="/tmp/ssh-watcher"
mkdir -p "$STATE_DIR"

send_tg() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d text="$msg" \
    -d parse_mode=HTML \
    -d disable_notification=false >/dev/null 2>&1
}

# Debounce: track last notification per IP (30s window)
should_notify() {
  local ip="$1"
  local now=$(date +%s)
  local file="$STATE_DIR/ip_$(echo "$ip" | tr '.' '_')"

  if [ -f "$file" ]; then
    local last=$(cat "$file")
    local diff=$((now - last))
    if [ "$diff" -lt 30 ]; then
      return 1  # too soon, skip
    fi
  fi
  echo "$now" > "$file"
  return 0
}

# Cleanup old state files every hour
cleanup() {
  find "$STATE_DIR" -name 'ip_*' -mmin +60 -delete 2>/dev/null
}

echo "SSH watcher started, monitoring $LOG"

# Follow auth.log in real-time
tail -n 0 -F "$LOG" 2>/dev/null | while read -r line; do
  # Failed password
  if echo "$line" | grep -q "Failed password"; then
    USER=$(echo "$line" | grep -oP 'for (invalid user )?\K\S+')
    IP=$(echo "$line" | grep -oP 'from \K[\d.]+')
    PORT=$(echo "$line" | grep -oP 'port \K\d+')

    if should_notify "$IP"; then
      TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
      send_tg "🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡

🔮 <b>NEBULIDE SECURITY</b> 🔮

❌ <b>Failed Login Attempt</b>

┌─────────────────────
│ 👤  <b>User:</b>  <code>${USER:-unknown}</code>
│ 🌐  <b>IP:</b>    <code>${IP:-unknown}</code>
│ 🔌  <b>Port:</b>  ${PORT:-?}
│ 🕐  <b>Time:</b>  ${TIMESTAMP}
└─────────────────────

🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡"
    fi
  fi

  # Invalid user attempt
  if echo "$line" | grep -q "Invalid user"; then
    USER=$(echo "$line" | grep -oP 'Invalid user \K\S+')
    IP=$(echo "$line" | grep -oP 'from \K[\d.]+')

    if should_notify "$IP"; then
      TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
      send_tg "🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠

🔮 <b>NEBULIDE SECURITY</b> 🔮

⚠️ <b>Invalid User Attempt</b>

┌─────────────────────
│ 👻  <b>User:</b>  <code>${USER:-unknown}</code>
│ 🌐  <b>IP:</b>    <code>${IP:-unknown}</code>
│ 🕐  <b>Time:</b>  ${TIMESTAMP}
└─────────────────────

🟠🟠🟠🟠🟠🟠🟠🟠🟠🟠"
    fi
  fi

  # Too many authentication failures (brute force indicator)
  if echo "$line" | grep -q "maximum authentication attempts exceeded\|Too many authentication failures"; then
    IP=$(echo "$line" | grep -oP 'from \K[\d.]+')
    USER=$(echo "$line" | grep -oP 'for \K\S+' | head -1)

    if should_notify "brute_${IP}"; then
      TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
      send_tg "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴

🔮 <b>NEBULIDE SECURITY</b> 🔮

🚨 <b>BRUTE FORCE DETECTED</b> 🚨

┌─────────────────────
│ 👤  <b>User:</b>  <code>${USER:-unknown}</code>
│ 🌐  <b>IP:</b>    <code>${IP:-unknown}</code>
│ 🕐  <b>Time:</b>  ${TIMESTAMP}
│ ⛔  Max auth attempts exceeded!
└─────────────────────

🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴"
    fi
  fi

  # Periodic cleanup
  cleanup
done
