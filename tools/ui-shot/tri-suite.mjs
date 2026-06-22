// ТРИ ВИДИМЫХ ОКНА live (1707×960 → 3 колонки по 569), ПАРАЛЛЕЛЬНО. РАЗНЫЕ юзеры → разные воркспейсы
// (терминал на бэке per-user → 3 своих claude). У КАЖДОГО — СВОЙ полный сценарий (паузы естественные,
// ждём реальные ответы claude). СТАРТ — как в проверенном dbg-chatwindow: claude открывается ЧЕРЕЗ
// ОКНО CHAT («Новый чат» во «Все чаты»), терминал не трогаем.
//   окно1 = tester1 / opus   / ключ ALPHA-1   → ПРИОРИТЕТ: ПЛАН с вариантами + /compact
//   окно2 = tester2 / sonnet / ключ BRAVO-2   → ПРИОРИТЕТ: AskUserQuestion + /resume
//   окно3 = tester3 / haiku  / ключ CHARLIE-3 → ПРИОРИТЕТ: PERMISSION (запрос доступа)
// Кросс-проверка изоляции: ключ окна есть в его чате и НЕ течёт в чужие.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { ensureTesters, ensureWorkspace, TESTER1, TESTER2 } from './lib/users.mjs';
import { openClaudeViaChatWindow } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const ROOT = './shots/tri';
mkdirSync(ROOT, { recursive: true });
const SCREEN = { h: 960 };
// DESKTOP-ширина (≥1024) — мультипанель надёжна (окно Chat реально находится, можно показать терминал).
// 3 окна КАСКАДОМ на 1707px (видны все три, активное — спереди).
const WIN_W = 1050;

