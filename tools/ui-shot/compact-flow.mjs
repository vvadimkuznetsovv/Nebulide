// ТЕСТ /compact: засеять контекст (пара объёмных ответов) → /compact → покадрово (1.5с) логировать
// СЫРОЙ вывод терминала claude + state.progress/workStatus, чтобы УВИДЕТЬ, что реально печатает
// компакт (есть ли блок-глиф-бар и %, или просто «Compacting… (Ns)»). По факту лога чиним детект.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const DIR = './shots/compact';
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);

// Отправить сообщение и дождаться, пока claude завершит (busy→false), максимум maxMs.
const sendAndWaitDone = async (text, maxMs = 70000) => {
  await h.box().click(); await h.box().fill(text); await h.box().press('Enter');
  let started = false;
  for (let t0 = Date.now(); Date.now() - t0 < maxMs;) {
    const s = await h.st();
    if (s.busy) started = true;
    if (started && !s.busy) return true;
    await sleep(800);
  }
  return started;
};

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude открыт: ' + o.instanceId + ' alive=' + o.alive);

  h.startFrames(1500);

  // 1. ЗАСЕВ контекста — два объёмных ответа, чтобы было что компактить.
  h.setPhase('seed');
  await h.snap('before-seed');
  h.log('▶ засев 1/2');
  await sendAndWaitDone('Напиши подробный рассказ про осенний лес на 15 предложений.');
  await h.snap('seed-1-done');
  h.log('▶ засев 2/2');
  await sendAndWaitDone('Теперь перечисли 20 фактов о грибах, каждый с пояснением в 2 предложения.');
  await h.snap('seed-2-done');

  // 2. /compact — следим покадрово за прогрессом.
  h.setPhase('compact');
  await h.box().click(); await h.box().fill('/compact'); await h.box().press('Enter');
  h.log('▶ отправлен /compact');

  let sawProgress = false, sawBar = false;
  for (let i = 0; i < 60; i++) { // ~90с
    const s = await h.logFrame('compact-poll');
    const d = await h.dom();
    if (s.progress != null) { sawProgress = true; if (!sawBar && d.sheen) { sawBar = true; await h.snap('compact-bar'); } }
    // компакт завершён → новая сводка, busy спал и меню нет
    const xt = await h.xterm(20);
    if (/compacted|сжат|summary|Compacted/i.test(xt) && !s.busy) { h.log('  ✓ компакт завершён'); break; }
    await sleep(1500);
  }
  h.setPhase('after');
  await h.snap('after-compact');
  h.log(`\n=== ИТОГ: progress ловился=${sawProgress}; бар(sheen) показан=${sawBar} ===`);
} catch (e) {
  h.log('FATAL: ' + e.message);
  await h.snap('fatal').catch(() => {});
} finally {
  await h.stopFrames();
  await h.closeClaude();
  h.flush();
  await sleep(1000);
  await b.close();
}
