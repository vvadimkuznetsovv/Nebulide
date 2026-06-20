#!/bin/bash
# Nebulide Claude Code statusLine
# Claude Code passes a JSON object on stdin with live session info, incl.
# context_window (used_percentage, total_input_tokens, context_window_size).
# We POST it to the backend (→ Redis → chat UI shows live context usage) AND
# print a compact status line for the terminal.
#
# Env vars injected by Nebulide terminal (same as the hook):
#   NEBULIDE_HOOK_TOKEN  — scoped JWT
#   NEBULIDE_HOOK_URL    — backend endpoint URL
#   NEBULIDE_INSTANCE_ID — terminal instance ID

INPUT=$(cat)

# Fire the context to the backend (fire-and-forget). Reuses the hook endpoint
# with event=StatusLine; backend forwards context_window to the chat UI.
if [ -n "$NEBULIDE_HOOK_TOKEN" ] && [ -n "$NEBULIDE_HOOK_URL" ]; then
  PAYLOAD=$(echo "$INPUT" | jq -c --arg iid "$NEBULIDE_INSTANCE_ID" '{
    event: "StatusLine",
    session_id: .session_id,
    instance_id: $iid,
    cwd: .cwd,
    model: .model.display_name,
    context_window: .context_window,
    cost: .cost
  }' 2>/dev/null)
  if [ -n "$PAYLOAD" ] && [ "$PAYLOAD" != "null" ]; then
    curl -s -m 2 -X POST "$NEBULIDE_HOOK_URL" \
      -H "Authorization: Bearer $NEBULIDE_HOOK_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" > /dev/null 2>&1 &
  fi
fi

# Render a compact status line for the terminal (model · context usage).
echo "$INPUT" | jq -r '
  (.model.display_name // "Claude") as $m
  | (.context_window.used_percentage // empty) as $p
  | (.context_window.total_input_tokens // empty) as $t
  | if $p == null or $p == "" then $m
    else "\($m) · ctx \($p)% (\(($t / 1000) | floor)k / \(((.context_window.context_window_size // 200000) / 1000) | floor)k)"
    end
' 2>/dev/null || echo "Claude"
