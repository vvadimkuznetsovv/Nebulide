// ОТЛАДКА: открыть claude → /resume → выгрузить ПОЛНЫЙ xtermScreen с номерами строк, чтобы увидеть
// где реально футер «Esc to cancel» относительно конца грида (почему scrapeResumePicker даёт null).
import { chromium } from 'playwright';
import { TESTER1 } from './lib/users.mjs';
import { openClaudeViaChatWindow, login } from './lib/ui.mjs';

const b = await chromium.launch({ headless: false, slowMo: 40, args: ['--window-size=1200,980', '--no-first-run'] });
const p = await (await b.newContext({ viewport: null })).newPage();
const sleep = (ms) => p.waitForTimeout(ms);
const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]').first();
try {
  await login(p, TESTER1, 'http://localhost:5173');
  const o = await openClaudeViaChatWindow(p);
  let inst = o.instanceId;
  console.log('claude:', inst, 'alive=', o.alive);
  await box().click(); await box().press('Escape'); await sleep(400);
  await box().fill('/resume'); await box().press('Enter');
  await sleep(6000);
  const dump = await p.evaluate((id) => {
    const r = window.__nebScreen(id);
    return { sessions: r?.sessions, xterm: r?.xtermScreen || '', state_rp: r?.state?.resumePicker || null };
  }, inst);
  const lines = dump.xterm.split('\n');
  console.log('ВСЕГО строк в гриде:', lines.length, '| state.resumePicker:', JSON.stringify(dump.state_rp));
  console.log('=== ПОЛНЫЙ ГРИД (номер: содержимое) ===');
  lines.forEach((l, i) => { const m = (l.length - i <= 0); console.log(String(i).padStart(3) + ': ' + JSON.stringify(l)); });
  // где футер?
  const fIdx = lines.findIndex((l) => /Esc to cancel/.test(l));
  console.log(`\n>>> Esc to cancel на строке ${fIdx} из ${lines.length} (от конца: ${lines.length - fIdx})`);
} catch (e) { console.log('FATAL', e.message); }
finally { await box().fill('/exit').catch(()=>{}); await box().press('Enter').catch(()=>{}); await sleep(2000); await b.close(); }
