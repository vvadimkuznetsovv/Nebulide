// Репро «мышление не отображается»: логин → запуск claude в терминале → режим Чат →
// отправка промпта → серия кадров во время ответа. Смотрим, есть ли индикатор «думает»/стоп.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = 'http://localhost:5173';
mkdirSync('./shots', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
const shot = (n) => page.screenshot({ path: `./shots/${n}.png` });

try {
  await page.goto(URL + '/login', { waitUntil: 'networkidle', timeout: 15000 });
  await page.fill('input[placeholder="Enter username"]', 'admin');
  await page.fill('input[placeholder="Enter password"]', 'admin12345');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  await page.addStyleTag({ content: '.lava-blob{display:none!important}' });

  // 1) запускаем claude в терминале (xterm ловит клавиатуру)
  await page.locator('.xterm-screen, .xterm').first().click();
  await page.keyboard.type('claude');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(12000);
  await shot('t1-claude-start');
  // чистим строку ввода claude (Ctrl+U) — на случай мусора; папка уже доверена, trust не ждём
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(2000);
  await shot('t2-ready');

  // 2) переключаемся в режим Чат (кнопка в шапке терминал-панели)
  const chatBtn = page.getByRole('button', { name: 'Чат' });
  await chatBtn.last().click({ timeout: 5000 }).catch(() => errs.push('no Чат button'));
  await page.waitForTimeout(3500);
  await shot('t3-chat-mode');

  // 3) отправляем промпт в чат
  const input = page.locator('textarea[placeholder*="Сообщение для Claude"]');
  await input.click({ timeout: 5000 });
  await input.fill('посчитай сколько будет 17 умножить на 23 и кратко объясни');
  await input.press('Enter');

  // 4) серия кадров во время ответа (ищем индикатор «думает»/стоп)
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1500);
    await shot(`t4-think-${i}`);
  }
} catch (e) {
  errs.push('FATAL: ' + e.message);
  await shot('t-error').catch(() => {});
}
console.log('ERRORS:', errs.slice(0, 12).join('\n  '));
await browser.close();
console.log('готово');
