// PROBE: запуск claude в 3 ПАРАЛЛЕЛЬНЫХ окнах (3 разных юзера). Изолирует РОВНО ту проблему —
// «2/3 не запускают claude». Без Ctrl+C (он под RU-раскладкой печатает «с»!). Адаптивно:
// bringToFront + стаггер запусков + проверка, что команда легла в строку + ретрай + ГЕЙТ alive.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { ensureTesters, TESTER1, TESTER2, TESTER3 } from './lib/users.mjs';
import { closePanels, closeSidebar } from './lib/ui.mjs';

const URL = 'http://localhost:5173';
const DIR = './shots/dbg';
mkdirSync(DIR, { recursive: true });
const COLW = 569;

async function probe({ idx, account, model, x, startDelay }) {
  let LOG = `\n=== окно${idx} ${account.username} (${model}) ===\n`;
  const log = (s) => { LOG += s + '\n'; };
  if (startDelay) await new Promise((r) => setTimeout(r, startDelay));
  const browser = await chromium.launch({ headless: false, slowMo: 40, args: [`--window-position=${x},0`, `--window-size=${COLW},960`, '--no-first-run'] });
  const ctx = await browser.newContext({ viewport: null });
  const p = await ctx.newPage();
  const sleep = (ms) => p.waitForTimeout(ms);
  const scr = () => p.evaluate(() => window.__nebScreen && window.__nebScreen('default'));
  const stOf = async () => (await scr())?.state || {};
  const xterm = async () => (await scr())?.xtermScreen || '';
  let alive = false;
  try {
    await p.goto(URL + '/login', { waitUntil: 'networkidle' });
    await p.fill('input[placeholder="Enter username"]', account.username);
    await p.fill('input[placeholder="Enter password"]', account.password);
    await p.click('button[type="submit"]'); await sleep(5000);
    await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
    await closeSidebar(p); await closePanels(p);
    await p.getByRole('button', { name: 'Терминал' }).last().click({ timeout: 4000 }).catch(() => {});
    await sleep(800); await closeSidebar(p);
    await p.locator('.xterm').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});

    const term = p.locator('.xterm-screen, .xterm').first();
    // АДАПТИВНЫЙ запуск: до 3 попыток, с bringToFront + проверкой строки + ГЕЙТом alive
    for (let attempt = 0; attempt < 3 && !alive; attempt++) {
      if ((await stOf()).alive) { alive = true; break; }
      await term.click({ timeout: 4000 }).catch(() => {});
      await sleep(400);
      await p.keyboard.type(`claude --model ${model}`, { delay: 35 });
      await sleep(500);
      const line = await xterm();
      if (!/claude --model/i.test(line)) { log(`  попытка ${attempt + 1}: команда НЕ легла в строку (фокус?) → Enter+ретрай`); await p.keyboard.press('Enter'); await sleep(900); continue; }
      log(`  попытка ${attempt + 1}: команда в строке ✓ → Enter`);
      await p.keyboard.press('Enter');
      for (let t0 = Date.now(); Date.now() - t0 < 22000;) {
        const s = await scr();
        if (/trust this folder|Yes, I trust|Do you trust/i.test(s?.xtermScreen || '')) { log('  trust → Enter'); await p.keyboard.press('Enter'); await sleep(1200); }
        if (s?.state?.alive) { alive = true; break; }
        await sleep(500);
      }
    }
    log(`  ИТОГ alive=${alive}`);
    log('  экран:\n  ' + (await xterm()).split('\n').filter((l) => l.trim()).slice(-6).join('\n  '));
    await p.screenshot({ path: `${DIR}/P${idx}-${account.username}-${alive ? 'OK' : 'FAIL'}.png` }).catch(() => {});
  } catch (e) { log('  FATAL: ' + e.message); }
  finally { await sleep(2000); await browser.close(); }
  return { idx, user: account.username, alive, log: LOG };
}

await ensureTesters();
const cfgs = [
  { idx: 1, account: TESTER1, model: 'opus', x: 0, startDelay: 0 },
  { idx: 2, account: TESTER2, model: 'sonnet', x: COLW, startDelay: 0 },
  { idx: 3, account: TESTER3, model: 'haiku', x: COLW * 2, startDelay: 0 },
];
const res = await Promise.all(cfgs.map(probe));
const okN = res.filter((r) => r.alive).length;
let out = `===== PROBE запуска claude: ${okN}/3 поднялись =====\n` + res.map((r) => `окно${r.idx} ${r.user}: alive=${r.alive}`).join('\n') + '\n' + res.map((r) => r.log).join('');
console.log(out);
writeFileSync(`${DIR}/parallel-start.log`, out);
