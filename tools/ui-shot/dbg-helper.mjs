// Проверка openClaudeViaChatWindow: claude открыт через окно Chat, окно Chat ЗАКРЫТО (только claude-чат
// на весь экран), claude реально думает и отвечает.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow } from './lib/ui.mjs';
mkdirSync('./shots/dbg', { recursive: true });
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=600,960', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', TESTER1.username);
await p.fill('input[placeholder="Enter password"]', TESTER1.password);
await p.click('button[type="submit"]'); await sleep(5000);
await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});

const r = await openClaudeViaChatWindow(p);
console.log('opened:', JSON.stringify(r));
const chatWin = await p.locator('.droppable-panel:has-text("Claude Sessions")').count();
const panels = await p.evaluate(() => [...document.querySelectorAll('.droppable-panel')].map((pn) => (pn.querySelector('.panel-drag-title,.panel-tab-title')?.textContent || '').trim()));
console.log('окно Chat закрыто:', chatWin === 0, '| панели:', JSON.stringify(panels));
await p.screenshot({ path: './shots/dbg/H1-after-helper.png' });

let answered = false;
if (r.alive) {
  const box = p.locator('textarea[placeholder*="Сообщение для Claude"]').first();
  if (await box.count()) {
    await box.click(); await box.fill('Сколько будет 2+2? Ответь только числом.'); await box.press('Enter');
    let saw = false;
    for (let t0 = Date.now(); Date.now() - t0 < 25000;) { const s = await p.evaluate((i) => window.__nebScreen(i), r.instanceId); if (s?.state?.busy) { saw = true; break; } await sleep(500); }
    for (let t0 = Date.now(); Date.now() - t0 < 65000;) { const s = await p.evaluate((i) => window.__nebScreen(i), r.instanceId); if (s?.state?.alive && !s.state?.busy) break; await sleep(700); }
    await sleep(2500);
    const chat = await p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); return (ta?.closest('.droppable-panel')?.innerText || '').trim(); });
    answered = saw && /(^|[^\d])4([^\d]|$)|четыре/i.test(chat);
    console.log('claude думал:', saw, '| ответ «4»:', /(^|[^\d])4([^\d]|$)/.test(chat), '| answered:', answered);
  }
}
await p.screenshot({ path: './shots/dbg/H2-answered.png' });
console.log('=== ИТОГ: открыт+окноChatЗакрыто+ответил =', r.alive && chatWin === 0 && answered, '===');
await sleep(1500); await b.close();
