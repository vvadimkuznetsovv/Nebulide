// ДИАГНОСТ JSONL: пишем claude НАПРЯМУЮ в терминал (не через чат), смотрим — отвечает ли в
// терминале, и печатаем сырой экран. JSONL на диске проверяю отдельно (Bash) до и после выхода.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
const tailScreen = (s, n = 22) => (s?.xtermScreen || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');
async function poll(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(500); } console.log('timeout:', label); return null; }

await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(4500);
await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {});
await sleep(1000);
await term().click();
// чистый старт
await p.keyboard.press('Control+C'); await sleep(250);
await p.keyboard.press('Control+C'); await sleep(500);
await p.keyboard.press('Enter'); await sleep(700);
// claude
await p.keyboard.type('claude'); await p.keyboard.press('Enter');
const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 20000, 'trust');
if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
await poll((s) => (s.state && s.state.alive) || /for agents|for shortcuts/i.test(s.xtermScreen || ''), 20000, 'ready');

// ПИШЕМ ПРЯМО В ТЕРМИНАЛ (claude получает гарантированно)
await term().click();
await p.keyboard.type('посчитай 17 умножить на 23, ответь ТОЛЬКО числом');
await sleep(300);
await p.keyboard.press('Enter');
console.log('>> отправлено в терминал, ждём ответа claude…');
await poll((s) => s.state && s.state.busy === true, 12000, 'busy');
await poll((s) => s.state && s.state.busy === false && s.state.alive, 35000, 'idle');
await sleep(2500);
console.log('=== СЫРОЙ ЭКРАН claude ПОСЛЕ ОТВЕТА (есть ли 391?) ===');
console.log(tailScreen(await scr()));
console.log('\n>> МАРКЕР: до-выхода (проверь диск сейчас)');
await sleep(8000); // окно, чтобы Bash успел снять состояние «до выхода»
// выходим из claude → flush?
await term().click();
await p.keyboard.press('Control+C'); await sleep(300);
await p.keyboard.press('Control+C'); await sleep(2500);
console.log('>> вышли из claude (Ctrl+C x2) — теперь проверь диск «после выхода»');
await sleep(2000);
await b.close();
console.log('готово');
