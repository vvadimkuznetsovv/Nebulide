// Снимает состояние детектора (__nebScreen) после промпта-триггера и печатает: что на экране +
// что распознал детектор (permMenu/permOptions/busy/...). Аргумент: текст промпта в терминал.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const PROMPT = process.argv[2] || 'выполни в bash ровно команду: echo привет-тест';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const sleep = (ms) => p.waitForTimeout(ms);
const tail = (s, n = 16) => (s?.xtermScreen || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');

await p.goto(URL + '/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin');
await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await sleep(5000);
await p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {});
await sleep(1500);

await p.locator('.xterm-screen, .xterm').first().click();
await p.keyboard.type(PROMPT);
await p.keyboard.press('Enter');

for (let i = 0; i < 12; i++) {
  await sleep(2000);
  const s = await scr();
  const st = s?.state || {};
  if (st.permMenu || st.resumeMenu) {
    console.log(`\n##### МЕНЮ РАСПОЗНАНО (t+${(i + 1) * 2}s) #####`);
    console.log('kind=', st.permKind, 'multi=', st.permMulti, 'question=', JSON.stringify(st.permQuestion));
    console.log('options=', JSON.stringify((st.permOptions || []).map((o) => o.digit + '=' + o.label)));
    console.log('--- экран ---\n' + tail(s, 18));
    break;
  }
  if (i === 11) { console.log('\n##### МЕНЮ НЕ РАСПОЗНАНО — экран: #####\n' + tail(s, 18) + '\n--- state ---\n' + JSON.stringify(st)); }
}
await b.close();
console.log('\nготово');
