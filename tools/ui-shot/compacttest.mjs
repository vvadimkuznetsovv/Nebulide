// ТЕСТ /resume + /compact на БОЛЬШОЙ сессии (с приложением). Адаптивный старт (смотрим, запущен
// ли claude). Резюмируем большую сессию → /compact (есть что сжимать) → показываем /resume-пикер.
// Сырой экран — из rawTailTail (буфер; xtermScreen пуст в режиме Чат). Скрины+лог → shots/cmp/.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = 'http://localhost:5173';
const DIR = './shots/cmp';
const BIG = 'c8c9e1a6-7cde-47ce-a315-c1f87e85e85d'; // крупнейшая сессия (counter/todo/план)
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };
const b = await chromium.launch({ headless: false, slowMo: 120, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const nb = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const stOf = async () => (await nb())?.state || {};
const raw = async () => (await nb())?.rawTailTail || '';
const rawTail = async (n = 16) => (await raw()).split('\n').filter((l) => l.trim()).slice(-n).join('\n');
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const toMode = (n) => p.getByRole('button', { name: n }).last().click().catch(() => {});
let N = 0;
async function snap(label) {
  N++; const id = String(N).padStart(2, '0');
  await p.screenshot({ path: `${DIR}/${id}-${label}.png` }).catch(() => {});
  const st = await stOf();
  log(`\n===== [${id}] ${label} | busy=${st.busy} mode=${st.mode} permMenu=${st.permMenu} resumeMenu=${st.resumeMenu} work="${st.workStatus || ''}" =====`);
  log('  --- СЫРОЙ экран (rawTailTail, хвост) ---\n' + (await rawTail(16)));
}
async function waitContains(re, ms, l) { for (let t0 = Date.now(); Date.now() - t0 < ms;) { if (re.test(await raw())) return true; await sleep(500); } log('  …timeout: ' + l); return false; }

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  // Адаптивно: если открыты панели Chat и File Manager — закрываем (освобождаем место чату).
  for (const t of ['Chat', 'File Manager']) {
    for (let i = 0; i < 3; i++) {
      const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first();
      if (!(await x.count())) break;
      await x.click({ timeout: 3000 }).catch(() => {});
      await sleep(400);
    }
  }

  // АДАПТИВНЫЙ старт: смотрим, запущен ли claude
  await toMode('Терминал'); await sleep(900); await term().click();
  let s = await stOf();
  if (s.alive) {
    log('claude запущен → выхожу (для чистого resume)');
    if (s.permMenu || s.resumeMenu) { await p.keyboard.press('Escape'); await sleep(700); }
    await p.keyboard.type('/exit'); await p.keyboard.press('Enter'); await sleep(1800);
    // /exit уже завершает claude — Ctrl+C вслепую НЕ шлём. Только если /exit перехватило меню и
    // claude всё ещё жив — один Ctrl+C как страховка.
    if ((await stOf()).alive) { await p.keyboard.press('Control+C'); await sleep(900); }
  } else log('claude не запущен — ок');

  // === /resume через --resume большой сессии ===
  log('\n########## RESUME большой сессии ' + BIG + ' ##########');
  await term().click(); await p.keyboard.type(`claude --resume ${BIG}`); await p.keyboard.press('Enter');
  // trust + загрузка
  for (let t0 = Date.now(); Date.now() - t0 < 25000;) { const r = await raw(); if (/trust this folder|Yes, I trust/i.test(r)) { await p.keyboard.press('Enter'); await sleep(1500); } if ((await stOf()).alive) break; await sleep(500); }
  await sleep(2500);
  await snap('resumed-большая-сессия');
  await toMode('Чат'); await sleep(3500);
  const chatLen = await p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').length; });
  log('длина ленты чата (символов, признак большого контекста): ' + chatLen);
  await snap('resumed-лента-в-чате');

  // === /compact на большом контексте ===
  log('\n########## /compact на большом контексте ##########');
  await box().click(); await box().fill('/compact'); await box().press('Enter');
  await sleep(2500);
  await snap('compact-отправлен');
  const compacting = await waitContains(/Compacting|Summariz|сжат/i, 40000, 'Compacting');
  log('СЖАТИЕ распознано: ' + compacting + ' | workStatus=' + (await stOf()).workStatus);
  await snap('compact-в-процессе');
  for (let t0 = Date.now(); Date.now() - t0 < 90000;) { const st = await stOf(); if (st.alive && !st.busy && !/Compacting/i.test(await raw())) break; await sleep(800); }
  await sleep(2000);
  await snap('compact-готово');

  // === /resume-пикер (список сессий) ===
  log('\n########## /resume-ПИКЕР ##########');
  await toMode('Терминал'); await sleep(800); await term().click();
  await p.keyboard.type('/resume'); await sleep(500); await p.keyboard.press('Enter'); await sleep(3000);
  const r = await raw();
  const hasPicker = /resume|modified|ago|❯|\d+ (minutes?|hours?|days?)/i.test(r);
  log('пикер сессий в сыром экране: ' + hasPicker + ' | как карточка (resumeMenu): ' + (await stOf()).resumeMenu);
  await snap('resume-пикер');
  await p.keyboard.press('Escape'); await sleep(500);
} catch (e) { log('ОШИБКА: ' + e.message); }
finally { writeFileSync(`${DIR}/cmp.log`, LOG); await b.close(); console.log(`--- готово: ${N} снимков + cmp.log в ${DIR}/ ---`); }
