// Общие адаптивные UI-хелперы для Playwright-тестов Nebulide.

// АДАПТИВНОЕ закрытие лишних окон. Анализирует РЕАЛЬНО открытые панели по ИХ НАЗВАНИЮ и закрывает
// только те, что НЕ в keep. По умолчанию keep=['Terminal'] — Terminal нужен (чат-вью над ним), его
// НИКОГДА не трогаем. Перечитывает DOM после каждого закрытия (раскладка меняется). Возвращает
// {found:[названия всех открытых], closed:[что закрыли]} — чтобы тест «видел названия окон».
export const closePanels = async (p, keep = ['Terminal']) => {
  const titleOf = async (panel) => ((await panel.locator('.panel-drag-title, .panel-tab-title').first().innerText().catch(() => '')) || '').trim();
  const found = new Set(); const closed = [];
  for (let pass = 0; pass < 8; pass++) {
    const panels = p.locator('.droppable-panel');
    const n = await panels.count();
    let didClose = false;
    for (let i = 0; i < n; i++) {
      const panel = panels.nth(i);
      const t = await titleOf(panel);
      if (t) found.add(t);
      if (!t || keep.some((k) => t.includes(k))) continue; // нужное окно (Terminal и т.п.) — не трогаем
      const btn = panel.locator('.panel-close-btn').first();
      if (await btn.count()) { await btn.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(300); closed.push(t); didClose = true; break; }
    }
    if (!didClose) break; // больше нечего закрывать
  }
  return { found: [...found], closed };
};

// Открыть сайдбар (если кнопка показа есть).
export const openSidebar = async (p) => {
  const b = p.locator('button[title="Show sidebar"]').first();
  if (await b.count()) { await b.click().catch(() => {}); await p.waitForTimeout(700); }
};

// Открыт ли сайдбар (мобильная раскладка): по ЖИВОМУ backdrop. ФАКТ (dbg-layout): при 569px окне
// innerWidth≈555 → мобиль; сайдбар = оверлей с backdrop `.fixed.inset-0.z-40.lg:hidden`. Их ДВА:
// один 0×0 (мёртвый), другой 555×866 (живой). Открыт ⇔ есть backdrop с width>10.
export const sidebarOpen = async (p) => {
  const bds = p.locator('.fixed.inset-0.z-40');
  const n = await bds.count();
  for (let i = 0; i < n; i++) { const b = await bds.nth(i).boundingBox().catch(() => null); if (b && b.width > 10) return true; }
  return false;
};

// НАДЁЖНО закрыть сайдбар. Главное: кликать ЖИВОЙ backdrop (по bbox, не `.first()` — он бывает 0×0!)
// мышью в его ПРАВУЮ часть (вне сайдбара, иначе клик попадёт ПОД сам сайдбар). Фолбэк: кнопка X
// (aria-label="Close sidebar") и Escape. Возвращает true, если закрыт. До 5 попыток.
export const closeSidebar = async (p) => {
  for (let i = 0; i < 5 && (await sidebarOpen(p)); i++) {
    const bds = p.locator('.fixed.inset-0.z-40');
    const n = await bds.count();
    let done = false;
    for (let j = 0; j < n; j++) {
      const b = await bds.nth(j).boundingBox().catch(() => null);
      if (b && b.width > 10) { await p.mouse.click(b.x + b.width - 18, b.y + b.height / 2).catch(() => {}); done = true; break; }
    }
    if (!done) {
      const x = p.locator('button[aria-label="Close sidebar"]:visible').first();
      if (await x.count()) await x.click({ timeout: 1500 }).catch(() => {});
      else await p.keyboard.press('Escape').catch(() => {});
    }
    await p.waitForTimeout(500);
  }
  return !(await sidebarOpen(p));
};

