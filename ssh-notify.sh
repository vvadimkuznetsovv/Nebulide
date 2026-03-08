#!/bin/bash
# SSH login notification via Telegram Bot API
# Triggered by PAM (pam_exec.so) on successful SSH login
# Config: session optional pam_exec.so /opt/nebulide/ssh-notify.sh

[ "$PAM_TYPE" != "open_session" ] && exit 0

TOKEN=$(grep TELEGRAM_BOT_TOKEN /opt/nebulide/.env | cut -d= -f2)
[ -z "$TOKEN" ] && exit 0

CHAT_ID=289626498
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
HOST=$(hostname)
IP="${PAM_RHOST:-local}"

MSG=$(cat <<EOF
🔐 <b>SSH Login</b>
<b>User:</b> ${PAM_USER}
<b>Host:</b> ${HOST}
<b>From:</b> ${IP}
<b>Time:</b> ${TIMESTAMP}
EOF
)

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  -d text="$MSG" \
  -d parse_mode=HTML >/dev/null 2>&1 &
disown

exit 0
