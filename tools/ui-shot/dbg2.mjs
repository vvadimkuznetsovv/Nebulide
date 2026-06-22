import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await p.waitForTimeout(6000);
console.log('панелей:', await p.locator('.droppable-panel').count(), '| xterm:', await p.locator('.xterm,.xterm-screen').count());
await b.close();
