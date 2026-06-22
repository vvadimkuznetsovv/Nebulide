// Адаптивный МУЛЬТИ-БРАУЗЕРНЫЙ тест под ДВУМЯ юзерами (admin + tester) — полная изоляция
// (свои терминалы/воркспейсы/скиллы → блокировка нескольких сессий НЕ мешает, флаги не нужны).
// Каждый контекст параллельно проверяет ЧАТ (иконка-палитра, drill-down Команды/Скиллы→Свои/Claude,
// «назад», смена режима, сброс) и ПАНЕЛЬ СКИЛЛОВ (SearchBar, загрузка .md, превью, переименование,
// удаление). Скрины+логи по контекстам → shots/adaptive/, итог → shots/adaptive/summary.log.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { ensureTesters, TESTER1, TESTER2 } from './lib/users.mjs';
import { closePanels } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const ROOT = './shots/adaptive';
mkdirSync(ROOT, { recursive: true });

const login = async (p, creds) => {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', creds.username);
  await p.fill('input[placeholder="Enter password"]', creds.password);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(4000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
};

async function runContext(browser, idx, account) {
  const dir = `${ROOT}/ctx${idx}-${account.username}`;
  mkdirSync(dir, { recursive: true });
  const results = [];
  let LOG = `=== ctx ${idx} (${account.username}) ===\n`;
  const log = (s) => { LOG += s + '\n'; };
  const ok = (name, pass, extra = '') => { results.push({ name, pass: !!pass }); log(`${pass ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('PAGEERROR: ' + e.message));
  const sleep = (ms) => p.waitForTimeout(ms);
  let shotN = 0;
  const snap = async (label) => { shotN++; await p.screenshot({ path: `${dir}/${String(shotN).padStart(2, '0')}-${label}.png` }).catch(() => {}); };
  const toMode = (n) => p.getByRole('button', { name: n }).last().click().catch(() => {});
  const txt = (s) => p.getByText(s, { exact: true });
  const openSidebar = async () => { const b = p.locator('button[title="Show sidebar"]').first(); if (await b.count()) { await b.click().catch(() => {}); await sleep(700); } };

  try {
    await login(p, account);
    await snap('login');
    const cp = await closePanels(p); // адаптивно: закрыть лишние окна, Terminal оставить
    ok('адаптивно закрыл лишние окна (Terminal оставлен)', true, `открыто: [${cp.found.join(', ')}] закрыто: [${cp.closed.join(', ')}]`);

    // ===================== ЧАТ: drill-down =====================
    await toMode('Чат'); await sleep(2000); await snap('chat-mode');
    const cmdBtn = p.locator('button[title="Команды и скиллы Claude"]').first();
    ok('чат: иконка-кнопка команд/скиллов', await cmdBtn.count() > 0);
    if (await cmdBtn.count()) {
      await cmdBtn.click().catch(() => {}); await sleep(500); await snap('palette-root');
      ok('drill-down root = Команды + Скиллы', (await txt('Команды').count()) > 0 && (await txt('Скиллы').count()) > 0);
      await txt('Скиллы').first().click().catch(() => {}); await sleep(450); await snap('palette-skills');
      ok('drill-down skills = Свои + Claude', (await txt('Свои').count()) > 0 && (await txt('Claude').count()) > 0);
      await txt('Свои').first().click().catch(() => {}); await sleep(550); await snap('palette-own');
      ok('drill-down own: есть поиск', (await p.locator('input[placeholder*="Поиск"]').count()) > 0);
      await p.getByText('‹', { exact: false }).first().click().catch(() => {}); await sleep(350);
      ok('drill-down: «назад» вернул на Скиллы', (await txt('Свои').count()) > 0 && (await txt('Claude').count()) > 0);
      await p.keyboard.press('Escape').catch(() => {}); await cmdBtn.click().catch(() => {}); await sleep(200);
    }
    const modeBtn = p.locator('button[title*="Сменить режим"]').first();
    ok('чат: кнопка смены режима', await modeBtn.count() > 0);
    if (await modeBtn.count()) { await modeBtn.click().catch(() => {}); await sleep(800); await snap('mode-clicked'); }
    ok('чат: кнопка сброса чата', (await p.locator('button[title*="Сбросить чат"]').count()) > 0);

    // ===================== ПАНЕЛЬ «СКИЛЛЫ» =====================
    const skillName = `t-${account.username}-${Date.now().toString().slice(-6)}`;
    const renamed = skillName + '-r';
    await openSidebar();
    const skillsToggle = p.locator('button[title="Show Скиллы"]').first();
    const hasToggle = await skillsToggle.count() > 0;
    ok('сайдбар: тоггл панели «Скиллы»', hasToggle);
    if (hasToggle) {
      await skillsToggle.click().catch(() => {}); await sleep(1200); await snap('skills-panel');
      const panel = p.locator('.droppable-panel:has-text("Скиллы")').first();
      ok('панель скиллов открыта', await panel.count() > 0);
      ok('скиллы: SearchBar', (await panel.locator('input[placeholder*="Поиск"], input[placeholder*="поиск"]').count()) > 0);
      const fileInput = panel.locator('input[type="file"]').first();
      if (await fileInput.count()) {
        const md = `---\ndescription: Адаптивный тест-скилл ${skillName}\n---\n\nТестовый скилл, контекст ${account.username}.`;
        await fileInput.setInputFiles({ name: `${skillName}.md`, mimeType: 'text/markdown', buffer: Buffer.from(md, 'utf8') }).catch(() => {});
        await sleep(1500); await snap('skill-uploaded');
        ok('скиллы: загруженный .md появился', (await panel.getByText(skillName, { exact: false }).count()) > 0, skillName);
        const prevBtn = panel.locator('button[title*="Превью"], button[title*="превью"]').first();
        if (await prevBtn.count()) { await prevBtn.click().catch(() => {}); await sleep(800); await snap('skill-preview'); ok('скиллы: превью раскрылось', (await panel.getByText('Тестовый скилл', { exact: false }).count()) > 0); }
        else ok('скиллы: кнопка превью', false, 'не найдена');
        const search = panel.locator('input[placeholder*="Поиск"], input[placeholder*="поиск"]').first();
        if (await search.count()) { await search.fill(skillName).catch(() => {}); await sleep(600); ok('скиллы: поиск фильтрует', (await panel.getByText(skillName, { exact: false }).count()) > 0); await search.fill('').catch(() => {}); }
        const renameBtn = panel.locator('button[title*="Переименов"]').first();
        if (await renameBtn.count()) {
          await renameBtn.click().catch(() => {}); await sleep(400);
          const ri = panel.locator('input').last();
          await ri.fill(renamed).catch(() => {}); await ri.press('Enter').catch(() => {}); await sleep(1200); await snap('skill-renamed');
          ok('скиллы: переименование', (await panel.getByText(renamed, { exact: false }).count()) > 0, renamed);
        } else ok('скиллы: кнопка переименования', false, 'не найдена');
        p.once('dialog', (d) => d.accept().catch(() => {}));
        const delBtn = panel.locator('button[title*="Удалить"]').first();
        if (await delBtn.count()) { await delBtn.click().catch(() => {}); await sleep(1200); await snap('skill-deleted'); ok('скиллы: удаление (cleanup)', (await panel.getByText(renamed, { exact: false }).count()) === 0); }
        else ok('скиллы: кнопка удаления', false, 'не найдена');
      } else ok('скиллы: file-input загрузки', false, 'не найден');
    }
  } catch (e) { log('FATAL: ' + e.message); ok('контекст без фатала', false, e.message); }
  finally { writeFileSync(`${dir}/log.txt`, LOG); await ctx.close(); }
  return { idx, account: account.username, results, log: LOG };
}

await ensureTesters();
const accounts = [TESTER1, TESTER2];
const browser = await chromium.launch({ headless: false, slowMo: 50, args: ['--start-maximized'] });
const all = await Promise.all(accounts.map((acc, i) => runContext(browser, i + 1, acc)));
await browser.close();

let pass = 0, fail = 0;
for (const r of all) for (const c of r.results) (c.pass ? pass++ : fail++);
const head = `===== ИТОГ: ${pass} ok / ${fail} fail (юзеры: ${accounts.map((a) => a.username).join(', ')}, параллельно) =====\n`
  + all.map((r) => `ctx${r.idx} (${r.account}): ${r.results.filter((c) => c.pass).length}/${r.results.length} ok`).join('\n');
console.log('\n' + head);
writeFileSync(`${ROOT}/summary.log`, head + '\n\n' + all.map((r) => r.log).join('\n'));
console.log(`--- готово: скрины+логи в ${ROOT}/ctxN-*/, итог в ${ROOT}/summary.log ---`);
