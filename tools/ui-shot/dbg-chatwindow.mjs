// PROBE: открыть claude ЧЕРЕЗ ОКНО CHAT (панель «Claude Sessions», сайдбар → Show Chat).
// Поток: Show Chat → «Открывать как: Чат» → вкладка «Чаты общения» → «Новый чат общения» →
// найти НОВЫЙ instanceId (claude-…) → дождаться alive. Терминал НЕ трогаем.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { closeSidebar, sidebarOpen, closePanels } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const DIR = './shots/dbg';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };

const browser = await chromium.launch({ headless: false, slowMo: 60, args: ['--window-position=0,0', '--window-size=1280,960', '--no-first-run'] });
const ctx = await browser.newContext({ viewport: null });
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const sessionsOf = () => p.evaluate(() => (window.__nebScreen && window.__nebScreen().sessions) || []);
const stById = (id) => p.evaluate((i) => window.__nebScreen && window.__nebScreen(i), id);
let N = 0; const snap = async (l) => { N++; await p.screenshot({ path: `${DIR}/W${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});

  const iw = await p.evaluate(() => window.innerWidth);
  log('innerWidth=' + iw + ' (desktop если ≥1024)');

  // открыть ОКНО CHAT через сайдбар
  const showSidebar = p.locator('button[title="Show sidebar"]').first();
  if (await showSidebar.count()) { await showSidebar.click().catch(() => {}); await sleep(700); }
  // ДАМП кнопок сайдбара (анализ сайдбара)
  const sbBtns = await p.evaluate(() => [...document.querySelectorAll('button[title]')].map((b) => b.title).filter((t) => /Show|Hide/.test(t)));
  log('кнопки панелей в сайдбаре: [' + sbBtns.join(', ') + ']');
  const showChat = p.locator('button[title="Show Chat"]').first();
  log('кнопка "Show Chat": ' + (await showChat.count()));
  if (await showChat.count()) { await showChat.click().catch(() => {}); await sleep(1500); }
  if (await sidebarOpen(p)) await closeSidebar(p);
  await sleep(800);

  // ждём появления панели «Claude Sessions»
  let chatPanel = p.locator('.droppable-panel:has-text("Claude Sessions")').first();
  for (let t0 = Date.now(); Date.now() - t0 < 6000 && !(await chatPanel.count()); ) { await sleep(500); chatPanel = p.locator('.droppable-panel:has-text("Claude Sessions")').first(); }
  log('панель «Claude Sessions» открыта: ' + (await chatPanel.count()));
  await snap('chat-window');

  // АДАПТИВНО: закрыть НЕНУЖНЫЕ панели (старый Terminal-1 с мусором, File Manager), оставить окно Chat.
  const cp = await closePanels(p, ['Chat']);
  log('закрыл лишние (оставил окно Chat): открыто=[' + cp.found.join(', ') + '] закрыто=[' + cp.closed.join(', ') + ']');
  await snap('cleaned');

  // «Открывать как: Чат»
  const asChat = chatPanel.getByText('Чат', { exact: true }).first();
  if (await asChat.count()) { await asChat.click().catch(() => {}); await sleep(400); log('режим открытия = Чат'); }

  // ОСТАЁМСЯ во «Все чаты» (НЕ переходим в «Чаты общения»)
  await snap('all-chats');

  // НОВЫЙ ЧАТ прямо во «Все чаты»
  const before = await sessionsOf();
  log('сессии ДО: [' + before.join(', ') + ']');
  const newChat = chatPanel.getByText('Новый чат', { exact: false }).first();
  log('кнопка «Новый чат» (Все чаты): ' + (await newChat.count()));
  if (await newChat.count()) { await newChat.click().catch(() => {}); }
  await sleep(2500); await snap('new-chat-clicked');

  // найти новый instanceId claude-…
  let newId = null;
  for (let t0 = Date.now(); Date.now() - t0 < 12000;) {
    const now = await sessionsOf();
    newId = now.find((id) => !before.includes(id) && /claude-/.test(id)) || now.find((id) => /claude-/.test(id));
    if (newId) break; await sleep(500);
  }
  log('НОВЫЙ instanceId: ' + newId);

  // дождаться alive (с обработкой trust)
  let alive = false;
  if (newId) {
    for (let t0 = Date.now(); Date.now() - t0 < 40000;) {
      const s = await stById(newId);
      if (/trust this folder|Yes, I trust|Do you trust/i.test(s?.xtermScreen || '')) { log('trust → Enter'); await p.keyboard.press('Enter'); await sleep(1200); }
      if (s?.state?.alive) { alive = true; break; }
      await sleep(700);
    }
  }
  log('alive нового инстанса: ' + alive);
  await sleep(3000); await snap('after');

  // РАБОТАЕМ В НУЖНОМ: новая папка → claude показал trust, чат показывает СЫРОЙ терминал.
  // Сбрасываем trust-gate кнопкой «Чат» (dropTrustGate) → появляется текстовое поле чата.
  await p.getByRole('button', { name: 'Чат' }).last().click({ timeout: 4000 }).catch(() => {});
  await sleep(1500); await snap('chat-view');

  const chatText = () => p.evaluate(() => { const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]'); const pn = ta?.closest('.droppable-panel') || document.body; return (pn.innerText || '').trim(); });
  let answered = false;
  if (alive) {
    const box = p.locator('textarea[placeholder*="Сообщение для Claude"]').first();
    log('текстовое поле чата найдено: ' + (await box.count()));
    if (await box.count()) {
      const beforeLen = (await chatText()).length;
      await box.click(); await box.fill('Сколько будет 2+2? Ответь только числом.'); await box.press('Enter');
      log('отправил вопрос, жду пока claude ПОДУМАЕТ и ОТВЕТИТ…');
      // 1. ждём, пока claude НАЧАЛ думать (busy=true)
      let sawBusy = false;
      for (let t0 = Date.now(); Date.now() - t0 < 25000;) { const s = await stById(newId); if (s?.state?.busy) { sawBusy = true; break; } await sleep(500); }
      log('claude начал думать (busy): ' + sawBusy);
      // 2. ждём ЗАВЕРШЕНИЯ ответа (busy → false)
      for (let t0 = Date.now(); Date.now() - t0 < 70000;) { const s = await stById(newId); if (s?.state?.alive && !s.state?.busy) break; await sleep(700); }
      await sleep(2500);
      // 3. реальный ответ: лента выросла И содержит «4» (его НЕТ в моём вопросе)
      const after = await chatText();
      const grew = after.length - beforeLen;
      const hasAnswer = /(^|[^\d])4([^\d]|$)|четыре/i.test(after);
      answered = sawBusy && hasAnswer; // claude думал И ответ «4» появился (его нет в вопросе)
      log(`лента выросла на ${grew}, ответ «4» есть: ${hasAnswer}`);
    }
  }
  log('claude РЕАЛЬНО ответил: ' + answered);
  await snap('answered');
  log('\n=== ИТОГ: claude открыт+отвечает ЧЕРЕЗ ОКНО CHAT = ' + (alive && answered) + ' (instanceId=' + newId + ') ===');
} catch (e) { log('FATAL: ' + e.message); }
finally { writeFileSync(`${DIR}/chatwindow.log`, LOG); await sleep(2000); await browser.close(); console.log('--- лог → shots/dbg/chatwindow.log ---'); }
