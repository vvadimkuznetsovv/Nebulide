// Проверка прерывания: длинный промпт В ТЕРМИНАЛ, ждём busy, шлём СНАЧАЛА Esc — если не помог,
// Ctrl+C. Печатаем, что реально остановило claude (для фикса стоп-кнопки).
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
async function poll(pred, ms, l) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } console.log('timeout', l); return null; }
async function login() {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
}
await login();
await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {}); await sleep(900); await term().click();
await p.keyboard.press('Control+C'); await sleep(250); await p.keyboard.press('Control+C'); await sleep(500); await p.keyboard.press('Enter'); await sleep(700);
await p.keyboard.type('claude'); await p.keyboard.press('Enter');
const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 18000);
if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
await poll((s) => s.state?.alive || /for agents/i.test(s.xtermScreen || ''), 18000, 'ready');

await term().click();
await p.keyboard.type('напиши очень длинный рассказ на 800 слов про море'); await sleep(300); await p.keyboard.press('Enter');
await poll((s) => s.state?.busy === true, 12000, 'busy');
console.log('busy достигнут, шлю Esc…');
await term().click(); await p.keyboard.press('Escape');
let stopped = !!await poll((s) => s.state?.busy === false, 6000, 'esc-stop');
console.log('Esc остановил?', stopped);
if (!stopped) {
  console.log('Esc не помог, шлю Ctrl+C…');
  await term().click(); await p.keyboard.press('Control+C');
  stopped = !!await poll((s) => s.state?.busy === false, 6000, 'ctrlc-stop');
  console.log('Ctrl+C остановил?', stopped);
}
await sleep(500); await b.close();
