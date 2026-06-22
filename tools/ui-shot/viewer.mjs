// Постоянный ВИДИМЫЙ вьювер Nebulide для живого наблюдения/работы.
// Профиль сохраняется в ./pw-profile → логин, доверие папок и ЗАКРЫТЫЕ ПАНЕЛИ персистятся
// (закрыл File Manager один раз — больше не появляется). Окно НЕ закрывается само.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173';
const ctx = await chromium.launchPersistentContext('./pw-profile', {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});
const p = ctx.pages()[0] || await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);

await p.goto(URL, { waitUntil: 'networkidle' });
// логин только если не залогинены (профиль помнит токены)
if (await p.locator('input[placeholder="Enter username"]').count()) {
  await p.fill('input[placeholder="Enter username"]', 'admin');
  await p.fill('input[placeholder="Enter password"]', 'admin12345');
  await p.click('button[type="submit"]');
  await sleep(4500);
}
await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});

// закрыть лишние панели ОДИН РАЗ (персистится в профиле)
async function closePanelByTitle(title) {
  for (let i = 0; i < 3; i++) {
    const btn = p.locator(`.droppable-panel:has-text("${title}") .panel-close-btn`).first();
    if (!(await btn.count())) break;
    await btn.click({ timeout: 3000 }).catch(() => {});
    await sleep(500);
  }
}
for (const t of ['File Manager', 'Preview', 'Editor']) await closePanelByTitle(t);

console.log('VIEWER READY — окно открыто и почищено. Запусти claude в терминале и пиши в Чат.');
// держим процесс живым, чтобы окно не закрылось
await new Promise(() => {});
