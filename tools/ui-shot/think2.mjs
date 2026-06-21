// Надёжное репро «мышление не отображается»: поллим детектор через window.__nebScreen,
// проходим trust-промпт по-человечески (Enter), шлём сообщение, проверяем state.busy.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
const shot = (n) => p.screenshot({ path: `./shots/${n}.png` });
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const sleep = (ms) => p.waitForTimeout(ms);
async function poll(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(700); }
  console.log('TIMEOUT:', label); return null;
}

await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]');
await sleep(5000);
await p.addStyleTag({ content: '.lava-blob{display:none!important}' });

// запускаем claude в терминале
await p.locator('.xterm-screen, .xterm').first().click();
await p.keyboard.type('claude');
await p.keyboard.press('Enter');

// ждём trust-промпт ЛИБО готовность claude
const tr = await poll((s) => /trust this folder|you created or one you trust|Yes, I trust/i.test(s.xtermScreen || ''), 22000, 'trust');
await shot('a1-launch');
if (tr) { console.log('TRUST → Enter'); await p.keyboard.press('Enter'); await sleep(1500); }
const ready = await poll((s) => (s.state && s.state.alive) || /for shortcuts|for agents|to interrupt/i.test(s.xtermScreen || ''), 20000, 'ready');
await shot('a2-ready');
console.log('state(ready):', JSON.stringify(ready?.state));

// в режим Чат
await p.getByRole('button', { name: 'Чат' }).last().click().catch(() => console.log('no Чат btn'));
await sleep(2500);
await shot('a3-chat');

// отправляем сообщение
const input = p.locator('textarea[placeholder*="Сообщение для Claude"]');
await input.click();
await input.fill('посчитай 17 умножить на 23, ответь одним числом');
await input.press('Enter');

// ждём busy (мышление по детектору)
const busy = await poll((s) => s.state && s.state.busy === true, 18000, 'busy=true');
console.log('BUSY достигнут:', !!busy, '| state:', JSON.stringify((await scr())?.state));
await shot('a4-thinking');
// ждём окончания (ответ) и снимаем ленту
await poll((s) => s.state && s.state.busy === false && s.state.alive === true, 30000, 'ответ готов');
await sleep(2500);
await shot('a6-conversation');
console.log('final state:', JSON.stringify((await scr())?.state));
await b.close();
console.log('готово');
