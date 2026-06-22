import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
const errs=[]; p.on('pageerror', e=>errs.push('PAGEERR: '+e.message.slice(0,300)));
await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
await p.click('button[type="submit"]'); await p.waitForTimeout(9000);
console.log('URL:', p.url());
console.log('pageerrors:', errs.join(' || ') || 'нет');
const html = await p.evaluate(() => {
  const root = document.querySelector('#root') || document.body;
  function outline(el, d=0){ if(d>3) return ''; let s=''; for(const c of el.children){ const cls=(c.className&&c.className.toString().slice(0,30))||''; s+='  '.repeat(d)+c.tagName.toLowerCase()+(cls?'.'+cls:'')+'\n'+outline(c,d+1);} return s; }
  return outline(root);
});
console.log('=== СТРУКТУРА ===\n'+html.slice(0,1500));
await b.close();
