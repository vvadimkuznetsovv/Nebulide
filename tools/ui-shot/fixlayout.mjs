import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await p.waitForTimeout(4000);
// ставим все панели видимыми в localStorage и перезагружаем
await p.evaluate(() => {
  const raw = localStorage.getItem('nebulide-layout-v7'); if(!raw) return;
  const d = JSON.parse(raw);
  d.visibility = { chat:true, files:true, editor:true, preview:true, terminal:true, llm:false, pet:false };
  localStorage.setItem('nebulide-layout-v7', JSON.stringify(d));
});
await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(6000);
const after = await p.evaluate(() => JSON.parse(localStorage.getItem('nebulide-layout-v7')||'{}').visibility);
console.log('панелей после фикса:', await p.locator('.droppable-panel').count(), '| visibility:', JSON.stringify(after));
await p.screenshot({ path: './shots/fixlayout.png' });
await b.close();
