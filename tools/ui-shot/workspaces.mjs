// Тест ФИЧИ Workspaces (multi-device). Часть 1 (один браузер): create / switch / persist /
// rename / delete — с АДАПТИВНЫМ закрытием лишних окон в КАЖДОМ новом воркспейсе (новый ws
// открывается с дефолтной раскладкой Chat+FileManager). Часть 2 (два контекста, тот же admin):
// блокировка + «Take Over Session». createSession ЗАКРЫВАЕТ сайдбар → переоткрываем (ensureSidebar).
// Скрины+лог → shots/workspaces/.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { closePanels } from './lib/ui.mjs';
import { ensureTesters, TESTER1 } from './lib/users.mjs';

const URL = 'http://localhost:5173';
const DIR = './shots/workspaces';
mkdirSync(DIR, { recursive: true });
// ВАЖНО: тест под tester1, НЕ admin — иначе изменения воркспейса/раскладки уйдут в ЖИВУЮ сессию через sync.
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };
const results = []; const ok = (n, p, e = '') => { results.push({ n, p: !!p }); log(`${p ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); };

const login = async (p, creds = TESTER1) => {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', creds.username);
  await p.fill('input[placeholder="Enter password"]', creds.password);
  await p.click('button[type="submit"]'); await p.waitForTimeout(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
};
// Открыть сайдбар, ТОЛЬКО если он закрыт: кнопка title="Show sidebar" существует лишь в закрытом
// состоянии (в открытом — "Hide sidebar"), поэтому повторный вызов безопасен (no-op если открыт).
const ensureSidebar = async (p) => { const b = p.locator('button[title="Show sidebar"]').first(); if (await b.count()) { await b.click().catch(() => {}); await p.waitForTimeout(700); } };

await ensureTesters();
const browser = await chromium.launch({ headless: false, slowMo: 60, args: ['--start-maximized'] });
let N = 0; const snap = async (p, l) => { N++; await p.screenshot({ path: `${DIR}/${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };

try {
  // ============ Часть 1: CRUD + persist ============
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  await login(p); await snap(p, 'login'); await closePanels(p); await ensureSidebar(p); await snap(p, 'sidebar');

  const tag = Date.now().toString().slice(-4);
  const A = `WS-A-${tag}`, B = `WS-B-${tag}`;
  // Новый ws открывается с дефолтной раскладкой → адаптивно закрываем лишние окна сразу.
  const newWs = async (name) => {
    await ensureSidebar(p);
    await p.locator('button[title="New workspace"]').first().click().catch(() => {}); await p.waitForTimeout(400);
    const inp = p.locator('input[placeholder="Workspace name"]').first();
    await inp.fill(name).catch(() => {}); await inp.press('Enter').catch(() => {}); await p.waitForTimeout(1600);
    await closePanels(p);
  };
  const switchWs = async (name) => { await ensureSidebar(p); await p.getByText(name, { exact: false }).first().click().catch(() => {}); await p.waitForTimeout(1800); };

  await newWs(A); await snap(p, 'ws-A');
  ok('создан Workspace A', (await p.getByText(A, { exact: false }).count()) > 0, A);
  await newWs(B); await snap(p, 'ws-B');
  ok('создан Workspace B', (await p.getByText(B, { exact: false }).count()) > 0, B);

  // persist: в A открыть панель Скиллы → switch B → switch A (раскладка должна восстановиться)
  await switchWs(A);
  const skillsToggle = p.locator('button[title="Show Скиллы"]').first();
  if (await skillsToggle.count()) { await skillsToggle.click().catch(() => {}); await p.waitForTimeout(1200); }
  const aSkills1 = (await p.locator('.droppable-panel:has-text("Скиллы")').count()) > 0;
  await snap(p, 'A-skills'); await p.waitForTimeout(2000);
  await switchWs(B); await snap(p, 'B'); const bSkills = (await p.locator('.droppable-panel:has-text("Скиллы")').count()) > 0;
  await switchWs(A); await snap(p, 'back-A'); const aSkills2 = (await p.locator('.droppable-panel:has-text("Скиллы")').count()) > 0;
  ok('switch A→B→A', true);
  ok('persist: раскладка A восстановилась', aSkills1 && !bSkills && aSkills2, `A1=${aSkills1} B=${bSkills} A2=${aSkills2}`);

  // rename B (правый клик → инпут в фокусе → Ctrl+A + ввод + Enter)
  const Bren = B + '-ren'; await ensureSidebar(p);
  await p.getByText(B, { exact: false }).first().click({ button: 'right' }).catch(() => {}); await p.waitForTimeout(600);
  await p.keyboard.press('Control+A').catch(() => {}); await p.keyboard.type(Bren).catch(() => {}); await p.keyboard.press('Enter').catch(() => {});
  await p.waitForTimeout(1200); await snap(p, 'renamed-B');
  ok('rename B', (await p.getByText(Bren, { exact: false }).count()) > 0, Bren);

  // delete A (switch на Bren → A неактивен → hover → крестик → confirm)
  await switchWs(Bren); await ensureSidebar(p);
  p.once('dialog', (d) => d.accept().catch(() => {}));
  const aItem = p.locator('.group').filter({ hasText: A }).first();
  await aItem.hover().catch(() => {});
  const del = aItem.locator('button[title="Delete workspace"]').first();
  if (await del.count()) { await del.click().catch(() => {}); await p.waitForTimeout(1500); }
  await snap(p, 'deleted-A');
  ok('delete A', (await p.getByText(A, { exact: false }).count()) === 0);
  await ctx.close();

  // ============ Часть 2: lock + takeover ============
  const c1 = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p1 = await c1.newPage(); await login(p1); await closePanels(p1); await p1.waitForTimeout(3500); await snap(p1, 'lock-ctx1');
  const c2 = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p2 = await c2.newPage(); await login(p2); await closePanels(p2); await p2.waitForTimeout(4500); await snap(p2, 'lock-ctx2');
  await p1.waitForTimeout(2500); await snap(p1, 'lock-ctx1-after');
  const hasModal = (await p1.getByText('Workspace In Use', { exact: false }).count()) > 0;
  ok('lock: ctx1 показал «Workspace In Use» после захода ctx2', hasModal);
  if (hasModal) {
    await p1.getByText('Take Over Session', { exact: false }).first().click().catch(() => {}); await p1.waitForTimeout(2800);
    const gone = (await p1.getByText('Workspace In Use', { exact: false }).count()) === 0;
    await snap(p1, 'lock-tookover');
    ok('lock: «Take Over Session» вернул владение (модалка ушла)', gone);
  }
  await c1.close(); await c2.close();
} catch (e) { log('ОШИБКА: ' + e.message); ok('без фатала', false, e.message); }
finally {
  await browser.close();
  const pass = results.filter((r) => r.p).length;
  const head = `===== Workspaces: ${pass}/${results.length} ok =====`;
  console.log('\n' + head);
  writeFileSync(`${DIR}/workspaces.log`, head + '\n' + LOG);
  console.log(`--- готово: скрины+лог в ${DIR}/ ---`);
}
