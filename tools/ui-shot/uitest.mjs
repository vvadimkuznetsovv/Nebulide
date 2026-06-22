// СКВОЗНОЙ ИНТЕРФЕЙС-ТЕСТ Nebulide в ВИДИМОМ окне (headed, развёрнуто). Принципы «нормального» теста:
//  • КАЖДОЕ сообщение отправляется РОВНО ОДИН раз (никаких переотправок → нет дублей в чате).
//  • На важных состояниях (мышление, план, permission) — ПАУЗА + скриншот, чтобы реально увидеть.
//  • Меню закрываются ЧИСТО (через настоящий терминал + Esc), режим возвращается в default.
//  • Браузер ВСЕГДА закрывается (try/finally).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const R = [];
const ok = (n, pass, extra = '') => { R.push({ n, pass }); console.log(`${pass ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };

const b = await chromium.launch({ headless: false, slowMo: 150, args: ['--start-maximized'] });
const ctx = await b.newContext({ viewport: null });
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const state = async () => (await scr())?.state || {};
const term = () => p.locator('.xterm-screen, .xterm').first();
const input = () => p.locator('textarea[placeholder*="Сообщение для Claude"]');
const shot = (n) => p.screenshot({ path: `./shots/${n}.png` }).catch(() => {});
async function poll(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scr(); if (s && pred(s)) return s; await sleep(400); } if (label) console.log('  …timeout:', label); return null; }
const chatText = () => p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').replace(/\s+/g, ' ').trim(); });

const toMode = async (name) => name === 'Терминал' ? p.getByRole('button', { name: 'Терминал' }).last().click().catch(() => {}) : p.getByRole('button', { name: 'Чат' }).last().click().catch(() => {});
async function send(text) { await input().click(); await input().fill(text); await input().press('Enter'); } // РОВНО один раз
// чистое закрытие любого меню claude: уходим в терминал, шлём Esc, возвращаемся в чат
async function cancelViaTerminal() {
  await toMode('Терминал'); await sleep(700); await term().click();
  await p.keyboard.press('Escape'); await sleep(900);
  await toMode('Чат'); await sleep(1000);
}
async function cycleModeTo(target, max = 5) {
  const footer = p.locator('span[title*="Сменить режим"]').first();
  for (let i = 0; i < max && (await state()).mode !== target; i++) { if (await footer.count()) await footer.click().catch(() => {}); await sleep(900); }
  return (await state()).mode === target;
}

try {
  // ── login + чистый макет ──
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', 'admin');
  await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]'); await sleep(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  for (const t of ['File Manager', 'Preview', 'Editor']) {
    for (let i = 0; i < 3; i++) { const x = p.locator(`.droppable-panel:has-text("${t}") .panel-close-btn`).first(); if (!(await x.count())) break; await x.click({ timeout: 3000 }).catch(() => {}); await sleep(400); }
  }

  // ── чистый старт claude ──
  await toMode('Терминал'); await sleep(900); await term().click();
  await p.keyboard.press('Control+C'); await sleep(250); await p.keyboard.press('Control+C'); await sleep(500); await p.keyboard.press('Enter'); await sleep(700);
  await p.keyboard.type('claude'); await p.keyboard.press('Enter');
  const tr = await poll((s) => /trust this folder|Yes, I trust/i.test(s.xtermScreen || ''), 20000);
  if (tr) { await p.keyboard.press('Enter'); await sleep(1500); }
  const ready = await poll((s) => (s.state && s.state.alive) || /for agents|for shortcuts/i.test(s.xtermScreen || ''), 22000, 'ready');
  ok('1. claude запустился (alive)', !!ready?.state?.alive);
  await toMode('Чат'); await sleep(2500);

  // ── 2. мышление + позиция индикатора + стоп-кнопка (длинный промпт, ПАУЗА чтобы видеть) ──
  await send('Напиши развёрнутый рассказ про космонавта на 400 слов, не меньше');
  const busy = await poll((s) => s.state?.busy === true, 25000, 'busy');
  ok('2. claude думает (busy)', !!busy, busy?.state?.workStatus?.slice(0, 36));
  await sleep(2000);
  const ui = await p.evaluate(() => {
    const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]');
    const composer = ta?.closest('div')?.parentElement; // блок composer
    const pulse = document.querySelector('.claude-chat-pulse');
    const stop = document.querySelector('button[title*="Остановить"]');
    let pulseAboveInput = false;
    if (pulse && ta) { const pr = pulse.getBoundingClientRect(), tr = ta.getBoundingClientRect(); pulseAboveInput = pr.top < tr.top && (tr.top - pr.bottom) < 120; }
    return { pulse: !!pulse, stop: !!stop, pulseAboveInput };
  });
  ok('3. индикатор «мышление» виден', ui.pulse);
  ok('4. индикатор «мышление» ПРЯМО НАД полем ввода (не висит в ленте)', ui.pulseAboveInput);
  ok('5. кнопка ОТМЕНЫ (стоп) видна во время работы', ui.stop);
  await shot('s2-thinking');

  // ── 6. стоп реально останавливает claude ──
  const stopBtn = p.locator('button[title*="Остановить"]').first();
  let stopped = false;
  if (await stopBtn.count()) { await stopBtn.click().catch(() => {}); stopped = !!await poll((s) => s.state?.busy === false, 12000, 'stop→idle'); }
  ok('6. кнопка отмены останавливает claude', stopped);
  await sleep(1500);

  // ── 7. детерминированный ответ рендерится в ленте (ОДНА отправка) ──
  const MARK = 'НЕБУЛИД-' + Math.floor(Math.random() * 900 + 100);
  await send(`Ответь РОВНО одним словом: ${MARK}`);
  await poll((s) => s.state?.busy === true, 15000);
  await poll((s) => s.state?.busy === false && s.state?.alive, 40000, 'idle');
  let answer = '';
  for (let i = 0; i < 25; i++) { answer = await chatText(); if (answer.includes(MARK)) break; await sleep(1000); }
  ok('7. ответ claude отрендерился в ленте чата', answer.includes(MARK), answer.slice(-70));
  // нет дублей моего вопроса в ленте
  const dupCount = (answer.match(new RegExp(MARK, 'g')) || []).length;
  ok('8. нет дублирования сообщений в чате', dupCount <= 2, `вхождений MARK=${dupCount}`);
  await shot('s7-answer');

  // ── 9. контекст из statusLine (пилюля в тулбаре — ищем по всей странице) + 10. нет сырого XML ──
  const ctxShown = await p.evaluate(() => /\d+%\s*·|\d+\s*%/.test(document.body.innerText || ''));
  ok('9. контекст из statusLine показывается', ctxShown);
  ok('10. нет сырого <command-name>/<local-command-caveat> в чате', !/<command-name>|<local-command-caveat>|local-command-stdout/.test(await chatText()));

  // ── 11. permission-меню (DEFAULT режим) — карточка с кнопками, ПАУЗА чтобы видеть ──
  await send('выполни в bash ровно эту команду: echo nebulide-проверка-доступа');
  const perm = await poll((s) => s.state?.permMenu, 20000, 'perm');
  ok('11. permission-меню распознано (карточка доступа)', !!perm, perm ? (perm.state.permOptions || []).map(o => o.digit + '=' + o.label).join(', ') : 'claude не спросил (pre-approved)');
  await shot('s11-permission');
  await sleep(3500); // ПАУЗА — видно карточку
  if (perm) await cancelViaTerminal();

  // ── 12. ПЛАН: режим plan → claude строит план → карточка плана с кнопками, ПАУЗА ──
  const inPlan = await cycleModeTo('plan');
  let planMenu = null;
  if (inPlan) { await send('создай файл hello.txt с текстом привет внутри рабочей папки'); planMenu = await poll((s) => s.state?.permMenu, 60000, 'plan'); }
  ok('12. план-меню (ExitPlanMode) распознано', !!planMenu, planMenu ? `кнопок: ${(planMenu.state.permOptions || []).length}` : (inPlan ? 'claude не дошёл до плана' : 'не вошёл в plan'));
  if (planMenu) {
    const planText = await chatText();
    ok('13. текст плана показан в карточке', /план|шаг|hello\.txt|proceed/i.test(planText));
  } else ok('13. текст плана показан в карточке', false, 'нет меню плана');
  await shot('s12-plan');
  await sleep(4500); // ПАУЗА — видно весь план + кнопки
  await cancelViaTerminal();

  // ── 14. режим возвращён в default ──
  const backDefault = await cycleModeTo('default');
  ok('14. режим возвращён в DEFAULT (не оставлен auto/plan)', backDefault, `mode=${(await state()).mode}`);
  await sleep(1000);

} catch (e) {
  console.log('ОШИБКА теста:', e.message);
} finally {
  console.log(`\n=== ИТОГ: ${R.filter(r => r.pass).length}/${R.length} ===`);
  R.filter(r => !r.pass).forEach(r => console.log('  ❌ ' + r.n));
  await b.close();
  console.log('браузер закрыт.');
}