// ОТКРЫТЬ claude ЧЕРЕЗ ОКНО CHAT (панель «Claude Sessions»), НЕ трогая терминал. Проверенный поток
// (dbg-chatwindow): сайдбар → Show Chat → закрыть лишние панели (оставить окно Chat) → «Открывать
// как: Чат» → ВО «ВСЕ ЧАТЫ» жмём «Новый чат» (без перехода в «Чаты общения») → находим новый
// instanceId (claude-…) → ждём alive (с trust) → сбрасываем trust-gate кнопкой «Чат». Возвращает
// { instanceId, alive }. Команда запуска на бэке — простой `cd "X"; claude` (исправлено под PowerShell).
export const openClaudeViaChatWindow = async (p, { timeoutMs = 45000 } = {}) => {
  const sleep = (ms) => p.waitForTimeout(ms);
  const sessionsOf = () => p.evaluate(() => (window.__nebScreen && window.__nebScreen().sessions) || []);
  const stById = (id) => p.evaluate((i) => window.__nebScreen && window.__nebScreen(i), id);
  const chatPanelLoc = () => p.locator('.droppable-panel:has-text("Claude Sessions")').first();

  // 1. ОТКРЫТЬ окно Chat — РЕТРАЙ, пока панель «Claude Sessions» реально не появится (под параллелью
  //    клик мог не зайти). ГАРД: НЕ чистим панели, пока окно Chat не подтверждено (иначе снесём ВСЁ).
  //    МОБАЙЛ: Workspace рендерит ДВА сайдбара — desktop `hidden lg:block` + mobile-оверлей `lg:hidden`.
  //    Оба содержат кнопку «Show Chat», но desktop-копия скрыта (display:none) → клик по `.first()`
  //    падает «element is not visible». Поэтому ВЕЗДЕ берём `:visible`. На мобиле сайдбар-оверлей уже
  //    открыт сразу после логина (кнопки «Show sidebar» нет) — нужно лишь кликнуть видимый тоггл chat.
  let chatOpen = (await chatPanelLoc().count()) > 0;
  for (let attempt = 0; attempt < 5 && !chatOpen; attempt++) {
    // Сайдбар: на десктопе раскрываем по «Show sidebar»; на мобиле он уже открыт оверлеем.
    const showSb = p.locator('button[title="Show sidebar"]:visible').first();
    if (await showSb.count()) { await showSb.click().catch(() => {}); await sleep(700); }
    // Тоггл показа панели Chat — строго ВИДИМЫЙ (иначе попадём в скрытый desktop-сайдбар на мобиле).
    const showChat = p.locator('button[title="Show Chat"]:visible').first();
    if (await showChat.count()) { await showChat.click().catch(() => {}); await sleep(1300); }
    if (await sidebarOpen(p)) await closeSidebar(p);
    await sleep(700);
    chatOpen = (await chatPanelLoc().count()) > 0;
  }
  if (!chatOpen) return { instanceId: null, alive: false };

  // 2. закрыть ЛИШНИЕ панели (старый терминал и пр.), ОСТАВИТЬ окно Chat (теперь оно точно открыто)
  await closePanels(p, ['Chat']);
  const chatPanel = chatPanelLoc();
  // 3. «Открывать как: Чат»
  const asChat = chatPanel.getByText('Чат', { exact: true }).first();
  if (await asChat.count()) { await asChat.click().catch(() => {}); await sleep(400); }

  // 4. ВО «ВСЕ ЧАТЫ» (по умолчанию) — «Новый чат». РЕТРАЙ + детект нового instanceId.
  let instanceId = null;
  for (let attempt = 0; attempt < 3 && !instanceId; attempt++) {
    const before = await sessionsOf();
    const newBtn = chatPanel.getByText('Новый чат', { exact: false }).first();
    if (await newBtn.count()) await newBtn.click().catch(() => {});
    for (let t0 = Date.now(); Date.now() - t0 < 8000 && !instanceId;) {
      const now = await sessionsOf();
      instanceId = now.find((id) => !before.includes(id) && /claude-/.test(id)) || null;
      if (!instanceId) await sleep(500);
    }
  }
  if (!instanceId) { const now = await sessionsOf(); instanceId = now.find((id) => /claude-/.test(id)) || null; }
  if (!instanceId) return { instanceId: null, alive: false };

  // 5. ждём alive (обрабатываем trust новой папки)
  let alive = false;
  for (let t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
    const s = await stById(instanceId);
    if (/trust this folder|Yes, I trust|Do you trust/i.test(s?.xtermScreen || '')) { await p.keyboard.press('Enter'); await sleep(1200); }
    if (s?.state?.alive) { alive = true; break; }
    await sleep(600);
  }

  // 6. сбросить trust-gate (новая папка показывает сырой терминал) → красивый чат с полем ввода
  await p.getByRole('button', { name: 'Чат' }).last().click({ timeout: 4000 }).catch(() => {});
  await sleep(1200);

  // 7. ЗАКРЫТЬ окно Chat — оставить ТОЛЬКО новый claude-чат на весь экран (в 569px иначе тесно).
  //    Окно Chat = панель "Chat"; claude-чат = "Terminal-N" → keep ['Terminal'] закроет окно Chat.
  await closePanels(p, ['Terminal']);
  await sleep(800);

  return { instanceId, alive };
};

// Логин на /login.
export const login = async (p, creds, url = 'http://localhost:5173') => {
  await p.goto(url + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', creds.username);
  await p.fill('input[placeholder="Enter password"]', creds.password);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(4500);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
};
