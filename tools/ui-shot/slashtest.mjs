// ТЕСТ /compact и /resume в ЧИСТОМ чате. Записывает ВСЁ: скрины + СЫРОЙ экран claude + состояние
// детектора на каждом шаге → shots/slash/. Цель: увидеть, обёрнуты ли /compact и /resume в UI
// (или висят сырым меню в терминале).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = 'http://localhost:5173';
const DIR = './shots/slash';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };
const b = await chromium.launch({ headless: false, slowMo: 130, args: ['--start-maximized'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const stOf = async () => (await scr())?.state || {};
const term = () => p.locator('.xterm-screen, .xterm').first();
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const toMode = (n) => p.getByRole('button', { name: n }).last().click().catch(() => {});
const rawTail = async (n = 20) => ((await scr())?.xtermScreen || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');
let N = 0;
async function snap(label) {
  N++; const id = String(N).padStart(2, '0');
  await p.screenshot({ path: `${DIR}/${id}-${label}.png` }).catch(() => {});
  const st = await stOf();
  log(`\n===== [${id}] ${label} | busy=${st.busy} mode=${st.mode} permMenu=${st.permMenu} kind=${st.permKind} resumeMenu=${st.resumeMenu} =====`);
  if (st.permMenu) log(`  МЕНЮ-карточка: "${st.permQuestion}" опции=${JSON.stringify((st.permOptions || []).map((o) => o.digit + '=' + o.label))}`);
  log('  --- СЫРОЙ экран claude (что реально в терминале) ---\n' + (await rawTail(18)));
}
async function waitIdle(ms = 40000) { for (let t0 = Date.now(); Date.now() - t0 < ms;) { const st = await stOf(); if (st.alive && !st.busy && !st.permMenu) return true; await sleep(500); } return false; }
async function sendChat(t) { await box().click(); await box().fill(t); await box().press('Enter'); }

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin'); await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  // declutter: закрываем File Manager и лишние панели (chat+terminal ОСТАЮТСЯ → лейаут цел).
  // Ломало раньше только закрытие ВСЕХ панелей; File Manager закрывать безопасно.
  for (const t of ['File Manager', 'Preview', 'Editor']) { for (let i = 0; i < 3; i++) { const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first(); if (!(await x.count())) break; await x.click({ timeout: 3000 }).catch(() => {}); await sleep(400); } }

  // ─── АДАПТИВНЫЙ СТАРТ: СНАЧАЛА смотрим, запущен ли claude, потом решаем (без слепого Ctrl+C) ───
  await toMode('Терминал'); await sleep(900); await term().click();
  let s = await stOf();
  if (s.alive) {
    log('claude УЖЕ запущен (alive) → выхожу для НОВОГО чата (Esc меню → /exit, CC только если не помог)');
    if (s.permMenu || s.resumeMenu) { await p.keyboard.press('Escape'); await sleep(700); }
    await p.keyboard.type('/exit'); await p.keyboard.press('Enter'); await sleep(1800);
    if ((await stOf()).alive) { await p.keyboard.press('Control+C'); await sleep(400); await p.keyboard.press('Control+C'); await sleep(900); await p.keyboard.press('Enter'); await sleep(600); }
  } else log('claude НЕ запущен — Ctrl+C НЕ нужен');
  // запускаем claude ТОЛЬКО если его нет
  if (!(await stOf()).alive) {
    log('запускаю claude');
    await term().click(); await p.keyboard.type('claude'); await p.keyboard.press('Enter');
    for (let t0 = Date.now(); Date.now() - t0 < 20000;) { const sc = await scr(); if (/trust this folder|Yes, I trust/i.test(sc?.xtermScreen || '')) { log('trust → Enter'); await p.keyboard.press('Enter'); await sleep(1500); } if (sc?.state?.alive) break; await sleep(400); }
  } else log('claude уже жив — использую как есть');
  for (let t0 = Date.now(); Date.now() - t0 < 18000;) { if ((await stOf()).alive) break; await sleep(400); }
  await toMode('Чат'); await sleep(2500);
  await snap('новый-чат-старт');

  // наполняем чат (чтобы было что компактить) — 2 сообщения
  await waitIdle(8000);
  await sendChat('Привет! Ответь одним словом: один'); await sleep(1500); await waitIdle();
  await sendChat('Теперь ответь одним словом: два'); await sleep(1500); await waitIdle();
  await snap('после-2-сообщений');

  // === /compact ===
  log('\n########## ТЕСТ /compact ##########');
  await sendChat('/compact'); await sleep(2500);
  await snap('compact-отправлен');
  // ждём индикатор сжатия
  let compacting = false;
  for (let t0 = Date.now(); Date.now() - t0 < 30000;) { const st = await stOf(); if (/Compact/i.test(st.workStatus || '') || /Compacting/i.test(await rawTail(8))) { compacting = true; break; } if (!st.busy && (await rawTail(6)).match(/compact|summar/i)) break; await sleep(600); }
  await snap('compact-в-процессе');
  log('сжатие распознано (workStatus/экран): ' + compacting);
  await waitIdle(60000);
  await snap('compact-готово');

  // === /resume ===
  log('\n########## ТЕСТ /resume ##########');
  await sendChat('/resume'); await sleep(3000);
  await snap('resume-отправлен');
  // /resume открывает список сессий в терминале — смотрим, есть ли он + распознан ли картой
  await sleep(2000);
  const st = await stOf();
  const raw = await rawTail(22);
  const hasResumeList = /Resume|Modified|session|ago|❯/i.test(raw) && raw.split('\n').length > 3;
  log('resume permMenu(card)=' + st.permMenu + ' resumeMenu=' + st.resumeMenu + ' | список в сыром экране=' + hasResumeList);
  await snap('resume-меню');

} catch (e) { log('ОШИБКА: ' + e.message); }
finally { writeFileSync(`${DIR}/slash.log`, LOG); await b.close(); console.log(`--- готово: ${N} снимков + slash.log в ${DIR}/ ---`); }
