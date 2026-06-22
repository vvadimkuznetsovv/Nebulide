// АДАПТИВНЫЙ драйвер. Принципы:
//  1) ЧИСТЫЙ старт: выходим из ЛЮБОГО меню+claude, пока claude не исчезнет (alive=false) — иначе
//     драйвер клацал бы по ОСТАВШИМСЯ вопросам прошлой сессии.
//  2) Сначала шлём СВОЙ запрос, ПОТОМ реагируем ТОЛЬКО на его вопросы/план/permission.
//  3) На каждом тике СНАЧАЛА смотрим, что на экране, — НЕ шлём текст поверх меню/во время работы,
//     НЕ клацаем лишнее (один вариант на вопрос; мульти-селект — вариант + один submit).
//  Цель: дойти до ПЛАНА и записать карточку (подтвердить/отказ-доработать/своё). Скрины+лог.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = 'http://localhost:5173';
const DIR = './shots/adapt';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };
const REQUEST = 'Создай мини-приложение: счётчик кликов в одном файле counter.html (HTML+JS). Можешь задать 1-2 уточняющих вопроса, потом дай план на подтверждение.';

const b = await chromium.launch({ headless: false, slowMo: 120, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const stOf = async () => (await scr())?.state || {};
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const toMode = (n) => p.getByRole('button', { name: n }).last().click().catch(() => {});
const chatText = () => p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').trim(); });
async function cycleModeTo(t, max = 5) { const f = p.locator('span[title*="Сменить режим"]').first(); for (let i = 0; i < max && (await stOf()).mode !== t; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(900); } return (await stOf()).mode === t; }
async function clickOption(label) {
  const key = (label || '').replace(/[✔✓☒☐\[\]·]/g, '').trim().split(/\s+/).slice(0, 2).join(' ');
  if (!key) return false;
  const btn = p.locator('.droppable-panel button').filter({ hasText: key }).first();
  if (await btn.count()) { await btn.click().catch(() => {}); return true; }
  return false;
}
async function clickAny(texts) { for (const t of texts) { const btn = p.locator('.droppable-panel button').filter({ hasText: t }).first(); if (await btn.count()) { await btn.click().catch(() => {}); return t; } } return null; }
let N = 0;
async function snap(label) {
  N++; const id = String(N).padStart(2, '0');
  await p.screenshot({ path: `${DIR}/${id}-${label}.png` }).catch(() => {});
  const st = await stOf();
  log(`\n===== [${id}] ${label} | busy=${st.busy} mode=${st.mode} kind=${st.permKind} =====`);
  if (st.permMenu) log(`  вопрос="${st.permQuestion}" multi=${st.permMulti}\n  tabs=${JSON.stringify(st.permTabs || [])}\n  опции=${JSON.stringify((st.permOptions || []).map((o) => o.digit + '=' + o.label))}`);
}

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  for (const t of ['File Manager', 'Preview', 'Editor']) { for (let i = 0; i < 3; i++) { const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first(); if (!(await x.count())) break; await x.click({ timeout: 3000 }).catch(() => {}); await sleep(400); } }

  // (1) ЧИСТЫЙ СТАРТ — выходим из ЛЮБОГО меню+claude, пока claude не исчезнет
  await toMode('Терминал'); await sleep(900); await term().click();
  let exited = false;
  for (let i = 0; i < 5; i++) {
    await p.keyboard.press('Escape'); await sleep(300);
    await p.keyboard.press('Control+C'); await sleep(300);
    await p.keyboard.press('Control+C'); await sleep(600);
    await p.keyboard.press('Enter'); await sleep(700);
    if (!(await stOf()).alive) { exited = true; break; }
  }
  log('чистый старт: claude вышел=' + exited);
  // запускаем claude заново
  await term().click(); await p.keyboard.type('claude'); await p.keyboard.press('Enter');
  for (let t0 = Date.now(); Date.now() - t0 < 18000;) { const s = await scr(); if (/trust this folder|Yes, I trust/i.test(s?.xtermScreen || '')) { await p.keyboard.press('Enter'); await sleep(1500); break; } if (s?.state?.alive) break; await sleep(400); }
  for (let t0 = Date.now(); Date.now() - t0 < 18000;) { if ((await stOf()).alive) break; await sleep(400); }
  await toMode('Чат'); await sleep(2500);
  await cycleModeTo('plan');
  await snap('старт-plan-режим');

  // (2) СНАЧАЛА отправляем запрос (claude должен быть idle, без меню)
  for (let t0 = Date.now(); Date.now() - t0 < 8000;) { const st = await stOf(); if (st.alive && !st.busy && !st.permMenu) break; await sleep(400); }
  log('шлю запрос: ' + REQUEST);
  await box().click(); await box().fill(REQUEST); await box().press('Enter');
  await sleep(2500);

  // (3) РЕАГИРУЕМ только на ответ claude: вопрос → 1 вариант; план → записать; permission → разрешить
  let lastSig = '', stuck = 0, idleTicks = 0, reachedPlan = false;
  for (let tick = 0; tick < 140 && !reachedPlan; tick++) {
    const st = await stOf();
    if (st.permMenu) {
      idleTicks = 0;
      const opts = st.permOptions || [];
      const sig = (st.permKind || '') + '|' + (st.permQuestion || '') + '|' + opts.map((o) => o.digit).join(',');
      const isPlan = opts.some((o) => /approve edits|auto mode|refine|what to change/i.test(o.label));
      const isPerm = st.permKind === 'permission';
      const isNew = sig !== lastSig;
      if (isNew) { lastSig = sig; stuck = 0; await snap(isPlan ? 'ПЛАН' : isPerm ? 'PERMISSION' : 'ВОПРОС'); } else stuck++;

      if (isPlan) {
        reachedPlan = true;
        const chat = await chatText();
        log('\n>>> ПЛАН ПОКАЗАН. Опции: ' + opts.map((o) => o.digit + '=' + o.label).join(' | '));
        log('подтвердить=' + /Yes/.test(chat) + ' отказ/доработать=' + /No,|refine|Ultraplan/i.test(chat) + ' своё-предложение=' + /Tell Claude|what to change/i.test(chat));
        await sleep(6000); await snap('ПЛАН-крупно'); break;
      } else if (isNew && isPerm) { await clickAny(['Да']); }
      else if (isNew) { const real = opts.find((o) => !/type something|chat about/i.test(o.label)) || opts[0]; if (real) { await clickOption(real.label); await sleep(1000); if (st.permMulti) await clickAny(['Готово', 'Next', 'Submit']); } }
      // если на ОДНОМ меню застряли — даём claude время (без слепых кликов)
      if (stuck > 8) { log('  меню не уходит — жду'); await sleep(2000); stuck = 0; }
      await sleep(1400);
    } else if (st.busy) { idleTicks = 0; await sleep(1300); }
    else { if (++idleTicks > 12) { await snap('idle-без-плана'); log('claude в idle, плана нет'); break; } await sleep(1300); }
  }
  log(reachedPlan ? '\n✅ карточка плана записана' : '\n❌ до плана не дошли');
} catch (e) { log('ОШИБКА: ' + e.message); }
finally { writeFileSync(`${DIR}/adaptive.log`, LOG); await b.close(); console.log(`--- готово: ${N} снимков + adaptive.log в ${DIR}/ ---`); }
