// ТЕСТ ПЛАНА (наглядная rrweb-запись всего потока):
//   plan-режим → запрос подробного плана (без уточнений)
//   → ФАЗА МЫШЛЕНИЯ: пока busy=true держим запись, snap каждые ~1.5с, проверяем ✻ .claude-chat-pulse
//   → КАРТОЧКА ПЛАНА (permIsPlan): держим 8–10с, проверяем крупный .plan-md
//   → «Tell Claude what to change»: ждём раскрытия поля (active=TEXTAREA), ПЕЧАТАЕМ заметный текст
//     посимвольно, ДЕРЖИМ ~3с с текстом в поле (видно), Enter → ждём, что claude ПРИНЯЛ (busy/новый вывод)
//   Адаптивно: вопрос по пути (permMenu && !permIsPlan) — отвечаем; ошибка/неожиданный экран — логируем.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const DIR = './shots/plan';
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);
const st = () => h.st();

const cycleModeTo = async (target, max = 8) => {
  const f = p.locator('button[title*="Сменить режим"]').first();
  for (let i = 0; i < max && (await st()).mode !== target; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(1100); }
  return (await st()).mode === target;
};
const clickLabel = async (label) => {
  const byExact = p.getByText(label, { exact: true }).first();
  if (await byExact.count()) { await byExact.click({ timeout: 2500 }).catch(() => {}); return true; }
  const byFuzzy = p.getByText(label, { exact: false }).first();
  if (await byFuzzy.count()) { await byFuzzy.click({ timeout: 2500 }).catch(() => {}); return true; }
  return false;
};

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude открыт: ' + o.instanceId + ' alive=' + o.alive);
  await h.startRecording();

  h.startFrames(1500);
  h.setPhase('plan-mode');
  const okMode = await cycleModeTo('plan');
  h.log('режим plan выставлен: ' + okMode + ' (mode=' + (await st()).mode + ')');

  // Запрос плана без уточняющих вопросов.
  h.setPhase('plan-send');
  await h.box().click();
  await h.box().fill('НЕ задавай уточняющих вопросов, исходи из разумных дефолтов. Составь подробный план с заголовками (##) и нумерованными пунктами: что нужно сделать, чтобы добавить на index.html кнопку-счётчик кликов с сохранением в localStorage. Когда план готов — предложи его на подтверждение через ExitPlanMode.');
  await sleep(600);
  await h.box().press('Enter');
  h.log('▶ запрос плана отправлен');

  // ── ФАЗА МЫШЛЕНИЯ ── держим запись пока busy=true; snap каждые ~1.5с с workStatus.
  // План может думать 1.5–2.5 мин → ждём карточку до ~270с. По пути адаптивно отвечаем на вопросы.
  h.setPhase('thinking');
  let planSeen = false, lastSig = '', thinkSnaps = 0, sawPulse = false;
  const startWait = Date.now();
  for (let i = 0; (Date.now() - startWait) < 270000; i++) {
    const s = await h.st();
    // Карточка плана появилась → выходим из ожидания.
    if (s.permMenu && s.permIsPlan) { planSeen = true; break; }

    // Адаптив: вопрос по пути (НЕ план) — отвечаем один раз на сигнатуру.
    if (s.permMenu && !s.permIsPlan) {
      const opts = s.permOptions || [];
      const sig = (s.permQuestion || '') + opts.map((x) => x.digit).join('');
      if (sig !== lastSig) {
        lastSig = sig;
        h.log('   [auto] вопрос по пути: ' + opts.map((x) => x.digit + '=' + x.label).join(' | '));
        if (opts.some((x) => /submit answers/i.test(x.label))) await clickLabel('Submit answers');
        else { const opt = opts.find((x) => !/type something|chat about|tell claude/i.test(x.label)) || opts[0]; await clickLabel(opt.label); }
        await sleep(1800);
      }
      await sleep(1200);
      continue;
    }

    // Мышление: busy=true → держим и снимаем кадр с пульсом.
    if (s.busy) {
      const d = await h.dom();
      if (d.pulse) sawPulse = true;
      thinkSnaps++;
      h.setPhase('thinking');
      await h.snap('think-' + String(thinkSnaps).padStart(2, '0'));
      h.log(`   ✻ мышление #${thinkSnaps}: pulse=${d.pulse} «${d.pulseTxt}» work="${s.workStatus || ''}"`);
      await sleep(1500);
      continue;
    }
    // Ещё не busy / переходное — короткий лог-кадр.
    await h.logFrame('wait');
    await sleep(1500);
  }
  h.log(`\n── мышление: кадров=${thinkSnaps}, ✻ pulse виден=${sawPulse}`);

  if (planSeen) {
    const s = await h.st();
    const d = await h.dom();
    h.log(`\n✓✓ КАРТОЧКА ПЛАНА: вопрос="${s.permQuestion}" | опции: ${(s.permOptions || []).map((x) => x.digit + '=' + x.label).join(' | ')}`);
    h.log(`   DOM .plan-md: fontSize=${d.planMd} теги=[${(d.planTags || []).join(',')}]`);
    h.setPhase('plan-card');
    await h.snap('PLAN-CARD');
    // ДЕРЖИМ карточку ~9с (видно) — несколько кадров.
    for (let k = 0; k < 5; k++) { await sleep(1800); await h.snap('plan-hold-' + (k + 1)); }

    // ── TELL CLAUDE ── клик кнопки → ИНЛАЙН-поле раскрывается ПОД кнопками, план НЕ пропадает.
    h.setPhase('tell-claude');
    const clicked = await clickLabel('Tell Claude what to change');
    // Ждём появления ИНЛАЙН-textarea карточки (placeholder про «изменить в плане»).
    const inlineTa = p.locator('textarea[placeholder*="изменить в плане"]').first();
    let opened = false;
    for (let w = 0; w < 25; w++) {
      if (await inlineTa.count()) { opened = true; break; }
      await sleep(200);
    }
    // Проверяем, что КАРТОЧКА ПЛАНА всё ещё на экране (не пропала).
    const planStill = await h.st();
    h.log(`   «Tell Claude» клик=${clicked} → инлайн-поле ${opened ? '✓ РАСКРЫЛОСЬ под кнопкой' : '✗ НЕ раскрылось'}; план-карточка на месте: ${!!(planStill.permMenu && planStill.permIsPlan)}`);
    await h.snap('inline-field-opened');

    // ── ПЕЧАТАЕМ правку ПОСИМВОЛЬНО В ИНЛАЙН-ПОЛЕ (видно набор), держим ~3с.
    h.setPhase('typed');
    const ANSWER = 'Добавь в план пункт про обработку ошибок и логирование.';
    if (opened) {
      await inlineTa.click();
      await inlineTa.type(ANSWER, { delay: 40 });
    }
    await sleep(600);
    const typed = await p.evaluate(() => document.querySelector('textarea[placeholder*="изменить в плане"]')?.value || '');
    h.log('   напечатано в ИНЛАЙН-поле: ' + JSON.stringify(typed));
    await h.snap('typed-in-inline');
    for (let k = 0; k < 3; k++) { await sleep(1000); await h.snap('typed-hold-' + (k + 1)); }

    // Отправляем кнопкой «Отправить правку →».
    await clickLabel('Отправить правку');
    h.setPhase('after-send');
    h.log('   ⏎ ответ отправлен claude');
    // Ждём, пока claude начнёт обрабатывать правку (busy / новый вывод в терминале).
    let accepted = false, sawPulse2 = false;
    for (let w = 0; w < 20; w++) {
      await sleep(1000);
      const sw = await h.st();
      const dw = await h.dom();
      const xt = await h.xterm(20);
      if (dw.pulse) sawPulse2 = true;
      if (sw.busy || dw.pulse || /Crafting|Cogitat|Pondering|Synthesiz|Distilling|Beboppin|обработк|логирован/i.test(xt)) {
        accepted = true;
        h.setPhase('after-send');
        await h.snap('claude-accepted-' + (w + 1));
      }
      // Держим ещё немного после принятия, затем выходим.
      if (accepted && w >= 4) break;
    }
    const sAfter = await h.logFrame('after-send');
    h.log(`   после отправки: busy=${sAfter.busy} ✻pulse=${sawPulse2} accepted=${accepted} ⇒ claude ${accepted ? '✓ ПРИНЯЛ текст (перепланирует)' : '✗ не отреагировал'}`);
    await h.snap('after-send-final');
  } else {
    h.log('✗ карточка плана не появилась за ~270с');
    await h.snap('plan-none');
  }
  h.log('\n=== ГОТОВО, planSeen=' + planSeen + ' ===');
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
