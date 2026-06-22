// Держим интерактивный claude ЖИВЫМ после ответа и НЕ выходим — параллельный Bash поллит диск:
// различаем «не пишет вообще» vs «пишет с задержкой/буфером».
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
async function poll(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(500); } console.log('timeout:', label); return null; }

await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(4500);
await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {});
await sleep(1000); await term().click();
await p.keyboard.press('Control+C'); await sleep(250);
await p.keyboard.press('Control+C'); await sleep(500);
await p.keyboard.press('Enter'); await sleep(700);
await p.keyboard.type('claude'); await p.keyboard.press('Enter');
const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 20000, 'trust');
if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
await poll((s) => (s.state && s.state.alive) || /for agents|for shortcuts/i.test(s.xtermScreen || ''), 20000, 'ready');
await term().click();
await p.keyboard.type('сколько будет 17 на 23, одним числом'); await sleep(300);
await p.keyboard.press('Enter');
console.log('>> SENT', new Date().toISOString());
await poll((s) => s.state && s.state.busy === true, 12000, 'busy');
await poll((s) => s.state && s.state.busy === false && s.state.alive, 30000, 'idle');
console.log('>> ANSWERED, держу claude живым 75с (НЕ выхожу)');
await sleep(75000);
await b.close();
console.log('>> DONE');
