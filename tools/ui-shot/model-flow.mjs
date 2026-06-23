// ТЕСТ /model: открыть claude → /model → наблюдать, ловит ли скрейп меню выбора модели
// (permMenu/варианты) и рисует ли карточку → выбрать модель/отмена → rrweb-запись. Покадровый лог.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const DIR = './shots/model';
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude открыт: ' + o.instanceId);
  await h.startRecording();
  h.startFrames(1500);

  h.setPhase('model-send');
  await h.snap('before');
  await h.box().click(); await h.box().press('Escape'); await sleep(400);
  await h.box().fill('/model'); await h.box().press('Enter');
  h.log('▶ /model отправлен');

  // Наблюдаем 25с: появляется ли меню (permMenu/варианты) — карточка выбора модели.
  h.setPhase('model-wait');
  let menuSeen = false;
  for (let i = 0; i < 16; i++) {
    const s = await h.logFrame('model-poll');
    if (s.permMenu && (s.permOptions || []).length > 0) {
      menuSeen = true;
      h.log(`\n✓✓ МЕНЮ /model: kind=${s.permKind} вопрос="${s.permQuestion}" опции: ${(s.permOptions || []).map(x => x.digit + '=' + x.label).join(' | ')}`);
      await h.snap('model-menu');
      // держим карточку (видно), потом ОТМЕНА (Escape) — не меняем модель в тесте
      await sleep(2500);
      await h.snap('model-menu-hold');
      await h.box().press('Escape');
      h.log('   Escape — отмена выбора (модель не меняем)');
      await sleep(1500);
      await h.snap('after-cancel');
      break;
    }
    await sleep(1500);
  }
  if (!menuSeen) { h.log('✗ меню /model скрейпом НЕ поймано — нужен разбор сырого кадра (см. лог)'); await h.snap('model-none'); }

  h.setPhase('done');
  h.log('\n=== ГОТОВО, menuSeen=' + menuSeen + ' ===');
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
