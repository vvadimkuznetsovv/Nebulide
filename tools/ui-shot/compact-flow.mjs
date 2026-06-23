// ТЕСТ /compact (АДАПТИВНЫЙ, без спама): засеять контекст 2-3 объёмными ответами (КАЖДЫЙ дождаться
// до конца) → /compact → покадрово держать запись пока busy, ловить progress/sheen-бар → дождаться
// завершения компакта → задать ОДИН новый вопрос на сжатом контексте → дождаться ответа.
//
// ГЛАВНЫЙ УРОК прошлого прогона (см. shots/compact/log.txt): claude висел на
//   "✻ Waiting for API response · will retry in … · check your network"
// а тест слал следующие сообщения вслепую → они УШЛИ В ОЧЕРЕДЬ ("Press up to edit queued messages"),
// прогресс не пошёл, /compact встал за ними → спам и пустой результат. Поэтому:
//   • шлём ТОЛЬКО когда claude реально свободен (sendWhenIdle ждёт !busy && !permMenu && !resumePicker);
//   • завершение ответа = busy был true и СТАБИЛЬНО стал false (settle), а НЕ первый же false;
//   • если по пути permission/вопрос — кликаем разумный вариант (не шлём текст вслепую);
//   • "Waiting for API response / check your network" — НЕ ошибка фичи, просто ждём дольше, не спамим.
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';
import { makeHarness } from './lib/frames.mjs';

const DIR = './shots/compact';
const SCENARIO_MAX_MS = 360000; // общий бюджет сценария
const b = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const h = makeHarness(p, { dir: DIR });
const sleep = (ms) => p.waitForTimeout(ms);
const T0 = Date.now();
const budgetLeft = () => SCENARIO_MAX_MS - (Date.now() - T0);

// Клик по варианту меню (permission/вопрос) по тексту. Возвращает true, если кликнули.
const clickLabel = async (label) => {
  const byExact = p.getByText(label, { exact: true }).first();
  if (await byExact.count()) { await byExact.click({ timeout: 2500 }).catch(() => {}); return true; }
  const byFuzzy = p.getByText(label, { exact: false }).first();
  if (await byFuzzy.count()) { await byFuzzy.click({ timeout: 2500 }).catch(() => {}); return true; }
  return false;
};

// Разумно ответить на меню (permission/вопрос), НЕ открывая поле «расскажи Claude» и не шля текст.
// Предпочитаем «Yes»/«submit answers»/первый не-«type something» вариант. Возвращает label или null.
const answerMenu = async (s) => {
  const opts = s.permOptions || [];
  if (!opts.length) return null;
  const pick = opts.find((x) => /submit answers/i.test(x.label))
    || opts.find((x) => /^yes\b|^да\b|allow|accept/i.test(x.label) && !/don.?t|never/i.test(x.label))
    || opts.find((x) => !/type something|chat about|tell claude|no,|don.?t|cancel/i.test(x.label))
    || opts[0];
  h.log(`   [auto-answer] меню "${s.permQuestion || ''}" → клик "${pick.label}"`);
  await clickLabel(pick.label);
  return pick.label;
};

// Признак «застрял на сети» (НЕ ошибка фичи): живой статус про ожидание API / ретрай / network.
const isNetworkWait = (s) => /Waiting for API response|check your network|will retry|retrying/i.test(s.workStatus || '');

