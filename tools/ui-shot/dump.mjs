// Снимаем ТОЧНЫЙ текст idle/busy статус-строк claude (через __nebScreen) для обновления детектора.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const sleep = (ms) => p.waitForTimeout(ms);
const tail = (s, n = 10) => (s?.xtermScreen || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');

await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(5000);
await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {});
await sleep(1500);

await p.locator('.xterm-screen, .xterm').first().click();
await p.keyboard.type('напиши подробное эссе на 400 слов про историю древнего Рима на русском');
await p.keyboard.press('Enter');

for (let i = 0; i < 14; i++) {
  await sleep(1500);
  const s = await scr();
  console.log(`\n== t+${((i + 1) * 1.5).toFixed(1)}s busy=${s?.state?.busy} alive=${s?.state?.alive} work="${s?.state?.workStatus}" ==`);
  console.log(tail(s, 5));
}
await b.close();
console.log('\nготово');
