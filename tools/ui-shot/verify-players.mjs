// ПРОВЕРКА, что rrweb-плееры РЕАЛЬНО воспроизводятся при открытии (иначе пользователь не увидит
// результат). Открываем каждый shots/<test>/player.html как file://, ждём рендер плеера, жмём Play,
// скриним и проверяем DOM: есть ли .rr-player + iframe реплея с непустым содержимым.
import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { resolve } from 'path';

const tests = ['plan', 'compact', 'resume'];
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message));

const out = [];
for (const t of tests) {
  const file = resolve(`./shots/${t}/player.html`);
  if (!existsSync(file)) { out.push(`${t}: ✗ нет player.html`); continue; }
  errs.length = 0;
  try {
    await p.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    // Жмём Play и даём проиграть, чтобы увидеть прогресс.
    const playBtn = p.locator('#pp');
    if (await playBtn.count()) { await playBtn.click().catch(() => {}); }
    await p.waitForTimeout(3500);
    const info = await p.evaluate(() => {
      const iframe = document.querySelector('#app iframe');
      let innerNodes = 0, innerText = '';
      try {
        const doc = iframe && iframe.contentDocument;
        if (doc && doc.body) { innerNodes = doc.body.querySelectorAll('*').length; innerText = (doc.body.innerText || '').slice(0, 90); }
      } catch (e) { innerText = 'CROSS-ORIGIN: ' + e.message; }
      return {
        hasPlayer: !!document.querySelector('#pp'),
        hasIframe: !!iframe,
        eventsLen: (window.__events || []).length,
        innerNodes,
        innerText: innerText.replace(/\s+/g, ' ').trim(),
      };
    });
    await p.screenshot({ path: `./shots/${t}/PLAYER-render.png` });
    const ok = info.hasPlayer && info.hasIframe && info.innerNodes > 20;
    out.push(`${t}: ${ok ? '✓ ВОСПРОИЗВОДИТСЯ' : '✗ ПУСТО/СЛОМАНО'} | player=${info.hasPlayer} iframe=${info.hasIframe} events=${info.eventsLen} реплей-узлов=${info.innerNodes} текст="${info.innerText}"${errs.length ? ' | ОШИБКИ: ' + errs.slice(0, 3).join(' ; ') : ''}`);
  } catch (e) {
    out.push(`${t}: ✗ FATAL ${e.message}`);
  }
}
await b.close();
console.log('\n=== ПРОВЕРКА RRWEB-ПЛЕЕРОВ ===');
out.forEach((l) => console.log(l));
console.log('Скрины рендера: shots/<test>/PLAYER-render.png');
