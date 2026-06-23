// ГЛУБОКАЯ ДИАГНОСТИКА детекта меню в ЧАТ-виде. Открывает claude через окно Chat, триггерит
// AskUserQuestion, и КАЖДЫЕ 2с дампит РЕАЛЬНЫЙ xtermScreen (грид) + rawTail + state, пока меню
// висит. Цель: увидеть, ЧТО видит детектор, когда permMenu=false busy=true → понять, почему
// scrapeMenu мажет (грид кривой? футер пропал? опции есть?). → shots/dbg/menu-dump.log
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow } from './lib/ui.mjs';
mkdirSync('./shots/dbg', { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; };

const b = await chromium.launch({ headless: false, slowMo: 40, args: ['--window-position=0,0', '--window-size=1100,960', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
let inst = 'default';
const dump = () => p.evaluate((id) => { const r = window.__nebScreen && window.__nebScreen(id); return { state: r?.state, xterm: r?.xtermScreen || '', raw: r?.rawTailTail || '' }; }, inst);
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]').first();

try {
  await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  const o = await openClaudeViaChatWindow(p); inst = o.instanceId;
  log('opened: ' + JSON.stringify(o));

  // CTX-ХОД как в tri-suite (ключ + ждём ответ) — РЕПЛИКА флоу, где вопрос таймаутит
  await box().click();
  await box().fill('Запомни кодовое слово этого чата: BRAVO-2. Повтори его в ответе и подтверди, что запомнил.');
  await box().press('Enter');
  log('ctx-ход отправлен (ключ), ждём 20с ответ claude…');
  await sleep(20000);
  log('grid после ctx (хвост 12):\n  ' + (await dump()).xterm.split('\n').filter((l) => l.trim()).slice(-12).join('\n  ') + '\n');

  await box().click();
  // ТОЧНЫЙ промпт tri-suite (чтобы воспроизвести именно его поведение)
  await box().fill('Прежде чем что-то делать, задай мне РОВНО 3 уточняющих вопроса по одному, КАЖДЫЙ с 3-4 вариантами на выбор (интерактивный выбор вариантов): 1) фреймворк, 2) стилизация, 3) сборщик.');
  await box().press('Enter');
  log('триггер вопроса отправлен, дампим грид каждые 2с (90с)…\n');

  let menuSeenInGrid = 0;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const d = await dump();
    const st = d.state || {};
    const xtail = d.xterm.split('\n').filter((l) => l.trim()).slice(-22).join('\n');
    // признаки меню в СЫРОМ гриде (не через scrapeMenu): опции 1./2., курсор ❯, футер
    const hasOptions = /^\s*[❯>]?\s*\d\.\s+\S/m.test(d.xterm);
    const hasCursor = /❯\s*\d\./.test(d.xterm);
    const hasFooter = /Enter to select|Tab to amend|Esc to cancel|Submit/.test(d.xterm);
    const hasQword = /фреймворк|стилизац|сборщик|React|Vue|Vite|использовать\?/i.test(d.xterm);
    if (hasOptions || hasFooter) menuSeenInGrid++;
    log(`[t=${(i + 1) * 2}s] state: busy=${st.busy} permMenu=${st.permMenu} kind=${st.permKind} opts=${(st.permOptions || []).length} TABS=${(st.permTabs || []).length}[${(st.permTabs || []).map((x) => x.label + (x.done ? '✔' : '')).join(',')}] || ГРИД: опции=${hasOptions} курсор=${hasCursor} футер=${hasFooter} q-слова=${hasQword}`);
    // ПОЛНЫЙ дамп грида при расхождении (грид показывает меню, а state — нет)
    if ((hasOptions || hasFooter) && !st.permMenu) {
      log('  ⚠ РАСХОЖДЕНИЕ: грид показывает меню, а state.permMenu=false! Грид (хвост 22):\n  ' + xtail.replace(/\n/g, '\n  '));
    }
    // периодический дамп грида (каждые 10с) — увидеть, рисует ли claude меню или пишет текст
    if (i % 5 === 4) log('  · грид@' + ((i + 1) * 2) + 'с (хвост 10):\n  ' + d.xterm.split('\n').filter((l) => l.trim()).slice(-10).join('\n  '));
    if (st.permMenu) { log('  ✓ state видит меню: ' + JSON.stringify((st.permOptions || []).map((o) => o.digit + '=' + o.label))); break; }
  }
  log('\n=== ИТОГ: меню в гриде видели ' + menuSeenInGrid + ' раз; state.permMenu сработал=' + ((await dump()).state?.permMenu) + ' ===');
  // финальный полный дамп грида
  const fin = await dump();
  log('\n=== ФИНАЛЬНЫЙ ГРИД (последние 30 строк) ===\n' + fin.xterm.split('\n').slice(-30).join('\n'));
  log('\n=== ФИНАЛЬНЫЙ rawTail (последние 1000) ===\n' + fin.raw.slice(-1000));
} catch (e) { log('FATAL: ' + e.message); }
finally { writeFileSync('./shots/dbg/menu-dump.log', LOG); console.log('--- лог → shots/dbg/menu-dump.log ---'); await sleep(1500); await b.close(); }