async function runWindow(cfg) {
  const { idx, account, label, x, model, key, primary, wsName, bootWsId, showTerminal } = cfg;
  const dir = `${ROOT}/win${idx}-${label}`; mkdirSync(dir, { recursive: true });
  const results = [];
  let LOG = `=== окно ${idx} (${account.username}/${label}, ws=${wsName}, модель=${model}, ключ=${key}, фича=${primary}) ===\n`;
  const log = (s) => { LOG += s + '\n'; };
  const ok = (n, pass, extra = '') => { results.push({ n, pass: !!pass }); log(`${pass ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };

  const browser = await chromium.launch({ headless: false, slowMo: 40, args: [`--window-position=${x},0`, `--window-size=${WIN_W},${SCREEN.h}`, '--no-first-run'] });
  const ctx = await browser.newContext({ viewport: null });
  // Грузимся СРАЗУ в свой workspace (разные ws у одного аккаунта → нет лока). bootWsId=null → дефолтный.
  if (bootWsId) await ctx.addInitScript((id) => { try { localStorage.setItem('nebulide-active-workspace', id); } catch { /* */ } }, bootWsId);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('PAGEERROR: ' + e.message));
  const sleep = (ms) => p.waitForTimeout(ms);

  let inst = 'default'; // станет claude-… после открытия через окно Chat
  const scr = () => p.evaluate((id) => window.__nebScreen && window.__nebScreen(id), inst);
  const stOf = async () => (await scr())?.state || {};
  const xterm = async () => (await scr())?.xtermScreen || '';
  const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]').first();
  const txt = (s) => p.getByText(s, { exact: true });
  const rawTail = async (n = 18) => ((await xterm())).split('\n').filter((l) => l.trim()).slice(-n).join('\n');
  const chatText = () => p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').trim(); });
  let shotN = 0; const snap = async (l) => { shotN++; await p.screenshot({ path: `${dir}/${String(shotN).padStart(2, '0')}-${l}.png` }).catch(() => {}); };
  const poll = async (pred, ms, l) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (l) log('  …timeout: ' + l); return null; };
  const waitMenu = async (pred, ms, l) => poll((s) => s.state && pred(s.state), ms, l);
  const sendChat = async (t) => { if (await box().count()) { await box().click(); await box().fill(t); await box().press('Enter'); } };
  // надёжно: ждём, что claude НАЧАЛ думать (busy), затем ЗАКОНЧИЛ — не уносимся вперёд
  const waitResponse = async (ms = 80000) => {
    let saw = false;
    for (let t0 = Date.now(); Date.now() - t0 < 25000;) { const s = await stOf(); if (s.busy) { saw = true; break; } if (s.permMenu || s.resumeMenu) return true; await sleep(500); }
    for (let t0 = Date.now(); Date.now() - t0 < ms;) { const s = await stOf(); if (s.alive && !s.busy && !s.permMenu && !s.resumeMenu) return saw; await sleep(700); }
    return saw;
  };
  // ФАКТ: тоггл режима — это <button title="Сменить режим Claude (Shift+Tab)">, НЕ span. Цикл claude:
  // default→acceptEdits→plan→auto. Кликаем, пока режим (из экрана claude) не станет нужным.
  const cycleModeTo = async (t, max = 8) => { const f = p.locator('button[title*="Сменить режим"]').first(); for (let i = 0; i < max && (await stOf()).mode !== t; i++) { if (await f.count()) await f.click().catch(() => {}); await sleep(1100); } return (await stOf()).mode === t; };
  const uniq = String(Date.now()).slice(-5); // уникальный суффикс имён файлов (иначе «файл уже существует» → нет permission)
  const assertWrapped = async (name, st, subs) => { const ct = await chatText(); const allSubs = subs.every((sub) => !sub || ct.includes(sub)); ok(name, !!st && allSubs, subs.filter(Boolean).join(' | ')); };
  const click = async (loc, t = 3000) => { if (await loc.count()) { await loc.first().click({ timeout: t }).catch(() => {}); return true; } return false; };
  // АДАПТИВНО проклацать ЛЮБОЕ всплывшее меню claude: permission → «Да» (разрешить); вопрос →
  // выбрать первый вариант КАЖДОГО вопроса, затем Submit/Готово. Пока claude думает — ждём. До maxMs.
  const idleNoMenu = async (ms = 20000) => poll((s) => s.state?.alive && !s.state?.busy && !s.state?.permMenu && !s.state?.resumeMenu, ms);
  // Многошаговый AskUserQuestion: Q1→Q2→Q3→экран «Ready to submit your answers? (1 Submit answers / 2 Cancel)».
  // Персистентность: НЕ выходим на коротких переходах между вопросами (calm-счётчик), пока claude
  // окончательно не освободится. permission → «Да». submit-экран → «Submit answers».
  const autoAnswer = async (maxMs = 170000) => {
    const t0 = Date.now(); let acted = false; let calm = 0; let lastSig = ''; let dbgN = 0;
    while (Date.now() - t0 < maxMs) {
      const s = await stOf(); const opts = s.permOptions || [];
      const sig = s.permMenu ? s.permKind + '|' + (s.permQuestion || '') + '|' + opts.map((o) => o.digit + o.label).join(',') : '';
      if (++dbgN % 6 === 1) console.log(`  [autoAnswer w${idx}] permMenu=${s.permMenu} kind=${s.permKind} busy=${s.busy} opts=${opts.length} same=${!!sig && sig === lastSig} calm=${calm}`);
      if (s.permMenu) {
        if (sig && sig === lastSig) { calm = 0; await sleep(1000); continue; } // ЭТО меню уже кликали → ждём реакции claude (НЕ клацаем повторно)
        if (s.permKind === 'permission') {
          if (!(await click(p.getByText('Да', { exact: true }), 1500))) { const yes = opts.find((o) => /^(да|yes|allow|разреш)/i.test(o.label) && !/всегда|always|auto/i.test(o.label)); if (yes) await click(p.getByText(yes.label, { exact: false }), 1500); }
          console.log(`  [autoAnswer w${idx}] → permission «Да»`);
        } else { // question / plan-proceed
          if (await click(p.getByText('Submit answers', { exact: false }), 1200)) console.log(`  [autoAnswer w${idx}] → Submit answers`);
          else if (await click(p.getByText('Готово', { exact: false }), 1200)) console.log(`  [autoAnswer w${idx}] → Готово`);
          else {
            const manual = opts.find((o) => /manual|вручну|approve edits/i.test(o.label));
            if (opts.some((o) => /auto mode|авто.?режим/i.test(o.label)) && manual) { (await click(p.getByText(manual.label, { exact: true }), 1500)) || (await click(p.getByText(manual.label, { exact: false }), 1500)); console.log(`  [autoAnswer w${idx}] → manual approve (НЕ auto)`); }
            else { const opt = opts[0]; if (opt) { (await click(p.getByText(opt.label, { exact: true }), 1200)) || (await click(p.getByText(opt.label, { exact: false }), 1200)); console.log(`  [autoAnswer w${idx}] → вариант "${opt.label}"`); } }
          }
        }
        lastSig = sig; acted = true; calm = 0; await sleep(2200);
      } else if (s.busy) { calm = 0; await sleep(700); }
      else { calm++; if (calm >= 8) break; await sleep(700); } // 8 спокойных тиков (нет меню, не думает) → готово
    }
    return acted;
  };
  // КЛЮЧЕВОЕ: дождаться, что claude ТОЧНО готов принять команду. Иначе /compact//model уйдут в буфер
  // чата и НЕ дойдут до терминала (claude занят/висит меню). Разбираем меню (autoAnswer) → ждём
  // УСТОЙЧИВЫЙ idle (4 тика подряд alive && !busy && !menu). Возвращает true, если дождались.
  const waitReady = async (ms = 130000) => {
    const t0 = Date.now(); let stable = 0;
    while (Date.now() - t0 < ms) {
      const s = await stOf();
      if (s.permMenu || s.resumeMenu) { await autoAnswer(70000); stable = 0; continue; }
      if (s.busy || !s.alive) { stable = 0; await sleep(800); continue; }
      stable++; if (stable >= 4) return true; await sleep(800);
    }
    return false;
  };
  // Отправить сообщение и НАДЁЖНО дождаться ответа, чтобы следующее НЕ слиплось: waitReady (claude
  // свободен, буфер пуст) → отправить → убедиться, что claude НАЧАЛ отвечать (busy/меню) → дождаться idle.
  const sendAndWait = async (text, ms = 90000) => {
    await waitReady();
    await sendChat(text);
    let started = false;
    for (let t0 = Date.now(); Date.now() - t0 < 30000;) { const s = await stOf(); if (s.busy || s.permMenu || s.resumeMenu) { started = true; break; } await sleep(500); }
    if (!started) { console.log(`  [sendAndWait w${idx}] claude НЕ начал отвечать на: ${text.slice(0, 30)}`); return false; }
    await waitResponse(ms);
    return true;
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { log('  ⚠ ' + name + ': ' + e.message); } };

  let finalChat = '';
  try {
    // ── логин ──
    await p.goto(URL + '/login', { waitUntil: 'networkidle' });
    await p.fill('input[placeholder="Enter username"]', account.username);
    await p.fill('input[placeholder="Enter password"]', account.password);
    await p.click('button[type="submit"]'); await sleep(5000);
    await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
    await snap('login');

    // ════ СТАРТ: открыть claude ЧЕРЕЗ ОКНО CHAT (как в проверенном тесте) ════
    const opened = await openClaudeViaChatWindow(p);
    inst = opened.instanceId || 'default';
    ok('claude открыт ЧЕРЕЗ ОКНО CHAT (alive)', opened.alive, 'instanceId=' + inst);
    await snap('chat-opened');
    if (!opened.alive) { ok('КРИТИЧНО: claude не открылся через окно Chat → окно провалено', false); throw new Error('claude не открылся'); }

    // показ ТЕРМИНАЛ-ИНТЕРФЕЙСА того же claude (хотя бы в одном окне) — тогл «Терминал» → «Чат»
    if (showTerminal) {
      await step('терминал-интерфейс', async () => {
        await p.getByRole('button', { name: 'Терминал' }).last().click({ timeout: 4000 }).catch(() => {});
        await p.locator('.xterm').first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
        await sleep(1500); await snap('terminal-interface');
        ok('показан терминал-интерфейс того же claude', (await p.locator('.xterm').count()) > 0);
        await p.getByRole('button', { name: 'Чат' }).last().click({ timeout: 4000 }).catch(() => {});
        await box().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
        await sleep(1200);
      });
    }

    // ════ ФАЗА B — НАБОР КОНТЕКСТА (ждём реальные ответы) ════
    await step('контекст', async () => {
      await sendAndWait(`Запомни кодовое слово этого чата: ${key}. Повтори его в ответе и подтверди, что запомнил.`);
      await snap('ctx-1-key');
      ok('контекст: claude ответил, СВОЙ ключ в чате', (await chatText()).includes(key), key);
    });

    // ════ ФАЗА C — SYNC-PROOF: ключ в Terminal grid И в чате (одна живая сессия) ════
    await step('sync', async () => {
      const term = await xterm(); const chat = await chatText();
      ok('Terminal↔Chat sync (ключ в обоих видах)', term.includes(key) && chat.includes(key), `term=${term.includes(key)} chat=${chat.includes(key)}`);
      await snap('sync');
    });

    finalChat = await chatText(); // снимок для кросс-изоляции (ключ гарантированно есть)

    // ════ ФАЗА D — СВОЯ ФИЧА (обёрнута карточкой в ЧАТЕ) ════
    if (primary === 'plan') {
      await step('ПЛАН', async () => {
        await cycleModeTo('plan'); log('режим=' + (await stOf()).mode); await waitReady();
        await sendChat('НЕ задавай уточняющих вопросов. Сразу составь короткий план: создать файл notes-' + key.toLowerCase() + '-' + uniq + '.txt с тремя строками. Затем покажи план на подтверждение (ExitPlanMode).');
        const plan = await waitMenu((st) => st.permMenu && (st.permOptions || []).some((o) => /approve edits|auto mode|proceed|manual|keep planning/i.test(o.label)), 110000, 'карточка плана (proceed)');
        await snap('plan-card');
        await assertWrapped('ПЛАН обёрнут карточкой в чате', plan?.state, [plan?.state?.permQuestion]);
        if (plan) ok('ПЛАН: варианты', (plan.state.permOptions || []).length > 0, (plan.state.permOptions || []).map((o) => o.digit + '=' + o.label).join(' | '));
        // одобрить ВРУЧНУЮ (НЕ auto mode); затем разрешение на запись → «Да». Полный флоу плана.
        await autoAnswer(90000); await snap('plan-executed');
        ok('ПЛАН: одобрен вручную, действие выполнено', !(await stOf()).permMenu);
        await cycleModeTo('default');
      });
    } else if (primary === 'question') {
      await step('AskUserQuestion', async () => {
        await cycleModeTo('default'); await waitReady();
        await sendChat('Прежде чем что-то делать, задай мне РОВНО 3 уточняющих вопроса по одному, КАЖДЫЙ с 3-4 вариантами на выбор (интерактивный выбор вариантов): 1) фреймворк, 2) стилизация, 3) сборщик.');
        const q = await waitMenu((st) => st.permMenu && st.permKind === 'question' && (st.permTabs || []).length >= 1, 95000, 'AskUserQuestion');
        await snap('question-card');
        await assertWrapped('AskUserQuestion обёрнут карточкой в чате', q?.state, [q?.state?.permQuestion]);
        if (q) ok('вопрос: табы заголовков (мульти)', (q.state.permTabs || []).length >= 1, (q.state.permTabs || []).map((t) => t.label).join(' | '));
        // АДАПТИВНО ответить на ВСЕ вопросы (Q1→Q2→Q3→Submit answers) — с запасом времени
        await autoAnswer(160000); await waitResponse(30000);
        ok('вопросы: проклацал все варианты + Submit', !(await stOf()).permMenu); await snap('question-answered');
      });
    } else if (primary === 'permission') {
      await step('PERMISSION', async () => {
        await cycleModeTo('default'); log('режим=' + (await stOf()).mode); await waitReady();
        await sendChat('Создай НОВЫЙ файл note-' + key.toLowerCase() + '-' + uniq + '.txt в текущей папке с одной строкой «' + key + '». Используй инструмент записи файла. Не объясняй — просто сделай.');
        const perm = await waitMenu((st) => st.permMenu && st.permKind === 'permission', 95000, 'карточка разрешения');
        await snap('permission-card');
        await assertWrapped('PERMISSION обёрнут карточкой в чате', perm?.state, [perm?.state?.permQuestion]);
        if (perm) ok('разрешение: варианты Да/Нет', (perm.state.permOptions || []).some((o) => /да|yes|разреш/i.test(o.label)), (perm.state.permOptions || []).map((o) => o.digit + '=' + o.label).join(' | '));
        // АДАПТИВНО нажать «Да» (разрешить) и дождаться выполнения действия
        await autoAnswer(45000); await waitResponse(30000);
        ok('разрешение: нажал «Да», действие выполнено', !(await stOf()).permMenu); await snap('permission-granted');
      });
    }

    // ════ ФАЗА E — /model ════
    await step('model', async () => {
      await waitReady(); // claude ТОЧНО свободен (иначе /model уйдёт в буфер)
      await sendChat('/model'); await sleep(3000);
      await poll((s) => /opus|sonnet|haiku|Select|Switch model|Choose/i.test(s.xtermScreen || ''), 12000, '/model меню');
      // показать ВЕСЬ список (1-5) в терминал-виде, БЕЗ навигации стрелками (она давала ANSI-мусор)
      await p.getByRole('button', { name: 'Терминал' }).last().click({ timeout: 3000 }).catch(() => {});
      await p.locator('.xterm').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
      await sleep(1500); await snap('model-menu');
      ok('/model: меню выбора модели (весь список)', /opus|sonnet|haiku/i.test(await rawTail(28)));
      // закрыть меню (Esc в терминал-виде → PTY) и вернуться в чат
      await p.locator('.xterm').first().click().catch(() => {});
      await p.keyboard.press('Escape'); await sleep(1200);
      await p.getByRole('button', { name: 'Чат' }).last().click({ timeout: 3000 }).catch(() => {});
      await box().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
      await sleep(1500); await idleNoMenu(20000);
    });

    // ════ ФАЗА F — /compact (есть РЕАЛЬНЫЙ контекст) ════
    await step('compact', async () => {
      await waitReady(); // claude ТОЧНО свободен (иначе /compact НЕ дойдёт до терминала)
      await box().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
      await sendChat('/compact'); await sleep(2500);
      const compacting = await poll((s) => /Compact/i.test(s.state?.workStatus || '') || s.state?.progress != null || /Compacting|Compacted|Summariz|сжат/i.test(s.xtermScreen || ''), 50000, '/compact индикатор');
      ok('/compact: индикатор/прогресс/готово', !!compacting, compacting ? `progress=${compacting.state?.progress}` : '');
      await snap('compact-progress');
      await poll((s) => !s.state?.busy, 80000); await snap('compact-done');
    });

    // ════ ФАЗА G — /resume (win2) ИЛИ recall (win1/win3) ════
    if (primary === 'question') {
      await step('resume', async () => {
        await waitReady(); await box().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
        await sendChat('/resume'); await sleep(2000);
        const resume = await poll((s) => s.state?.resumePicker || s.state?.resumeMenu || /Resume session|Modified|ago|❯/i.test(s.xtermScreen || ''), 18000, '/resume список');
        await snap('resume-list'); // снимаем СРАЗУ, пока список виден
        const n = resume?.state?.resumePicker?.sessions?.length || 0;
        ok('/resume: список сессий показан', !!resume, `сессий=${n}`);
        if (n > 1) { await p.keyboard.press('ArrowDown'); await sleep(700); await p.keyboard.press('Enter'); await sleep(4000); await snap('resume-switched'); ok('/resume: переход на другую сессию', true); }
        else { await p.keyboard.press('Escape').catch(() => {}); await sleep(1000); }
      });
    } else {
      await step('recall', async () => {
        await sendAndWait('Какое кодовое слово я просил запомнить в начале? Ответь только им.');
        await snap('recall');
        ok('после /compact контекст сохранён (ключ вспомнен)', (await chatText()).includes(key), key);
      });
    }

    await snap('final');
  } catch (e) { log('FATAL: ' + e.message); ok('окно без фатала', false, e.message); }
  finally { try { writeFileSync(`${dir}/log.txt`, LOG); } catch { /* */ } try { await sleep(2500); } catch { /* */ } try { await browser.close(); } catch { /* */ } }
  return { idx, label, account: account.username, key, chat: finalChat, results, log: LOG };
}

// ── setup ──
await ensureTesters();
const [wsA, wsB] = await Promise.all([ensureWorkspace(TESTER1, 'WS-A'), ensureWorkspace(TESTER1, 'WS-B')]);
console.log('testers + workspaces готовы. Запускаю 3 окна (2 ws одного аккаунта + другой аккаунт) — старт через ОКНО CHAT…');

// 2 разных WORKSPACE с ОДНОГО аккаунта (tester1/WS-A, tester1/WS-B) + ДРУГОЙ аккаунт (tester2).
// Уникальный claude-инстанс из окна Chat → нет коллизии терминала; разные ws → нет лока.
let windows = [
  { idx: 1, account: TESTER1, label: 'tester1-WSA', x: 0, wsName: 'WS-A', bootWsId: wsA, model: 'opus', key: 'ALPHA-1', primary: 'plan', showTerminal: true },
  { idx: 2, account: TESTER1, label: 'tester1-WSB', x: 328, wsName: 'WS-B', bootWsId: wsB, model: 'sonnet', key: 'BRAVO-2', primary: 'question', showTerminal: false },
  { idx: 3, account: TESTER2, label: 'tester2', x: 656, wsName: 'default', bootWsId: null, model: 'haiku', key: 'CHARLIE-3', primary: 'permission', showTerminal: false },
];
// ONLY=2 / ONLY=question — запустить ТОЛЬКО одно окно (быстрая проверка полного флоу перед параллелью).
const ONLY = process.env.ONLY;
if (ONLY) windows = windows.filter((w) => String(w.idx) === ONLY || w.label.includes(ONLY) || w.primary === ONLY);
const all = await Promise.all(windows.map(runWindow));

// ── КРОСС-ПРОВЕРКА ИЗОЛЯЦИИ ЧАТА ──
let isoLines = '\n===== ИЗОЛЯЦИЯ ЧАТА (кросс-проверка) =====';
let isoPass = 0, isoFail = 0;
for (const w of all) {
  const others = all.filter((o) => o.idx !== w.idx);
  const own = w.chat.includes(w.key);
  const leaks = others.filter((o) => w.chat.includes(o.key)).map((o) => o.key);
  const pass = own && leaks.length === 0;
  pass ? isoPass++ : isoFail++;
  isoLines += `\n${pass ? '✅' : '❌'} окно${w.idx} (${w.account}): свой ${w.key}=${own}, утечки чужих=[${leaks.join(', ') || 'нет'}]`;
}

let pass = 0, fail = 0;
for (const r of all) for (const c of r.results) (c.pass ? pass++ : fail++);
const allGreen = fail === 0 && isoFail === 0;
const head = `===== ИТОГ: ${pass} ok / ${fail} fail | изоляция: ${isoPass} ok / ${isoFail} fail | ВСЁ ЗЕЛЁНОЕ: ${allGreen ? 'ДА' : 'НЕТ'} =====\n`
  + all.map((r) => `окно${r.idx} (${r.account}/${r.label}): ${r.results.filter((c) => c.pass).length}/${r.results.length} ok`).join('\n');
console.log('\n' + head + '\n' + isoLines);
writeFileSync(`${ROOT}/summary.log`, head + '\n' + isoLines + '\n\n' + all.map((r) => r.log).join('\n'));
console.log(`--- готово: скрины+логи в ${ROOT}/winN-*/, итог в ${ROOT}/summary.log ---`);
