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
  await h.startRecording();

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
  h.setPhase('compact-done');
  await sleep(1500);
  await h.snap('compact-done');
  h.log('  компакт завершён — отправляю НОВОЕ сообщение, чтобы показать, что чат продолжается');

  // 3. ЧАТ ПРОДОЛЖАЕТСЯ после компакта: новый вопрос на сжатом контексте → claude отвечает.
  h.setPhase('after-compact');
  await h.box().click();
  await h.box().fill('Сколько всего фактов о грибах ты привёл выше? Ответь одним числом.');
  await h.box().press('Enter');
  h.log('▶ новый вопрос отправлен после компакта');
  let answered = false;
  for (let i = 0; i < 40; i++) { // ~60с: ждём начало (busy) и завершение ответа
    await sleep(1500);
    const s = await h.snap('after-poll');
    if (s.busy) answered = true; // claude начал отвечать
    if (answered && !s.busy && s.alive) { h.log('  ✓ claude ОТВЕТИЛ после компакта — чат продолжается'); break; }
  }
  await h.snap('after-answer');
  h.log(`\n=== ИТОГ: progress=${sawProgress}; бар=${sawBar}; чат продолжился после компакта=${answered} ===`);
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
