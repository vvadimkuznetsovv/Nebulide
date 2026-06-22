// Быстрый смоук мерджа: логин → режим Чат → скрин шапки (тогглы-иконки + слитый тулбар) и
// композера (2 кнопки: «Команды и скиллы» + режим). НЕ требует запущенного claude. shots/merge/.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = 'http://localhost:5173';
const DIR = './shots/merge';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };
const b = await chromium.launch({ headless: false, slowMo: 80, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
p.on('pageerror', (e) => log('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') log('CONSOLE.ERR: ' + m.text().slice(0, 160)); });
const sleep = (ms) => p.waitForTimeout(ms);
const toMode = (n) => p.getByRole('button', { name: n }).last().click().catch(() => {});
let N = 0;
const snap = async (label) => { N++; await p.screenshot({ path: `${DIR}/${String(N).padStart(2, '0')}-${label}.png` }).catch(() => {}); };

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  await snap('after-login');

  await toMode('Чат'); await sleep(2500);
  await snap('chat-mode');

  // Дамп шапки и композера
  const info = await p.evaluate(() => {
    const txt = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const panel = document.querySelector('.droppable-panel:has(textarea[placeholder*="Сообщение для Claude"])')
      || document.querySelector('textarea[placeholder*="Сообщение для Claude"]')?.closest('.droppable-panel');
    const buttons = panel ? [...panel.querySelectorAll('button')].map(btn => ({ t: txt(btn).slice(0, 24), title: btn.getAttribute('title') || btn.getAttribute('aria-label') || '' })) : [];
    const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]');
    return {
      hasComposer: !!ta,
      cmdSkillsBtn: buttons.find(x => /команд|скил/i.test(x.t))?.t || null,
      modeBtn: buttons.find(x => /режим/i.test(x.t))?.t || null,
      toggleTitles: buttons.filter(x => /Терминал|Чат/i.test(x.title)).map(x => x.title),
      allButtonTitlesTexts: buttons.slice(0, 30),
    };
  });
  log('СМОУК ИНФО:\n' + JSON.stringify(info, null, 2));

  // Открыть палитру команд/скиллов
  const cmdBtn = p.locator('.droppable-panel button').filter({ hasText: /Команды|скил/i }).first();
  if (await cmdBtn.count()) { await cmdBtn.click().catch(() => {}); await sleep(900); await snap('palette-open'); log('палитра: кнопка найдена и нажата'); }
  else log('палитра: кнопка «Команды и скиллы» НЕ найдена');
} catch (e) { log('ОШИБКА: ' + e.message); }
finally { writeFileSync(`${DIR}/merge.log`, LOG); await b.close(); console.log(`--- готово: ${N} снимков + merge.log ---`); }
