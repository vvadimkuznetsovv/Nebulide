// НАДЁЖНЫЙ тест карточки ПЛАНА: в plan-режиме просим сразу дать план (без вопросов) → ждём
// ExitPlanMode → записываем карточку плана с ОПЦИЯМИ (подтвердить / отказ-доработать / своё
// предложение) + текст плана. Скрин + лог. Браузер закрывается в finally.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };
const b = await chromium.launch({ headless: false, slowMo: 150, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const chatText = () => p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').trim(); });
async function poll(pred, ms, l) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (l) log('  …timeout: ' + l); return null; }
async function cycleModeTo(t, max = 5) { const f = p.locator('span[title*="Сменить режим"]').first(); for (let i = 0; i < max && (await scr())?.state?.mode !== t; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(900); } return (await scr())?.state?.mode === t; }
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

  const inPlan = await cycleModeTo('plan');
  log('plan-режим: ' + (await scr())?.state?.mode);
  // просим СРАЗУ план, без уточняющих вопросов — чтобы гарантированно дойти до ExitPlanMode
  await box().click(); await box().fill('НЕ задавай уточняющих вопросов. Сразу составь короткий план: создать файл hello.txt с текстом «привет». Затем покажи план на подтверждение.'); await box().press('Enter');
  const plan = await poll((s) => { const o = s.state?.permOptions || []; return s.state?.permMenu && o.some((x) => /approve edits|auto mode|refine|what to change|proceed/i.test(x.label)); }, 90000, 'план');
  if (plan) {
    await sleep(2500);
    const opts = plan.state.permOptions || [];
    log('\n===== КАРТОЧКА ПЛАНА =====');
    log('вопрос: ' + plan.state.permQuestion);
    log('ОПЦИИ ПЛАНА:'); opts.forEach((o) => log(`  ${o.digit}. ${o.label}`));
    log('текст плана (detail[:400]): ' + (plan.state.permDetail || '').slice(0, 400).replace(/\n/g, ' '));
    const chat = await chatText();
    log('\nкарточка содержит «Yes»: ' + /Yes/.test(chat) + ' | «No»/refine: ' + /No,|refine|Ultraplan/i.test(chat) + ' | «Tell»/своё: ' + /Tell Claude|what to change/i.test(chat));
    await p.screenshot({ path: './shots/PLAN-card.png' });
    log('скрин → shots/PLAN-card.png');
    await sleep(6000); // ПАУЗА чтобы рассмотреть карточку плана
  } else { log('❌ план не показался — экран:\n' + ((await scr())?.xtermScreen || '').split('\n').filter(l => l.trim()).slice(-15).join('\n')); await p.screenshot({ path: './shots/PLAN-card.png' }); }
} catch (e) { log('ОШИБКА: ' + e.message); }
finally { writeFileSync('./shots/PLAN-card.log', LOG); await b.close(); console.log('--- готово, лог → shots/PLAN-card.log ---'); }
