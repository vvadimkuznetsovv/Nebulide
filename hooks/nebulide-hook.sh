#!/bin/bash
# Nebulide Claude Code Hook
# Called by Claude Code for registered events.
# Reads JSON from stdin, remaps field names, POSTs to backend.

# Env vars injected by Nebulide terminal:
# NEBULIDE_HOOK_TOKEN — scoped JWT for auth
# NEBULIDE_HOOK_URL   — backend endpoint URL
# NEBULIDE_INSTANCE_ID — terminal instance ID

if [ -z "$NEBULIDE_HOOK_TOKEN" ] || [ -z "$NEBULIDE_HOOK_URL" ]; then
  exit 0
fi

# Read hook JSON from stdin
INPUT=$(cat)

# Claude Code sends: hook_event_name, tool_name, tool_input, session_id, cwd, permission_mode
# Backend expects:   event, tool, tool_input, session_id, instance_id
# Remap field names with jq
PAYLOAD=$(echo "$INPUT" | jq -c --arg iid "$NEBULIDE_INSTANCE_ID" '{
  event: .hook_event_name,
  session_id: .session_id,
  instance_id: $iid,
  tool: .tool_name,
  tool_input: .tool_input,
  cwd: .cwd,
  permission_mode: .permission_mode,
  status: .status
}' 2>/dev/null)

# Fallback if jq not available — construct minimal JSON
if [ -z "$PAYLOAD" ] || [ "$PAYLOAD" = "null" ]; then
  EVENT=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' | head -1 | cut -d'"' -f4)
  SESSION=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
  TOOL=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
  PAYLOAD="{\"event\":\"${EVENT}\",\"session_id\":\"${SESSION}\",\"instance_id\":\"${NEBULIDE_INSTANCE_ID}\",\"tool\":\"${TOOL}\"}"
fi

# POST to backend (fire-and-forget, 2s timeout)
curl -s -m 2 -X POST "$NEBULIDE_HOOK_URL" \
  -H "Authorization: Bearer $NEBULIDE_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 &

exit 0
