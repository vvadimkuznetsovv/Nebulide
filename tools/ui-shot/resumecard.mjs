// Живой тест: /resume → КАРТОЧКА списка сессий в Чате. Адаптивный старт. Скрин + проверка DOM.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const b = await chromium.launch({ headless: false, slowMo: 130, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const nb = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const stOf = async () => (await nb())?.state || {};
const term = () => p.locator('.xterm-screen, .xterm').first();
const toMode = (n) => p.getByRole('button', { name: n }).last().click().catch(() => {});
try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  for (const t of ['File Manager', 'Preview', 'Editor']) { for (let i = 0; i < 3; i++) { const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first(); if (!(await x.count())) break; await x.click({ timeout: 3000 }).catch(() => {}); await sleep(400); } }
  // адаптивный старт
  await toMode('Терминал'); await sleep(900); await term().click();
  let s = await stOf();
  if (!s.alive) { console.log('claude не запущен → запускаю'); await p.keyboard.type('claude'); await p.keyboard.press('Enter'); for (let t0 = Date.now(); Date.now() - t0 < 20000;) { const sc = await nb(); if (/trust this folder|Yes, I trust/i.test(sc?.rawTailTail || '')) { await p.keyboard.press('Enter'); await sleep(1500); } if (sc?.state?.alive) break; await sleep(400); } }
  else console.log('claude уже запущен');
  // триггерим /resume В ТЕРМИНАЛЕ (без слэш-палитры)
  await term().click(); await p.keyboard.type('/resume'); await sleep(400); await p.keyboard.press('Enter');
  // ждём детект пикера
  let detected = false;
  for (let t0 = Date.now(); Date.now() - t0 < 15000;) { if ((await stOf()).resumePicker) { detected = true; break; } await sleep(500); }
  const rp = (await stOf()).resumePicker;
  console.log('детектор resumePicker:', detected, '| сессий:', rp ? rp.sessions.length : 0, '| выбран:', rp ? rp.selectedIndex : '-');
  // в Чат — карточка должна появиться
  await toMode('Чат'); await sleep(2500);
  const cardVisible = await p.locator('.droppable-panel:has-text("Возобновить сессию")').count();
  const names = await p.evaluate(() => [...document.querySelectorAll('.droppable-panel button')].map(b=>b.textContent.slice(0,40)).filter(t=>/ago|HEAD|KB/.test(t)).slice(0,6));
  console.log('КАРТОЧКА /resume в Чате видна:', cardVisible > 0);
  console.log('сессии в карточке:', JSON.stringify(names));
  await p.screenshot({ path: './shots/resumecard.png' });
} catch (e) { console.log('ОШИБКА:', e.message); }
finally { await b.close(); console.log('--- готово: shots/resumecard.png ---'); }
