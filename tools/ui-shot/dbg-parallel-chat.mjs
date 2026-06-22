// PROBE: ПАРАЛЛЕЛЬНОЕ открытие claude ЧЕРЕЗ ОКНО CHAT в 3 DESKTOP-окнах. Новый расклад:
//   окно1 = tester1 / workspace WS-A
//   окно2 = tester1 / workspace WS-B   (тот же аккаунт, ДРУГОЙ ws — уникальный claude-инстанс → нет коллизий/лока)
//   окно3 = tester2 / default          (другой аккаунт)
// Desktop-ширина (≥1024) → мультипанель надёжна (окно Chat реально находится). Каскад на 1707px.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { ensureTesters, ensureWorkspace, TESTER1, TESTER2 } from './lib/users.mjs';
import { openClaudeViaChatWindow } from './lib/ui.mjs';
mkdirSync('./shots/dbg', { recursive: true });

async function one({ idx, account, x, bootWsId, label }) {
  const browser = await chromium.launch({ headless: false, slowMo: 40, args: [`--window-position=${x},0`, '--window-size=1050,960', '--no-first-run'] });
  const ctx = await browser.newContext({ viewport: null });
  if (bootWsId) await ctx.addInitScript((id) => { try { localStorage.setItem('nebulide-active-workspace', id); } catch { /* */ } }, bootWsId);
  const p = await ctx.newPage();
  const sleep = (ms) => p.waitForTimeout(ms);
  let r = { instanceId: null, alive: false };
  try {
    await p.goto('http://localhost:5173/login', { waitUntil: 'networkidle' });
    await p.fill('input[placeholder="Enter username"]', account.username);
    await p.fill('input[placeholder="Enter password"]', account.password);
    await p.click('button[type="submit"]'); await sleep(5000);
    await p.addStyleTag({ content: '.lava-blob{display:none!important}' }).catch(() => {});
    r = await openClaudeViaChatWindow(p);
    await p.screenshot({ path: `./shots/dbg/PC${idx}-${label}-${r.alive ? 'OK' : 'FAIL'}.png` }).catch(() => {});
  } catch (e) { r.err = e.message; }
  finally { await sleep(1500); await browser.close(); }
  return { idx, label, user: account.username, ...r };
}

await ensureTesters();
const [wsA, wsB] = await Promise.all([ensureWorkspace(TESTER1, 'WS-A'), ensureWorkspace(TESTER1, 'WS-B')]);
const cfgs = [
  { idx: 1, account: TESTER1, x: 0, bootWsId: wsA, label: 'tester1-WSA' },
  { idx: 2, account: TESTER1, x: 328, bootWsId: wsB, label: 'tester1-WSB' },
  { idx: 3, account: TESTER2, x: 656, bootWsId: null, label: 'tester2' },
];
const res = await Promise.all(cfgs.map(one));
const okN = res.filter((r) => r.alive).length;
console.log(`\n===== PARALLEL открытие через окно Chat: ${okN}/3 =====`);
for (const r of res) console.log(`окно${r.idx} ${r.user}/${r.label}: alive=${r.alive} instanceId=${r.instanceId}${r.err ? ' ERR=' + r.err : ''}`);
