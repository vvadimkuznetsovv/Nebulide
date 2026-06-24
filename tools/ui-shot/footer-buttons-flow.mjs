// ТЕСТ КНОПОК ФУТЕРА (rrweb): (1) ⚡ effort — клик открывает меню ПОВЕРХ футера (fixed, видно),
// клик «max» → /effort max уходит; (2) ✨ flicker-free — клик включает (бейдж + подсказка /tui default),
// повторный клик по бейджу выключает (/tui default). Покадровый лог + rrweb-запись → shots/buttons.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const DIR = './shots/buttons';
const b = await chromium.launch({ headless: false, slowMo: 60, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);
const waitIdle = async (maxMs = 30000) => { const t0 = Date.now(); let st0 = 0; while (Date.now() - t0 < maxMs) { const s = await h.st(); if (s.alive && !s.busy && !s.permMenu && !s.resumePicker) { if (!st0) st0 = Date.now(); if (Date.now() - st0 > 1200) return true; } else st0 = 0; await sleep(350); } return false; };

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude: ' + o.instanceId);
  await h.startRecording();
  h.startFrames(1500);
  await waitIdle();

  // ── 1) EFFORT ──
  h.setPhase('effort');
  await h.snap('before-effort');
  const effBtn = p.locator('button[title*="Уровень усилий"]').first();
  h.log('\n⚡ кликаю кнопку effort');
  await effBtn.click({ timeout: 4000 });
  await sleep(600);
  // меню РЕАЛЬНО в DOM и ВИДНО (rect в вьюпорте, не клипнуто)?
  const menu = await p.evaluate(() => {
    const m = document.querySelector('[data-effort-menu]');
    if (!m) return { present: false };
    const r = m.getBoundingClientRect();
    const items = [...m.querySelectorAll('button')].map(x => x.innerText.trim());
    return { present: true, visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1, rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }, items };
  });
  h.log(`   меню effort: present=${menu.present} visible=${menu.visible} items=${JSON.stringify(menu.items)} rect=${JSON.stringify(menu.rect)}`);
  await h.snap('effort-menu-open');
  // клик «max»
  await p.locator('[data-effort-menu] button', { hasText: 'max' }).first().click({ timeout: 3000 }).catch(async () => { await p.getByText('⚡ max', { exact: false }).first().click().catch(() => {}); });
  await sleep(2500);
  const closed = await p.evaluate(() => !document.querySelector('[data-effort-menu]'));
  let effortNow = ''; for (let i = 0; i < 8; i++) { effortNow = (await h.st()).effort || ''; if (effortNow === 'max') break; await sleep(700); }
  const sentEffort = effortNow === 'max'; // футер показал ◈ max · /effort
  h.log(`   после клика «max»: меню закрылось=${closed}, effort стал=${JSON.stringify(effortNow)} (применилось=${sentEffort})`);
  await h.snap('after-effort-max');

  // ── 2) FLICKER-FREE (адаптивно: тогглим из ТЕКУЩЕГО состояния туда и обратно) ──
  h.setPhase('flicker');
  await waitIdle(20000);
  const fsStart = (await h.st()).fullscreen;
  h.log(`\n✨ старт flicker-free = ${fsStart}`);
  // клик по тому, что есть: бейдж «flicker-free» (вкл) ИЛИ кнопка «Стабильнее» (выкл)
  const clickFsToggle = async () => {
    const onBtn = p.locator('button:has-text("flicker-free")').first();
    const offBtn = p.locator('button:has-text("Стабильнее")').first();
    if (await onBtn.count()) { await onBtn.click({ timeout: 4000 }); return 'badge(flicker-free)'; }
    if (await offBtn.count()) { await offBtn.click({ timeout: 4000 }); return 'Стабильнее'; }
    return null;
  };
  const waitFs = async (want) => { for (let i = 0; i < 18; i++) { await sleep(800); if ((await h.st()).fullscreen === want) return true; } return false; };
  // ТОГГЛ 1: в противоположное
  const c1 = await clickFsToggle();
  h.log('   клик 1 по: ' + c1 + ' → жду fullscreen=' + (!fsStart));
  const ok1 = await waitFs(!fsStart);
  const xtA = await h.xterm(12);
  h.log('   тоггл1: fullscreen стал ' + (!fsStart) + ' = ' + ok1 + ' | в терминале: ' + (/\/tui\s+(fullscreen|default)/i.test(xtA) ? xtA.match(/\/tui\s+\w+/i)?.[0] : 'нет'));
  await h.snap('flicker-toggle1');
  // ТОГГЛ 2: обратно
  await waitIdle(15000);
  const c2 = await clickFsToggle();
  h.log('   клик 2 по: ' + c2 + ' → жду fullscreen=' + fsStart);
  const ok2 = await waitFs(fsStart);
  h.log('   тоггл2: fullscreen вернулся в ' + fsStart + ' = ' + ok2);
  await h.snap('flicker-toggle2');

  h.setPhase('done');
  h.log('\n=== ГОТОВО: effort_menu_visible=' + menu.visible + ' effort_applied=' + sentEffort + ' flicker_toggle1=' + ok1 + ' flicker_toggle2=' + ok2 + ' ===');
} catch (e) {
  h.log('FATAL: ' + e.message);
  await h.snap('fatal').catch(() => {});
} finally {
  await h.stopFrames();
  await h.saveRecording();
  await h.closeClaude();
  h.flush();
  await sleep(1000);
  await b.close();
}
