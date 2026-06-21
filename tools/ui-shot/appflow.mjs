// ВИДИМЫЙ тест-диалог «создание приложения» в PLAN-режиме (НЕ auto!). Прогоняет реальный поток:
//  plan-режим → запрос на приложение → ВОПРОСЫ (AskUserQuestion) → отвечаем → ПЛАН (ExitPlanMode)
//  → одобряем ВРУЧНУЮ (не auto) → PERMISSION на действия → разрешаем.
// На каждом состоянии — пауза + скриншот, чтобы видеть карточку. Браузер закрывается в finally.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const R = [];
const ok = (n, pass, extra = '') => { R.push({ n, pass }); console.log(`${pass ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };

const b = await chromium.launch({ headless: false, slowMo: 160, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const st = async () => (await scr())?.state || {};
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const shot = (n) => p.screenshot({ path: `./shots/${n}.png` }).catch(() => {});
async function poll(pred, ms, l) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (l) console.log('  …timeout:', l); return null; }
async function send(t) { await box().click(); await box().fill(t); await box().press('Enter'); }
async function clickCardBtn(text) { const btn = p.locator('.droppable-panel button').filter({ hasText: text }).first(); if (await btn.count()) { await btn.click().catch(() => {}); return true; } return false; }
async function cycleModeTo(target, max = 5) { const f = p.locator('span[title*="Сменить режим"]').first(); for (let i = 0; i < max && (await st()).mode !== target; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(900); } return (await st()).mode === target; }

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  for (const t of ['File Manager', 'Preview', 'Editor']) { for (let i = 0; i < 3; i++) { const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first(); if (!(await x.count())) break; await x.click({ timeout: 3000 }).catch(() => {}); await sleep(400); } }

  // чистый старт claude
  await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {}); await sleep(900); await term().click();
  await p.keyboard.press('Control+C'); await sleep(250); await p.keyboard.press('Control+C'); await sleep(500); await p.keyboard.press('Enter'); await sleep(700);
  await p.keyboard.type('claude'); await p.keyboard.press('Enter');
  const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 18000);
  if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
  await poll((s) => s.state?.alive || /for agents/i.test(s.xtermScreen || ''), 18000, 'ready');
  await p.getByRole('button', { name: 'Чат' }).last().click().catch(() => {}); await sleep(2500);

  // 1. PLAN-режим (НЕ auto!)
  const inPlan = await cycleModeTo('plan');
  ok('1. включён plan-режим (не auto)', inPlan, `mode=${(await st()).mode}`);

  // 2. запрос на создание приложения
  await send('Создай простое веб-приложение counter.html: кнопка и счётчик кликов на чистом HTML+JS. Сначала уточни детали вопросами, потом дай план.');

  // 3. цикл: ВОПРОСЫ (AskUserQuestion) → отвечаем; ПЛАН → одобряем вручную
  let sawQuestion = false, sawPlan = false;
  for (let step = 0; step < 6 && !sawPlan; step++) {
    const m = await poll((s) => s.state?.permMenu, 70000, `меню шаг${step + 1}`);
    if (!m) break;
    const opts = m.state.permOptions || [];
    const isPlan = opts.some((o) => /approve edits|auto mode|refine|what to change|proceed/i.test(o.label + ' ' + (m.state.permQuestion || '')));
    await sleep(3500); // ПАУЗА — видно карточку
    if (isPlan) {
      sawPlan = true;
      ok('5. ПЛАН обёрнут и показан карточкой', true, `кнопок: ${opts.length}`);
      await shot('app-plan');
      // одобряем ВРУЧНУЮ (manually approve), НЕ auto mode
      const okClick = await clickCardBtn('manually approve') || await clickCardBtn('Yes, manually');
      ok('6. одобрение плана ВРУЧНУЮ (не auto)', okClick);
    } else {
      sawQuestion = true;
      ok(`3.${step + 1} ВОПРОС показан карточкой`, !!m.state.permQuestion, `${m.state.permQuestion} | варианты: ${opts.map(o => o.digit + '=' + o.label).join(', ')}`);
      await shot(`app-question-${step + 1}`);
      // отвечаем — выбираем первый вариант
      const answered = await clickCardBtn(opts[0]?.label || '1');
      ok(`4.${step + 1} ответ на вопрос выбран`, answered, opts[0]?.label);
    }
    await sleep(2500);
  }
  ok('3. claude задал ВОПРОСЫ (выбор вариантов)', sawQuestion);
  ok('5. claude дошёл до ПЛАНА', sawPlan);

  // 7. PERMISSION на действия (claude создаёт counter.html)
  const perm = await poll((s) => s.state?.permMenu && s.state?.permKind === 'permission', 50000, 'permission');
  ok('7. PERMISSION на действие показан карточкой', !!perm, perm ? (perm.state.permOptions || []).map(o => o.digit + '=' + o.label).join(', ') : 'не дошло до действия');
  if (perm) { await shot('app-permission'); await sleep(3500); /* разрешаем */ await clickCardBtn('Да'); }
  await sleep(4000);

} catch (e) { console.log('ОШИБКА:', e.message); }
finally {
  console.log(`\n=== ИТОГ: ${R.filter(r => r.pass).length}/${R.length} ===`);
  R.filter(r => !r.pass).forEach(r => console.log('  ❌ ' + r.n));
  await b.close(); console.log('браузер закрыт.');
}
