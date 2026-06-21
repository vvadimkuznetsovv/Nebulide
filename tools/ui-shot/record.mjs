// ИНСТРУМЕНТИРОВАННЫЙ прогон: гоняет тест-диалог «создание приложения» в plan-режиме и ЗАПИСЫВАЕТ
// ВСЁ на каждом шаге → ./shots/rec/NN-label.png + ./shots/rec/record.log:
//   • состояние детектора (busy/mode/menu/tabs/options)
//   • ЧАТ как видит юзер (innerText ленты) = весь вывод claude в интерфейсе
//   • СЫРОЙ экран claude (что реально в терминале) — чтобы видеть, что НЕ обёрнуто/пропущено
//   • скриншот
// Цель: по логу+скринам видно, где карточки/обёртки не хватает (скилл целиком, меню /model и т.п.).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = 'http://localhost:5173';
const DIR = './shots/rec';
mkdirSync(DIR, { recursive: true });
let LOG = '';
const log = (s) => { LOG += s + '\n'; };

const b = await chromium.launch({ headless: false, slowMo: 120, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const chatText = () => p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').trim(); });
async function poll(pred, ms, l) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (l) log('  …timeout: ' + l); return null; }
async function send(t) { await box().click(); await box().fill(t); await box().press('Enter'); }
async function clickCard(text) { const btn = p.locator('.droppable-panel button').filter({ hasText: text }).first(); if (await btn.count()) { await btn.click().catch(() => {}); return true; } return false; }
async function cycleModeTo(t, max = 5) { const f = p.locator('span[title*="Сменить режим"]').first(); for (let i = 0; i < max && (await scr())?.state?.mode !== t; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(900); } return (await scr())?.state?.mode === t; }

let N = 0;
async function snap(label) {
  N++; const id = String(N).padStart(2, '0');
  await p.screenshot({ path: `${DIR}/${id}-${label}.png` }).catch(() => {});
  const s = await scr(); const st = s?.state || {};
  const chat = await chatText().catch(() => '');
  const raw = (s?.xtermScreen || '').split('\n').filter((l) => l.trim()).slice(-22).join('\n');
  log(`\n================= [${id}] ${label} =================`);
  log(`СОСТОЯНИЕ: busy=${st.busy} mode=${st.mode} permMenu=${st.permMenu} kind=${st.permKind} resume=${st.resumeMenu} work="${st.workStatus || ''}"`);
  if (st.permMenu) log(`МЕНЮ-КАРТОЧКА: вопрос="${st.permQuestion}"\n  tabs=${JSON.stringify(st.permTabs || [])}\n  опции=${JSON.stringify((st.permOptions || []).map((o) => o.digit + '=' + o.label))}\n  detail[:200]="${(st.permDetail || '').slice(0, 200)}"`);
  log(`--- ЧАТ (что видит юзер) ---\n${chat.slice(0, 2500)}`);
  log(`--- СЫРОЙ ЭКРАН claude (хвост) ---\n${raw}`);
}

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  for (const t of ['File Manager', 'Preview', 'Editor']) { for (let i = 0; i < 3; i++) { const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first(); if (!(await x.count())) break; await x.click({ timeout: 3000 }).catch(() => {}); await sleep(400); } }
  await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {}); await sleep(900); await term().click();
  await p.keyboard.press('Control+C'); await sleep(250); await p.keyboard.press('Control+C'); await sleep(500); await p.keyboard.press('Enter'); await sleep(700);
  await p.keyboard.type('claude'); await p.keyboard.press('Enter');
  const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 18000);
  if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
  await poll((s) => s.state?.alive || /for agents/i.test(s.xtermScreen || ''), 18000, 'ready');
  await p.getByRole('button', { name: 'Чат' }).last().click().catch(() => {}); await sleep(2500);
  await snap('старт');

  await cycleModeTo('plan'); await snap('plan-режим');
  await send('Создай мини-приложение: todo-лист на чистом HTML+JS в одном файле todo.html. Сначала уточни детали 2-3 вопросами с вариантами, потом дай план.');

  // цикл по вопросам/плану
  let sawPlan = false;
  for (let step = 0; step < 7 && !sawPlan; step++) {
    const m = await poll((s) => s.state?.permMenu, 70000, `меню шаг${step + 1}`);
    if (!m) { await snap(`нет-меню-${step + 1}`); break; }
    const opts = m.state.permOptions || [];
    const isPlan = opts.some((o) => /approve edits|auto mode|refine|what to change/i.test(o.label));
    await sleep(2500);
    if (isPlan) { sawPlan = true; await snap('ПЛАН-карточка'); await clickCard('manually approve'); }
    else { await snap(`ВОПРОС-${step + 1}`); await clickCard(opts[0]?.label || '1'); }
    await sleep(2500);
  }
  // permission на действие
  const perm = await poll((s) => s.state?.permMenu && s.state?.permKind === 'permission', 50000, 'permission');
  if (perm) { await snap('PERMISSION-карточка'); await clickCard('Да'); }
  // ждём завершения и снимаем финал
  await poll((s) => s.state?.busy === false && s.state?.alive, 60000, 'готово');
  await sleep(3000);
  await snap('ФИНАЛ-весь-диалог');
} catch (e) { log('ОШИБКА: ' + e.message); }
finally {
  writeFileSync(`${DIR}/record.log`, LOG);
  await b.close();
  console.log(`Записано ${N} снимков → ${DIR}/ (+ record.log)`);
}
