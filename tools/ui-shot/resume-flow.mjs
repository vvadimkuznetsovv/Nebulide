// ТЕСТ /resume-пикера: открыть claude → /resume → покадрово (1.5с) логировать сырой экран терминала
// + state.resumePicker + DOM-карточку. Когда пикер распарсился И карточка отрисовалась — клик по 2-й
// сессии, проверить навигацию. Лог → shots/resume/log.txt, кадры → shots/resume/NNN-*.png.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const DIR = './shots/resume';
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude открыт: ' + o.instanceId + ' alive=' + o.alive);

  h.startFrames(1500);
  h.setPhase('open');
  await h.snap('opened');

  // Отправляем /resume в чат-композер (уходит в PTY как команда claude). ВАЖНО: сперва Escape +
  // очистка, чтобы не засорить поиск пикина остатками прошлой сессии (иначе сессии фильтруются в 0).
  h.setPhase('resume-send');
  await h.box().click();
  await h.box().press('Escape');
  await sleep(400);
  await h.box().fill('');
  await h.box().fill('/resume');
  await h.box().press('Enter');
  h.log('▶ отправлен /resume');

  h.setPhase('resume-wait');
  let picked = false;
  for (let i = 0; i < 22; i++) { // ~33с
    const s = await h.logFrame('resume-poll');
    const d = await h.dom();
    if (s.resumePicker && s.resumePicker.sessions.length > 0) {
      h.log(`\n✓✓ ПИКЕР РАСПАРСИЛСЯ: ${s.resumePicker.sessions.length} сессий, выбрана #${s.resumePicker.selectedIndex}; DOM-карточка=${d.resumeCard}`);
      await h.snap('resume-card');
      if (d.resumeCard) {
        // Клик по 2-й сессии (или 1-й, если всего одна) — проверяем навигацию.
        const target = Math.min(1, s.resumePicker.sessions.length - 1);
        const btns = p.locator('button:has-text("сессий")').first(); // якорь карточки
        await btns.scrollIntoViewIfNeeded().catch(() => {});
        const cards = p.locator('div:has(> button:has-text("⌨ Терминал")) button').filter({ hasNotText: 'Отмена' }).filter({ hasNotText: 'Терминал' });
        h.log(`  кликаю сессию #${target}`);
        // надёжнее — по тексту имени сессии
        const name = s.resumePicker.sessions[target].name.slice(0, 24);
        const byName = p.getByText(name, { exact: false }).first();
        if (await byName.count()) await byName.click({ timeout: 2500 }).catch(() => {});
        else if (await cards.count()) await cards.nth(target).click({ timeout: 2500 }).catch(() => {});
        picked = true;
        await sleep(1500);
        h.setPhase('after-pick');
        await h.snap('after-pick');
      }
      break;
    }
    await sleep(1500);
  }
  if (!picked) { h.log('✗ пикер не появился или карточка не отрисовалась'); await h.snap('resume-none'); }

  h.setPhase('done');
  await h.snap('final');
  h.log('\n=== ГОТОВО, picked=' + picked + ' ===');
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