// Ждём, пока claude действительно СВОБОДЕН и готов принять сообщение.
// Свободен = alive && !busy && !permMenu && !resumePicker, и это держится settleMs (без флика).
// По пути: если открылось меню — отвечаем на него. Если сети нет — просто терпеливо ждём.
const waitIdle = async (maxMs, settleMs = 1500) => {
  const tEnd = Date.now() + Math.min(maxMs, budgetLeft());
  let stableSince = 0;
  while (Date.now() < tEnd) {
    const s = await h.st();
    if (!s.alive) { await sleep(1000); continue; }
    if (s.permMenu) { await answerMenu(s); stableSince = 0; await sleep(1800); continue; }
    if (s.resumePicker) { await h.box().press('Escape').catch(() => {}); stableSince = 0; await sleep(1200); continue; }
    if (s.busy) {
      if (isNetworkWait(s)) h.log(`   …сеть/ретрай: "${s.workStatus}" — терпеливо жду (не спамлю)`);
      stableSince = 0; await sleep(1500); continue;
    }
    // !busy — фиксируем момент и проверяем, что держится settleMs
    if (!stableSince) stableSince = Date.now();
    if (Date.now() - stableSince >= settleMs) return true;
    await sleep(400);
  }
  return false;
};

// Дождаться, пока claude НАЧНЁТ обрабатывать (busy=true) после отправки. Возвращает true/false.
const waitBusyStart = async (maxMs) => {
  const tEnd = Date.now() + Math.min(maxMs, budgetLeft());
  while (Date.now() < tEnd) {
    const s = await h.st();
    if (s.busy || s.permMenu) return true;
    await sleep(500);
  }
  return false;
};

// sendWhenIdle: ЕДИНСТВЕННАЯ точка отправки. Ждёт реальную готовность → шлёт ОДИН раз →
// ждёт начала обработки → ждёт завершения (busy стабильно спал). На меню по пути — отвечает.
// Не шлёт повторно. Возвращает {sent, started, done}.
const sendWhenIdle = async (text, maxMs = 90000) => {
  h.log(`\n▶ sendWhenIdle: ${JSON.stringify(text.slice(0, 60))}`);
  const tEnd = Date.now() + Math.min(maxMs, budgetLeft());
  const ready = await waitIdle(Math.min(40000, tEnd - Date.now()));
  if (!ready) { h.log('   ✗ claude так и не освободился — НЕ отправляю (избегаю очереди/спама)'); return { sent: false, started: false, done: false }; }

  await h.box().click(); await h.box().fill(text); await h.box().press('Enter');
  h.log('   отправлено ✓ (одно сообщение)');
  const started = await waitBusyStart(20000);
  if (!started) h.log('   ⚠ claude не показал busy за 20с (возможно мгновенный/короткий ответ)');

  // Ждём завершения — busy стабильно спал, по пути отвечаем на меню.
  const done = await waitIdle(tEnd - Date.now());
  const s = await h.st();
  h.log(`   итог отправки: started=${started || !!s.busy} done=${done} (busy=${s.busy})`);
  return { sent: true, started, done };
};

