#!/usr/bin/env node
// Nebulide Claude Code hook — КРОСС-ПЛАТФОРМЕННЫЙ (Windows + Linux), один скрипт на обе ОС.
// Claude Code вызывает его на зарегистрированные события, передавая JSON на stdin.
// Читаем stdin, ремапим поля, POSTим на бэкенд (как nebulide-hook.sh, но через node fetch).
//
// Env (инъектятся терминалом Nebulide, см. backend/handlers/terminal.go):
//   NEBULIDE_HOOK_TOKEN  — scoped JWT
//   NEBULIDE_HOOK_URL    — эндпоинт бэкенда
//   NEBULIDE_INSTANCE_ID — id терминала

const { NEBULIDE_HOOK_TOKEN, NEBULIDE_HOOK_URL, NEBULIDE_INSTANCE_ID } = process.env;
if (!NEBULIDE_HOOK_TOKEN || !NEBULIDE_HOOK_URL) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let inp = {};
  try { inp = JSON.parse(raw); } catch { /* пустой/битый stdin — шлём минимум */ }

  // Claude шлёт: hook_event_name, tool_name, tool_input, session_id, cwd, permission_mode, status
  // Бэкенд ждёт: event, tool, tool_input, session_id, instance_id, cwd, permission_mode, status
  const payload = {
    event: inp.hook_event_name,
    session_id: inp.session_id,
    instance_id: NEBULIDE_INSTANCE_ID,
    tool: inp.tool_name,
    tool_input: inp.tool_input,
    cwd: inp.cwd,
    permission_mode: inp.permission_mode,
    status: inp.status,
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    await fetch(NEBULIDE_HOOK_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NEBULIDE_HOOK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(t);
  } catch { /* бэкенд выключен/недоступен — тихо игнорим (fire-and-forget) */ }
  process.exit(0);
});
