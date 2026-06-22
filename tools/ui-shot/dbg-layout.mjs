// ДИАГНОСТИКА LAYOUT (одно тихое окно, 569px): ПО ФАКТУ выяснить, как закрывать сайдбар И лишние
// панели, оставляя только Terminal. Дампит панели (title + close-btn bbox/vis), тестирует новый
// closeSidebar (lib/ui) и closePanels, подтверждает результат скрином+логом. → shots/dbg/layout.log.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { closePanels, openSidebar, closeSidebar, sidebarOpen } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const API = 'http://localhost:8080';
const DIR = './shots/dbg';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };

async function ensureWs(name) {
  const lr = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(TESTER1) });
  const { access_token } = await lr.json();
  const list = await (await fetch(`${API}/api/workspace-sessions`, { headers: { Authorization: `Bearer ${access_token}` } })).json().catch(() => []);
  let ws = Array.isArray(list) ? list.find((s) => s.name === name) : null;
  if (!ws) { const cr = await fetch(`${API}/api/workspace-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` }, body: JSON.stringify({ name, device_tag: 'Desktop', snapshot: {} }) }); ws = await cr.json(); }
  return ws.id;
}
const dumpPanels = (p) => p.evaluate(() => [...document.querySelectorAll('.droppable-panel')].map((pn) => {
  const t = (pn.querySelector('.panel-drag-title, .panel-tab-title')?.textContent || '').trim();
  const cb = pn.querySelector('.panel-close-btn'); const r = cb?.getBoundingClientRect(); const pr = pn.getBoundingClientRect();
  return { title: t, panel: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) }, closeBtn: cb ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 } : null };
}));

const wsId = await ensureWs('WS-Main');
const browser = await chromium.launch({ headless: false, slowMo: 60, args: ['--window-position=0,0', '--window-size=569,960', '--no-first-run'] });
const ctx = await browser.newContext({ viewport: null });
await ctx.addInitScript((id) => { try { localStorage.setItem('nebulide-active-workspace', id); } catch { /* */ } }, wsId);
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
let N = 0; const snap = async (l) => { N++; await p.screenshot({ path: `${DIR}/L${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});

  const dims = await p.evaluate(() => ({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio }));
  log(`innerWidth=${dims.iw} innerHeight=${dims.ih} dpr=${dims.dpr}`);
  await snap('start');

  log('\n=== ПАНЕЛИ ДО (как закрывать лишние) ===');
  log(JSON.stringify(await dumpPanels(p), null, 1));

  // ── ТЕСТ САЙДБАРА ──
  log('\n=== САЙДБАР ===');
  await openSidebar(p);
  log('после openSidebar → sidebarOpen=' + (await sidebarOpen(p)));
  await snap('sidebar-open');
  const closed = await closeSidebar(p);
  log('после closeSidebar → вернул=' + closed + ', sidebarOpen=' + (await sidebarOpen(p)));
  await snap('sidebar-closed');

  // ── ТЕСТ ЗАКРЫТИЯ ЛИШНИХ ПАНЕЛЕЙ (оставить Terminal) ──
  log('\n=== closePanels (keep Terminal) ===');
  const cp = await closePanels(p);
  log('found=[' + cp.found.join(', ') + ']  closed=[' + cp.closed.join(', ') + ']');
  await snap('panels-closed');
  const after = await dumpPanels(p);
  log('\n=== ПАНЕЛИ ПОСЛЕ ===\n' + JSON.stringify(after.map((x) => x.title), null, 1));
  const onlyTerminal = after.every((x) => /Terminal/i.test(x.title)) && after.length >= 1;
  log('\n=== ИТОГ: сайдбар закрыт=' + (!(await sidebarOpen(p))) + ' | осталась только Terminal-панель=' + onlyTerminal + ' (панелей: ' + after.length + ') ===');
} catch (e) { log('FATAL: ' + e.message); }
finally { writeFileSync(`${DIR}/layout.log`, LOG); await sleep(1500); await browser.close(); console.log('--- лог → shots/dbg/layout.log ---'); }
