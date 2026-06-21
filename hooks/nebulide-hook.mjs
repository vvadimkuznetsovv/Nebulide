#!/usr/bin/env node
// Nebulide Claude Code hook — КРОСС-ПЛАТФОРМЕННЫЙ (Windows + Linux), один скрипт на обе ОС.
// Claude Code вызывает его на зарегистрированные события, передавая JSON на stdin.
// Читаем stdin СИНХРОННО (fs.readFileSync(0)) — на Windows асинхронное чтение stdin +
// process.exit() в колбэке роняет node libuv-ассертом (async.c: UV_HANDLE_CLOSING),
// claude показывает «startup hook error». Синхронное чтение + естественный выход это снимают.
//
// Env (инъектятся терминалом Nebulide): NEBULIDE_HOOK_TOKEN / NEBULIDE_HOOK_URL / NEBULIDE_INSTANCE_ID
import { readFileSync } from 'node:fs';

const { NEBULIDE_HOOK_TOKEN, NEBULIDE_HOOK_URL, NEBULIDE_INSTANCE_ID } = process.env;
if (!NEBULIDE_HOOK_TOKEN || !NEBULIDE_HOOK_URL) process.exit(0);

let inp = {};
try { inp = JSON.parse(readFileSync(0, 'utf8')); } catch { /* пустой/битый stdin */ }

// Claude: hook_event_name, tool_name, tool_input, session_id, cwd, permission_mode, status
// Бэкенд: event, tool, tool_input, session_id, instance_id, cwd, permission_mode, status
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

const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 2000);
fetch(NEBULIDE_HOOK_URL, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${NEBULIDE_HOOK_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  signal: ctrl.signal,
}).catch(() => {}).finally(() => clearTimeout(t)); // без process.exit — выходим естественно
