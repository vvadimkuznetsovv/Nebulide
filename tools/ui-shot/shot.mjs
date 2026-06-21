// Playwright: логинится в локальный Nebulide и снимает скриншоты UI → PNG (их читает Claude).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = process.env.URL || 'http://localhost:5173';
const USER = process.env.NEB_USER || 'admin';
const PASS = process.env.NEB_PASS || 'admin12345';
mkdirSync('./shots', { recursive: true });
const shot = (p, n) => p.screenshot({ path: `./shots/${n}.png` });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

try {
  await page.goto(URL + '/login', { waitUntil: 'networkidle', timeout: 15000 });
  await shot(page, '1-login');
  await page.fill('input[placeholder="Enter username"]', USER);
  await page.fill('input[placeholder="Enter password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  console.log('URL после логина:', page.url());
  // Прячем декоративные блобы (в headless нет backdrop-filter → они «сырые» и мешают видеть UI).
  if (process.env.HIDE_BLOBS !== '0') await page.addStyleTag({ content: '.lava-blob{display:none!important}' });
  await page.waitForTimeout(500);
  await shot(page, '2-workspace');
} catch (e) {
  console.error('ОШИБКА:', e.message);
  await shot(page, 'error').catch(() => {});
}
if (errs.length) console.error('CONSOLE ERRORS:\n' + errs.slice(0, 15).join('\n'));
await browser.close();
console.log('готово, скриншоты в ./shots/');
