// Засев КОНТЕКСТА: открывает N терминалов, в каждом запускает claude и даёт многошаговую
// задачу → длинная лента (есть что компактить; можно гонять несколько попыток тестов на разных
// instanceId без коллизий одного 'default'-терминала). Best-effort: селектор кнопки нового
// терминала и trust-промпт обрабатываются адаптивно.  N=3 node seed-context.mjs  (по умолчанию 2)
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const N = Number(process.env.N || 2);
const TASK = 'Создай мини-приложение todo.html (HTML+JS в одном файле: добавление, удаление и отметка задач). Делай по шагам и поясняй каждый шаг — мне нужен подробный разбор.';

const b = await chromium.launch({ headless: false, slowMo: 80, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const nb = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));

await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(4000);
await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});

for (let i = 0; i < N; i++) {
  // Новый терминал — кнопка в сайдбаре (title содержит «Терминал»); fallback — режим Терминал.
  const newTerm = p.locator('button[title*="ерминал"]').first();
  if (await newTerm.count()) { await newTerm.click().catch(() => {}); await sleep(1600); }
  const term = p.locator('.xterm-screen, .xterm').last();
  await term.click().catch(() => {});
  await p.keyboard.type('claude'); await p.keyboard.press('Enter');
  // ждём загрузки / trust-промпта
  for (let t0 = Date.now(); Date.now() - t0 < 18000;) {
    const scr = await p.evaluate(() => { const s = window.__nebScreen && window.__nebScreen('default'); return s ? s.xtermScreen || s.rawTailTail || '' : ''; }).catch(() => '');
    if (/trust this folder|Yes, I trust/i.test(scr)) { await p.keyboard.press('Enter'); await sleep(1500); break; }
    await sleep(500);
  }
  await sleep(2500);
  await term.click().catch(() => {});
  await p.keyboard.type(TASK); await p.keyboard.press('Enter');
  console.log(`[${i + 1}/${N}] claude запущен и получил задачу`);
  await sleep(3000);
}

console.log(`Посеяно ${N} терминалов. Даю claude поработать ~30с (накопить контекст), затем закрываю браузер (сессии живут на бэкенде).`);
await sleep(30000);
await b.close();
console.log('--- засев завершён ---');