try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  if (!o.instanceId) throw new Error('claude не открылся');
  h.setInst(o.instanceId);
  h.log('✅ claude открыт: ' + o.instanceId + ' alive=' + o.alive);
  await h.startRecording();
  h.startFrames(1500);

  // ── 1. ЗАСЕВ КОНТЕКСТА: 3 объёмных запроса, КАЖДЫЙ дождаться до конца (без очереди). ──
  h.setPhase('seed');
  await h.snap('before-seed');
  const seeds = [
    'Напиши подробный рассказ про осенний лес: цвета, запахи, звуки, животные, грибы — на 15 предложений.',
    'Перечисли 20 фактов о грибах, каждый с пояснением в 2 предложения. Пронумеруй.',
    'Опиши 12 деревьев умеренного климата: как выглядит лист, кора, где растёт — по 2 предложения на каждое.',
  ];
  let seeded = 0;
  for (let i = 0; i < seeds.length; i++) {
    if (budgetLeft() < 90000) { h.log('⏳ бюджет на исходе — прекращаю засев'); break; }
    h.log(`\n=== ЗАСЕВ ${i + 1}/${seeds.length} ===`);
    const r = await sendWhenIdle(seeds[i], 110000);
    if (r.done) seeded++;
    await h.snap(`seed-${i + 1}-done`);
    h.log(`   засев ${i + 1}: sent=${r.sent} done=${r.done} (всего завершено=${seeded})`);
  }
  h.log(`\n✓ засев завершён: ${seeded}/${seeds.length} ответов реально получены`);

  // ── 2. /compact — следим покадрово за прогрессом, держим запись пока busy. ──
  h.setPhase('compact');
  // Перед /compact — убедимся, что claude свободен (иначе /compact уйдёт в очередь).
  const idleBeforeCompact = await waitIdle(40000);
  h.log(`\n=== /compact === (claude свободен перед отправкой: ${idleBeforeCompact})`);
  await h.snap('before-compact');
  await h.box().click(); await h.box().fill('/compact'); await h.box().press('Enter');
  h.log('▶ /compact отправлен');

  let sawProgress = false, sawBar = false, maxProgress = 0, compactStarted = false, compactDone = false;
  const compactEnd = Date.now() + Math.min(120000, budgetLeft());
  let stableIdle = 0;
  while (Date.now() < compactEnd) {
    const s = await h.logFrame('compact-poll');
    const d = await h.dom();
    if (s.busy) compactStarted = true;
    if (s.progress != null) {
      sawProgress = true;
      maxProgress = Math.max(maxProgress, s.progress);
      if (!sawBar && d.sheen) { sawBar = true; await h.snap('compact-bar'); h.log(`   ✓ ПОЯВИЛСЯ компакт-бар (.compact-progress-sheen), progress=${s.progress}`); }
    }
    if (isNetworkWait(s)) h.log(`   …сеть/ретрай во время компакта: "${s.workStatus}"`);
    // Завершение: компакт стартовал и busy стабильно спал (settle), либо в xterm видно «Compacted».
    const xt = await h.xterm(24);
    const xtDone = /compacted|compact summary|conversation compacted|сжат/i.test(xt);
    if (compactStarted && !s.busy) {
      if (!stableIdle) stableIdle = Date.now();
      if (Date.now() - stableIdle >= 2500 || xtDone) { compactDone = true; h.log(`   ✓ компакт ЗАВЕРШЁН (xtermDone=${xtDone}, maxProgress=${maxProgress})`); break; }
    } else { stableIdle = 0; }
    await sleep(1500);
  }
  h.setPhase('compact-done');
  await sleep(1200);
  await h.snap('compact-done');
  h.log(`\n=== КОМПАКТ: started=${compactStarted} done=${compactDone} progress=${sawProgress} bar=${sawBar} maxProgress=${maxProgress} ===`);

  // ── 3. ПРОДОЛЖЕНИЕ ЧАТА: один новый вопрос на сжатом контексте, дождаться ответа. ──
  h.setPhase('after-compact');
  let answered = false;
  if (budgetLeft() > 50000) {
    const r = await sendWhenIdle('Коротко: о чём мы говорили выше? Перечисли темы одним предложением.', Math.min(90000, budgetLeft()));
    answered = r.done;
    await h.snap('after-answer');
    // Если claude вернул что-то странное (всё ещё не свободен / ошибка) — зафиксируем сырой xterm.
    if (!answered) { const xt = await h.xterm(24); h.log('   ⚠ ответа не дождались. Сырой xterm:\n' + xt); }
    h.log(`   после компакта: sent=${r.sent} ОТВЕТИЛ=${answered}`);
  } else {
    h.log('⏳ бюджет исчерпан — пропускаю продолжение чата');
  }

  h.log(`\n=== ИТОГ: засеяно=${seeded}/${seeds.length}; компакт.прогресс=${sawProgress} (max=${maxProgress}%); бар=${sawBar}; компакт.завершён=${compactDone}; чат продолжился=${answered} ===`);
} catch (e) {
  h.log('FATAL: ' + e.message + '\n' + (e.stack || ''));
  await h.snap('fatal').catch(() => {});
} finally {
  await h.stopFrames();
  await h.saveRecording();
  await h.closeClaude();
  h.flush();
  await sleep(1000);
  await b.close();
}
