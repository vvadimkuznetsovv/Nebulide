// ДИАГНОСТИКА (одно тихое окно): выяснить ПО ФАКТУ, как устроен сайдбар при 569px и чем он
// надёжно закрывается. Дампит innerWidth/DPR, элемент сайдбара+bbox, backdrop, кнопку X, панели,
// и ПРОБУЕТ закрыть разными способами, фиксируя что сработало. Лог → shots/dbg/sidebar.log.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';

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

const wsId = await ensureWs('WS-Main');
const browser = await chromium.launch({ headless: false, slowMo: 60, args: ['--window-position=0,0', '--window-size=569,960', '--no-first-run'] });
const ctx = await browser.newContext({ viewport: null });
await ctx.addInitScript((id) => { try { localStorage.setItem('nebulide-active-workspace', id); } catch { /* */ } }, wsId);
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
let N = 0; const snap = async (l) => { N++; await p.screenshot({ path: `${DIR}/${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };
const sidebarVisible = () => p.evaluate(() => !![...document.querySelectorAll('*')].find((e) => e.textContent === 'WORKSPACES'));

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});

  const dims = await p.evaluate(() => ({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio }));
  log(`innerWidth=${dims.iw} innerHeight=${dims.ih} dpr=${dims.dpr}`);

  // открыть сайдбар
  const showBtn = p.locator('button[title="Show sidebar"]').first();
  log('кнопка "Show sidebar" найдена: ' + (await showBtn.count()));
  if (await showBtn.count()) { await showBtn.click().catch(() => {}); await sleep(800); }
  await snap('sidebar-open');
  log('сайдбар открыт (есть WORKSPACES): ' + (await sidebarVisible()));

  // дамп фактов о сайдбаре/backdrop/кнопках
  const facts = await p.evaluate(() => {
    const out = {};
    // backdrop кандидаты
    const bds = [...document.querySelectorAll('.fixed.inset-0')].map((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { cls: e.className, z: cs.zIndex, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hasOnclick: !!e.onclick };
    });
    out.backdrops = bds;
    // все кнопки с title
    out.titledButtons = [...document.querySelectorAll('button[title]')].map((b) => {
      const r = b.getBoundingClientRect();
      return { title: b.title, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 };
    }).filter((b) => b.vis);
    // элемент-контейнер с WORKSPACES → его ширина
    const wsLabel = [...document.querySelectorAll('*')].find((e) => e.textContent === 'WORKSPACES');
    let cont = wsLabel;
    for (let i = 0; i < 6 && cont; i++) { const r = cont.getBoundingClientRect(); if (r.width > 200) break; cont = cont.parentElement; }
    if (cont) { const r = cont.getBoundingClientRect(); out.sidebarBox = { cls: cont.className.slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }
    return out;
  });
  log('\n=== BACKDROPS (.fixed.inset-0) ===\n' + JSON.stringify(facts.backdrops, null, 1));
  log('\n=== SIDEBAR BOX ===\n' + JSON.stringify(facts.sidebarBox, null, 1));
  log('\n=== TITLED BUTTONS (видимые) ===\n' + facts.titledButtons.map((b) => `  "${b.title}" @(${b.x},${b.y}) ${b.w}x${b.h}`).join('\n'));

  // ── ПРОБА 1: кнопка X (title="Close") ──
  log('\n--- ПРОБА 1: button[title="Close"] ---');
  const closeBtn = p.locator('button[title="Close"]');
  log('  count(title=Close)=' + (await closeBtn.count()));
  if (await closeBtn.count()) { await closeBtn.first().click({ timeout: 2500 }).catch((e) => log('  click err: ' + e.message)); await sleep(900); }
  log('  сайдбар ещё открыт: ' + (await sidebarVisible()));
  await snap('after-close-btn');

  // ── ПРОБА 2: если открыт — backdrop справа ──
  if (await sidebarVisible()) {
    log('\n--- ПРОБА 2: backdrop клик справа ---');
    const bd = p.locator('.fixed.inset-0').last();
    log('  count(.fixed.inset-0)=' + (await bd.count()));
    if (await bd.count()) { const box = await bd.boundingBox(); log('  bbox=' + JSON.stringify(box)); await p.mouse.click((box?.x || 0) + (box?.width || 500) - 25, (box?.y || 0) + 420).catch((e) => log('  mouse err: ' + e.message)); await sleep(900); }
    log('  сайдбар ещё открыт: ' + (await sidebarVisible()));
    await snap('after-backdrop');
  }

  // ── ПРОБА 3: если открыт — Escape ──
  if (await sidebarVisible()) {
    log('\n--- ПРОБА 3: Escape ---');
    await p.keyboard.press('Escape'); await sleep(800);
    log('  сайдбар ещё открыт: ' + (await sidebarVisible()));
    await snap('after-escape');
  }

  log('\n=== ИТОГ: сайдбар закрыт=' + (!(await sidebarVisible())) + ' ===');
} catch (e) { log('FATAL: ' + e.message); }
finally { writeFileSync(`${DIR}/sidebar.log`, LOG); await sleep(1500); await browser.close(); console.log('--- лог → shots/dbg/sidebar.log ---'); }
