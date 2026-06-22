// Тест РЕНДЕР-ЦЕПОЧКИ без отправки: логин → Чат → ждём → скрин. Если лента уже записанной
// сессии (claude -p "2+2"→"4") подтянулась — resolve→tail→рендер работает end-to-end.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 900, height: 900 } })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(4000);
await p.addStyleTag({ content: '.lava-blob{display:none!important}' });
// в режим Чат
await p.getByRole('button', { name: 'Чат' }).last().click().catch(() => {});
await sleep(4000);
await p.screenshot({ path: './shots/render.png' });
// текст ленты
const txt = await p.evaluate(() => document.querySelector('.agent-chat, [class*=chat]')?.innerText?.slice(0, 600) || '(нет)');
console.log('--- текст чата ---\n' + txt);
await b.close();
