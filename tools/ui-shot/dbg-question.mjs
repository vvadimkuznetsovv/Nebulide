// PROBE: AskUserQuestion (Q1→Q2→Q3→Submit answers) — проверка адаптивного autoAnswer (открытие
// через окно Chat, триггер вопросов, проклацывание всех + Submit). tester1, одно окно desktop.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow } from './lib/ui.mjs';
mkdirSync('./shots/dbg', { recursive: true });
const b = await chromium.launch({ headless: false, slowMo: 45, args: ['--window-position=0,0', '--window-size=1100,960', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
let inst = 'default';
const stOf = async () => (await p.evaluate((id) => window.__nebScreen && window.__nebScreen(id), inst))?.state || {};
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]').first();
const click = async (loc, t = 1500) => { if (await loc.count()) { await loc.first().click({ timeout: t }).catch(() => {}); return true; } return false; };
let N = 0; const snap = async (l) => { N++; await p.screenshot({ path: `./shots/dbg/Q${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };

const autoAnswer = async (maxMs = 120000) => {
  const t0 = Date.now(); let acted = false; let calm = 0;
  while (Date.now() - t0 < maxMs) {
    const s = await stOf();
    if (s.permMenu && s.permKind === 'permission') {
      if (!(await click(p.getByText('Да', { exact: true })))) { const yes = (s.permOptions || []).find((o) => /^(да|yes|allow|разреш)/i.test(o.label)); if (yes) await click(p.getByText(yes.label, { exact: false })); }
      console.log('  → permission: Да'); acted = true; calm = 0; await sleep(2500);
    } else if (s.permMenu && s.permKind === 'question') {
      if (await click(p.getByText('Submit answers', { exact: false }))) console.log('  → Submit answers');
      else if (await click(p.getByText('Готово', { exact: false }))) console.log('  → Готово');
      else { const opt = (s.permOptions || [])[0]; if (opt) { (await click(p.getByText(opt.label, { exact: true }))) || (await click(p.getByText(opt.label, { exact: false }))); console.log('  → вариант:', opt.label); } }
      acted = true; calm = 0; await sleep(1800);
    } else if (s.busy) { calm = 0; await sleep(700); }
    else { calm++; if (calm >= 6) break; await sleep(700); }
  }
  return acted;
};

try {
  await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  const o = await openClaudeViaChatWindow(p); inst = o.instanceId; console.log('opened:', JSON.stringify(o));
  if (!o.alive) throw new Error('claude не открылся');

  await box().click(); await box().fill('Прежде чем что-то делать, задай мне РОВНО 3 уточняющих вопроса по одному, КАЖДЫЙ с 3-4 вариантами на выбор (интерактивный выбор вариантов): 1) фреймворк, 2) стилизация, 3) сборщик.'); await box().press('Enter');
  console.log('отправил триггер вопросов, жду карточку…');
  for (let t0 = Date.now(); Date.now() - t0 < 95000;) { const s = await stOf(); if (s.permMenu && s.permKind === 'question') break; await sleep(700); }
  await snap('question-card');
  console.log('autoAnswer: проклацываю все вопросы + Submit…');
  await autoAnswer(120000);
  await sleep(3000); await snap('after');
  const s = await stOf();
  console.log('=== ИТОГ: меню закрыто =', !s.permMenu, '| claude думает =', s.busy, '===');
} catch (e) { console.log('FATAL:', e.message); }
finally { await sleep(2000); await b.close(); }
