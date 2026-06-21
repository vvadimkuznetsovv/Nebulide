// Захват СЫРОГО экрана первого вопроса (AskUserQuestion) в plan-режиме — чтобы увидеть точный
// формат табов-заголовков и прогресса для мульти-вопроса.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
async function poll(pred, ms, l) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (l) console.log('timeout', l); return null; }
async function cycleModeTo(t, max = 5) { const f = p.locator('span[title*="Сменить режим"]').first(); for (let i = 0; i < max && (await scr())?.state?.mode !== t; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(900); } return (await scr())?.state?.mode === t; }
await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(4500);
await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {}); await sleep(900); await term().click();
await p.keyboard.press('Control+C'); await sleep(250); await p.keyboard.press('Control+C'); await sleep(500); await p.keyboard.press('Enter'); await sleep(700);
await p.keyboard.type('claude'); await p.keyboard.press('Enter');
const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 18000);
if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
await poll((s) => s.state?.alive || /for agents/i.test(s.xtermScreen || ''), 18000, 'ready');
await p.getByRole('button', { name: 'Чат' }).last().click().catch(() => {}); await sleep(2200);
await cycleModeTo('plan');
await box().click(); await box().fill('Создай приложение-todo на React. Сначала задай 3 уточняющих вопроса с вариантами, потом план.'); await box().press('Enter');
const m = await poll((s) => s.state?.permMenu, 70000, 'menu');
await sleep(1500);
const tabs = (await scr())?.state?.permTabs || [];
console.log('permTabs:', JSON.stringify(tabs));
console.log('permQuestion:', (await scr())?.state?.permQuestion);
await p.screenshot({ path: './shots/qcard.png' });
console.log('скрин карточки → shots/qcard.png');
await b.close();
