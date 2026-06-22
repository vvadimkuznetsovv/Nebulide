// PROBE: запуск claude ЧЕРЕЗ ОКНО CHAT (терминал НЕ трогаем вообще). Логин → переключиться в Чат →
// отправить первое сообщение в поле чата → claude должен подняться САМ (новая фича launchClaude).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { closePanels, closeSidebar } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const DIR = './shots/dbg';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };

const browser = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=720,960', '--no-first-run'] });
const ctx = await browser.newContext({ viewport: null });
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const stOf = async () => (await scr())?.state || {};
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
let N = 0; const snap = async (l) => { N++; await p.screenshot({ path: `${DIR}/CL${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  await closeSidebar(p); await closePanels(p);

  // ТОЛЬКО Чат — терминал не трогаем
  await p.getByRole('button', { name: 'Чат' }).last().click({ timeout: 4000 }).catch(() => {});
  await sleep(2000); await closeSidebar(p); await snap('chat-empty');
  log('alive на входе: ' + (await stOf()).alive);

  // если claude жив (остаток прошлых прогонов) — выходим ЧЕРЕЗ ЧАТ, чтобы чисто проверить ЗАПУСК
  if ((await stOf()).alive) {
    log('claude жив → /exit ЧЕРЕЗ ЧАТ для чистой проверки запуска');
    await box().click(); await box().fill('/exit'); await box().press('Enter');
    for (let t0 = Date.now(); Date.now() - t0 < 12000;) { if (!(await stOf()).alive) break; await sleep(600); }
    log('alive после /exit: ' + (await stOf()).alive + ' (ожидаем false)');
    await sleep(1500); await snap('after-exit');
  }

  // отправить первое сообщение В ЧАТ → claude должен подняться сам
  log('\n=== отправляю первое сообщение в ЧАТ (без терминала) ===');
  await box().click(); await box().fill('Привет! Ответь одним словом: запущен.'); await box().press('Enter');
  await snap('sent');

  // ждём alive (claude поднялся ИЗ ЧАТА) + ответ
  let alive = false;
  for (let t0 = Date.now(); Date.now() - t0 < 45000;) {
    const s = await scr();
    if (/trust this folder|Yes, I trust|Do you trust/i.test(s?.xtermScreen || '')) { log('trust → Enter'); await p.keyboard.press('Enter'); await sleep(1200); }
    if (s?.state?.alive) { alive = true; break; }
    await sleep(700);
  }
  log('alive ПОСЛЕ сообщения: ' + alive);
  await sleep(6000); await snap('after');
  // проверим, что наше сообщение реально дошло до claude (а не в shell)
  const chat = await p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').trim(); });
  log('сообщение «Привет» в чате: ' + /Привет|запущен/i.test(chat));
  log('\n=== ИТОГ: claude поднят ИЗ ЧАТА = ' + alive + ' ===');
} catch (e) { log('FATAL: ' + e.message); }
finally { writeFileSync(`${DIR}/chatlaunch.log`, LOG); await sleep(2000); await browser.close(); console.log('--- лог → shots/dbg/chatlaunch.log ---'); }
