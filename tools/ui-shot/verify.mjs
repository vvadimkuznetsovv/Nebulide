// ВИДИМАЯ перепроверка фикса склейки: отправляем ДВА сообщения подряд (второе во время работы
// claude) — раньше склеивались в один пузырь, теперь должны быть РАЗДЕЛЬНЫМИ. Окно развёрнуто,
// в конце ПАУЗА, чтобы рассмотреть. Браузер закрывается в finally.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const b = await chromium.launch({ headless: false, slowMo: 200, args: ['--start-maximized'] });
const ctx = await b.newContext({ viewport: null });
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
async function poll(pred, ms, l) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (l) console.log('timeout', l); return null; }

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

  // СООБЩЕНИЕ 1 (длинное) → claude думает
  console.log('>> Отправляю СООБЩЕНИЕ 1…');
  await box().click(); await box().fill('СООБЩЕНИЕ-ОДИН: напиши рассказ про море на 200 слов'); await box().press('Enter');
  await poll((s) => s.state?.busy === true, 20000, 'busy1');
  await sleep(2500);
  // СООБЩЕНИЕ 2 во время работы (раньше склеивалось)
  console.log('>> Отправляю СООБЩЕНИЕ 2 во время работы claude…');
  await box().click(); await box().fill('СООБЩЕНИЕ-ДВА: ответь словом ОК'); await box().press('Enter');
  await poll((s) => s.state?.busy === false && s.state?.alive, 45000, 'idle');
  await sleep(3000);

  // проверка: НЕТ пузыря, содержащего оба маркера сразу
  const glued = await p.evaluate(() => [...document.querySelectorAll('div,p,span')].some(e => { const t = e.textContent || ''; return t.includes('СООБЩЕНИЕ-ОДИН') && t.includes('СООБЩЕНИЕ-ДВА') && t.length < 160; }));
  console.log(glued ? '❌ СКЛЕЙКА всё ещё есть' : '✅ СКЛЕЙКИ НЕТ — сообщения раздельные');
  await p.screenshot({ path: './shots/verify.png' });
  console.log('>> Смотри окно: два сообщения должны быть ОТДЕЛЬНЫМИ пузырями. Пауза 12с…');
  await sleep(12000);
} catch (e) { console.log('ОШИБКА:', e.message); }
finally { await b.close(); console.log('браузер закрыт.'); }
