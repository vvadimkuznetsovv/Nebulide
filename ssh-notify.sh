#!/bin/bash
# SSH login notification via Telegram Bot API
# Triggered by PAM (pam_exec.so) on successful SSH login

[ "$PAM_TYPE" != "open_session" ] && exit 0

TOKEN=$(grep TELEGRAM_BOT_TOKEN /opt/nebulide/.env | cut -d= -f2)
[ -z "$TOKEN" ] && exit 0

CHAT_ID=289626498
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
HOST=$(hostname)
IP="${PAM_RHOST:-local}"

GEO=""
if [ "$IP" != "local" ] && [ -n "$IP" ]; then
  GEO=$(curl -s --max-time 3 "http://ip-api.com/line/${IP}?fields=country,city" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
fi

MSG=$(cat <<EOF
✅ <b>SSH вход</b>
🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪
👤 <code>${PAM_USER}</code>
🖥 <code>${HOST}</code>
🌐 <code>${IP}</code>${GEO:+
📍 ${GEO}}
🕐 ${TIMESTAMP}
🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪
EOF
)

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  -d text="$MSG" \
  -d parse_mode=HTML >/dev/null 2>&1 &
disown

exit 0
