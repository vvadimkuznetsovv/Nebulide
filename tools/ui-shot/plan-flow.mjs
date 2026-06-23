// ТЕСТ ПЛАНА: plan-режим → запрос плана → дождаться карточки плана (permIsPlan) → проверить крупный
// markdown-рендер (.plan-md) → ДЕРЖАТЬ 8с (видно) → клик «Tell Claude what to change» → проверить, что
// нижнее поле ВЫДВИНУЛОСЬ (footerH>0 И фокус в TEXTAREA) → напечатать ответ → отправить. Покадровый лог.
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

  h.startFrames(2000);
  h.setPhase('plan-mode');
  const okMode = await cycleModeTo('plan');
  h.log('режим plan выставлен: ' + okMode + ' (mode=' + (await st()).mode + ')');

  // Запрос плана без уточняющих вопросов.
  h.setPhase('plan-send');
  await h.box().click();
  await h.box().fill('НЕ задавай уточняющих вопросов, исходи из разумных дефолтов. Составь подробный план с заголовками (##) и нумерованными пунктами: что нужно сделать, чтобы добавить на index.html кнопку-счётчик кликов с сохранением в localStorage. Когда план готов — предложи его на подтверждение через ExitPlanMode.');
  await h.box().press('Enter');
  h.log('▶ запрос плана отправлен');

  // Ждём карточку плана; по пути адаптивно отвечаем на вопросы.
  h.setPhase('plan-wait');
  let planSeen = false, lastSig = '';
  for (let i = 0; i < 90; i++) { // ~135с
    const s = await h.logFrame('plan-poll');
    if (s.permMenu && s.permIsPlan) {
      planSeen = true;
      const d = await h.dom();
      h.log(`\n✓✓ КАРТОЧКА ПЛАНА: вопрос="${s.permQuestion}" | опции: ${(s.permOptions || []).map((x) => x.digit + '=' + x.label).join(' | ')}`);
      h.log(`   DOM .plan-md: fontSize=${d.planMd} теги=[${(d.planTags || []).join(',')}]`);
      h.setPhase('plan-card');
      await h.snap('PLAN-CARD');
      // ДЕРЖИМ карточку 8с (видно).
      h.setPhase('plan-hold');
      for (let k = 0; k < 4; k++) { await sleep(2000); h.log(`   …держу ${(k + 1) * 2}/8с`); }
      // «Tell Claude what to change» → поле ввода должно ВЫДВИНУТЬСЯ.
      h.setPhase('tell-claude');
      const before = await h.dom();
      const clicked = await clickLabel('Tell Claude what to change');
      await sleep(1200);
      const after = await h.dom();
      const opened = after.active === 'TEXTAREA' && (after.taH || 0) >= (before.taH || 0);
      h.log(`   «Tell Claude» клик=${clicked} → active=${after.active} taH=${before.taH}→${after.taH} ⇒ поле ${opened ? '✓ ВЫДВИНУЛОСЬ' : '✗ НЕ выдвинулось'}`);
      await h.snap('after-tell-claude');
      // Печатаем ответ в открывшееся поле и отправляем.
      h.setPhase('typed');
      await h.box().fill('Добавь в план ещё кнопку сброса счётчика в ноль и подтверждение перед сбросом.');
      await sleep(700);
      const typed = await p.evaluate(() => document.querySelector('textarea[placeholder*="Сообщение для Claude"]')?.value || '');
      h.log('   напечатано в поле: ' + JSON.stringify(typed.slice(0, 60)));
      await h.snap('typed-in-field');
      await h.box().press('Enter');
      await sleep(2500);
      h.setPhase('after-send');
      const sAfter = await h.logFrame('after-send');
      h.log('   после отправки: busy=' + sAfter.busy + ' (claude принял текст)');
      await h.snap('after-send');
      break;
    }
    // Вопросы по пути — отвечаем.
    if (s.permMenu && !s.permIsPlan) {
      const opts = s.permOptions || [];
      const sig = (s.permQuestion || '') + opts.map((x) => x.digit).join('');
      if (sig !== lastSig) {
        lastSig = sig;
        if (opts.some((x) => /submit answers/i.test(x.label))) await clickLabel('Submit answers');
        else { const opt = opts.find((x) => !/type something|chat about|tell claude/i.test(x.label)) || opts[0]; h.log('   [auto] вопрос → ' + opt?.label); await clickLabel(opt.label); }
        await sleep(1800);
      }
    }
    await sleep(1500);
  }
  if (!planSeen) { h.log('✗ карточка плана не появилась'); await h.snap('plan-none'); }
  h.log('\n=== ГОТОВО, planSeen=' + planSeen + ' ===');
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
