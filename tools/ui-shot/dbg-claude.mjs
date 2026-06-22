// ДИАГНОСТИКА ЗАПУСКА CLAUDE (одно окно, tester1): покадрово показать, что РЕАЛЬНО происходит после
// `claude --model opus` — стартует ли claude, есть ли trust-промпт (и его точный текст), откуда «г»,
// и какой нужен АДАПТИВНЫЙ путь. Сначала ЧИСТИТ грязный терминал (Ctrl+C ×2 + Enter). → shots/dbg/claude.log.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { TESTER1 } from './lib/users.mjs';
import { closePanels, closeSidebar } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const DIR = './shots/dbg';
mkdirSync(DIR, { recursive: true });
let LOG = ''; const log = (s) => { LOG += s + '\n'; console.log(s); };

const browser = await chromium.launch({ headless: false, slowMo: 50, args: ['--window-position=0,0', '--window-size=720,960', '--no-first-run'] });
const ctx = await browser.newContext({ viewport: null });
const p = await ctx.newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
const stOf = async () => (await scr())?.state || {};
const xterm = async () => (await scr())?.xtermScreen || '';
const tail = (s, n = 12) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
let N = 0; const snap = async (l) => { N++; await p.screenshot({ path: `${DIR}/C${String(N).padStart(2, '0')}-${l}.png` }).catch(() => {}); };

try {
  await p.goto(URL + '/login', { waitUntil: 'networkidle' });
  await p.fill('input[placeholder="Enter username"]', TESTER1.username);
  await p.fill('input[placeholder="Enter password"]', TESTER1.password);
  await p.click('button[type="submit"]'); await sleep(5000);
  await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
  await closeSidebar(p);
  await closePanels(p);

  // переключиться в ТЕРМИНАЛ
  await p.getByRole('button', { name: 'Терминал' }).last().click({ timeout: 4000 }).catch(() => {});
  await sleep(800); await closeSidebar(p);
  await p.locator('.xterm').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
  const term = p.locator('.xterm-screen, .xterm').first();
  await term.click({ timeout: 4000 }).catch(() => {});
  await sleep(500);

  log('=== ЭКРАН ДО (что в терминале сейчас) ===');
  log(tail(await xterm(), 14));
  log('alive=' + (await stOf()).alive);
  await snap('before');

  // ЧИСТКА грязного состояния (вдруг остался ввод/мусор от прошлого прогона)
  log('\n=== ЧИСТКА: Ctrl+C ×2, Enter ===');
  await p.keyboard.press('Control+C'); await sleep(300);
  await p.keyboard.press('Control+C'); await sleep(300);
  await p.keyboard.press('Enter'); await sleep(800);
  log(tail(await xterm(), 8));
  await snap('after-clear');

  // если claude уже жив — выйти, чтобы чисто проверить старт
  if ((await stOf()).alive) { log('claude УЖЕ жив → /exit для чистого теста'); await p.keyboard.type('/exit'); await p.keyboard.press('Enter'); await sleep(2500); }

  // ТИП claude --model opus ПО СИМВОЛАМ (delay) — проверим, не появляется ли «г»
  log('\n=== ВВОД: claude --model opus (по символам, delay 40мс) ===');
  await term.click().catch(() => {}); await sleep(300);
  await p.keyboard.type('claude --model opus', { delay: 40 });
  await sleep(500);
  log('строка ввода ДО Enter (последние строки экрана):');
  log(tail(await xterm(), 6));
  await snap('typed');
  await p.keyboard.press('Enter');

  // ПОКАДРОВО 30с: что появляется
  log('\n=== ПОКАДРОВО после Enter (каждые 2с, 30с) ===');
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const x = await xterm(); const st = await stOf();
    const trust = /trust this folder|Yes, I trust|Do you trust/i.test(x);
    const err = /not recognized|command not found|error|Error|not found/i.test(tail(x, 6));
    log(`[t=${(i + 1) * 2}s] alive=${st.alive} busy=${st.busy} trust=${trust} err=${err}`);
    log('  ' + tail(x, 8).replace(/\n/g, '\n  '));
    if (trust) { log('  → TRUST обнаружен, жму Enter'); await p.keyboard.press('Enter'); }
    if (st.alive) { log('  → claude ЖИВ (alive=true)'); await snap('alive'); break; }
    if (i === 4) await snap('t10');
  }

  log('\n=== ИТОГ: alive=' + (await stOf()).alive + ' ===');
  await snap('final');
} catch (e) { log('FATAL: ' + e.message); }
finally { writeFileSync(`${DIR}/claude.log`, LOG); await sleep(1500); await browser.close(); console.log('--- лог → shots/dbg/claude.log ---'); }
