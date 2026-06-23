// ТЕСТ /resume-пикера: открыть claude → /resume → покадрово (1.5с) логировать сырой экран терминала
// + state.resumePicker + DOM-карточку. Когда пикер распарсился И карточка отрисовалась — клик по 2-й
// сессии, проверить навигацию. Лог → shots/resume/log.txt, кадры → shots/resume/NNN-*.png.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const MOBILE = !!process.env.MOBILE; // MOBILE=1 → узкий вьюпорт телефона (проверка скрейпа после форса PTY)
const DIR = MOBILE ? './shots/resume-mobile' : './shots/resume';
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const ctxOpts = MOBILE ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: null };
const p = await (await b.newContext(ctxOpts)).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude открыт: ' + o.instanceId + ' alive=' + o.alive + (MOBILE ? ' [МОБАЙЛ 390px]' : ''));
  await h.startRecording();

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
  // сигнатура окна списка (для сравнения до/после листания) — все видимые имена, не только первые.
  // claude прокручивает ОКНО, верх окна меняется не на каждый клик, поэтому сравниваем весь набор.
  const firstNames = (s, n = 3) => (s.resumePicker?.sessions || []).slice(0, n).map((x) => x.name.slice(0, 22));
  const winSig = (s) => (s.resumePicker?.sessions || []).map((x) => x.name.slice(0, 22) + '|' + x.meta).join('§');

  let pickerState = null;
  for (let i = 0; i < 22; i++) { // ~33с
    const s = await h.logFrame('resume-poll');
    const d = await h.dom();
    if (s.resumePicker && s.resumePicker.sessions.length > 0 && d.resumeCard) {
      h.log(`\n✓✓ ПИКЕР РАСПАРСИЛСЯ: ${s.resumePicker.sessions.length} сессий, выбрана #${s.resumePicker.selectedIndex}; DOM-карточка=${d.resumeCard}`);
      pickerState = s;
      break;
    }
    await sleep(1500);
  }

  let picked = false;
  let scrolledChanged = false;
  if (pickerState) {
    // (1) КАРТОЧКА появилась — фиксируем «N из Y» и держим кадр.
    h.setPhase('resume-card');
    const total = Math.max(pickerState.resumePicker.total, pickerState.resumePicker.sessions.length);
    h.log(`\n📋 КАРТОЧКА /resume: ${pickerState.resumePicker.sessions.length} из ${total}; первые: [${firstNames(pickerState).join(' | ')}]`);
    await h.snap('resume-card');
    await sleep(1500);
    await h.snap('resume-card-hold');

    // (2) ЛИСТАНИЕ ВНИЗ — «↓ старее». Жмём 5 раз (плавный 3-шаговый скролл) — видно прогрессию.
    let beforeSig = winSig(pickerState);
    for (let r = 0; r < 5; r++) {
      h.setPhase('scroll-down');
      h.log(`\n⬇ клик «↓ старее» (попытка ${r + 1}); верх: [${firstNames(pickerState).join(' | ')}]`);
      const dn = p.getByText('↓ старее').first();
      if (!(await dn.count())) { h.log('  ✗ кнопка «↓ старее» не найдена'); break; }
      await dn.click({ timeout: 3000 }).catch((e) => h.log('  клик не удался: ' + e.message));
      await sleep(2200);
      const s2 = await h.snap('after-scroll-down');
      pickerState = s2.resumePicker ? s2 : pickerState;
      const sig = winSig(s2);
      const changed = beforeSig !== sig;
      scrolledChanged = scrolledChanged || changed;
      h.log(`  верх стал: [${firstNames(s2).join(' | ')}] → окно ${changed ? 'ИЗМЕНИЛОСЬ ✓' : 'не изменилось'}`);
      beforeSig = sig;
      await sleep(800);
    }

    // (3) ЛИСТАНИЕ ВВЕРХ — «↑ новее». Жмём 4 раза, чтобы откат окна вверх был хорошо виден.
    for (let r = 0; r < 4; r++) {
      h.setPhase('scroll-up');
      h.log(`\n⬆ клик «↑ новее» (попытка ${r + 1}); верх: [${firstNames(pickerState).join(' | ')}]`);
      const up = p.getByText('↑ новее').first();
      if (!(await up.count())) { h.log('  ✗ кнопка «↑ новее» не найдена'); break; }
      await up.click({ timeout: 3000 }).catch((e) => h.log('  клик не удался: ' + e.message));
      await sleep(2200);
      const s3 = await h.snap('after-scroll-up');
      pickerState = s3.resumePicker ? s3 : pickerState;
      const sig = winSig(s3);
      const changed = beforeSig !== sig;
      scrolledChanged = scrolledChanged || changed;
      h.log(`  верх стал: [${firstNames(s3).join(' | ')}] → окно ${changed ? 'ИЗМЕНИЛОСЬ ✓' : 'не изменилось'}`);
      beforeSig = sig;
      await sleep(800);
    }
    await sleep(800);

    // (4) ВЫБОР сессии — наводим на конкретную, ДЕРЖИМ (видно подсветку), затем кликаем.
    h.setPhase('select');
    const sNow = await h.st();
    const sess = sNow.resumePicker?.sessions || pickerState.resumePicker.sessions;
    const target = Math.min(2, sess.length - 1); // 3-я сессия в текущем окне (или последняя)
    const name = sess[target].name.slice(0, 24);
    h.log(`\n🖱 ВЫБОР: навожу на сессию #${target} «${name}», держу, кликаю`);
    const hover = p.getByText(name, { exact: false }).first();
    if (await hover.count()) { await hover.hover().catch(() => {}); await sleep(1200); await h.snap('session-hover'); }
    const byName = p.getByText(name, { exact: false }).first();
    if (await byName.count()) {
      await byName.click({ timeout: 3000 }).catch((e) => h.log('  клик по имени не удался: ' + e.message));
      picked = true;
    } else {
      // фолбэк — кликнуть строку-сессию по индексу внутри карточки
      const cards = p.locator('div:has(> div > button:has-text("Отмена")) button').filter({ hasNotText: 'Отмена' }).filter({ hasNotText: 'Терминал' }).filter({ hasNotText: 'старее' }).filter({ hasNotText: 'новее' });
      if (await cards.count()) { await cards.nth(target).click({ timeout: 3000 }).catch(() => {}); picked = true; }
    }
    await h.snap('select-clicked');

    // ждём, пока claude возобновит: пикер исчезает, чат продолжается (busy / новый экран).
    h.setPhase('after-pick');
    for (let k = 0; k < 5; k++) {
      await sleep(1600);
      const sp = await h.snap('resumed-poll');
      const gone = !sp.resumePicker;
      h.log(`  [resumed-poll ${k}] resumePicker=${sp.resumePicker ? 'есть' : 'НЕТ'} busy=${sp.busy} alive=${sp.alive}`);
      if (gone) { h.log('  ✓ claude ВОЗОБНОВИЛ — пикер закрыт, чат продолжается'); break; }
    }
  } else {
    h.log('✗ пикер не появился или карточка не отрисовалась');
    await h.snap('resume-none');
  }

  h.setPhase('done');
  await sleep(800);
  await h.snap('final');
  h.log(`\n=== ГОТОВО: picked=${picked}, листание_меняло_список=${scrolledChanged} ===`);
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
