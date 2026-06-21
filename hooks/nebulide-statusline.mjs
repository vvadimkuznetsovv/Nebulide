#!/usr/bin/env node
// Nebulide statusLine — КРОСС-ПЛАТФОРМЕННЫЙ (Windows + Linux). Claude Code передаёт на stdin
// JSON с живым контекстом (context_window, model, cost). POSTим на бэкенд (→ чат показывает
// контекст/токены) И печатаем компактную строку для терминала.
// stdin читаем СИНХРОННО + без process.exit (иначе на Windows libuv-краш, см. nebulide-hook.mjs).
//
// Env: NEBULIDE_HOOK_TOKEN / NEBULIDE_HOOK_URL / NEBULIDE_INSTANCE_ID.
import { readFileSync } from 'node:fs';

const { NEBULIDE_HOOK_TOKEN, NEBULIDE_HOOK_URL, NEBULIDE_INSTANCE_ID } = process.env;

let inp = {};
try { inp = JSON.parse(readFileSync(0, 'utf8')); } catch { /* ignore */ }

async function main() {
  // Форвард контекста на бэкенд (event=StatusLine).
  if (NEBULIDE_HOOK_TOKEN && NEBULIDE_HOOK_URL) {
    const payload = {
      event: 'StatusLine',
      session_id: inp.session_id,
      instance_id: NEBULIDE_INSTANCE_ID,
      cwd: inp.cwd,
      model: inp.model?.display_name,
      context_window: inp.context_window,
      cost: inp.cost,
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    await fetch(NEBULIDE_HOOK_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NEBULIDE_HOOK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(t);
  }
  // Компактная строка статуса: «Sonnet 4.6 · ctx 13% (26k / 200k)».
  const cw = inp.context_window || {};
  const model = inp.model?.display_name || 'Claude';
  if (typeof cw.used_percentage === 'number') {
    const tin = Math.floor((cw.total_input_tokens || 0) / 1000);
    const size = Math.floor((cw.context_window_size || 200000) / 1000);
    process.stdout.write(`${model} · ctx ${cw.used_percentage}% (${tin}k / ${size}k)`);
  } else {
    process.stdout.write(model);
  }
}
main(); // без process.exit — естественный выход после завершения промиса
