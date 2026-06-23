// Общий харнесс для покадровых адаптивных тестов фич чат-обёртки (план / compact / resume).
// Даёт: фоновый frame-grabber (скрин раз в N мс, помечен текущей ФАЗОЙ), logFrame (в лог пишет
// и состояние ИНТЕРФЕЙСА — __nebScreen().state + DOM-проверки, и сырой вывод ТЕРМИНАЛА — xtermScreen),
// snap (скрин + logFrame), и closeClaude (шлёт /exit, чтобы НЕ плодить orphan-claude).
import { mkdirSync, writeFileSync } from 'fs';

const pad = (n) => String(n).padStart(3, '0');

// makeHarness(page, { dir }) → набор хелперов. inst задаётся через setInst(instanceId) ПОСЛЕ открытия claude.
export function makeHarness(p, { dir }) {
  mkdirSync(dir, { recursive: true });
  let inst = 'default';
  let phase = 'init';
  let fN = 0;
  let LOG = '';
  let framesOn = false;
  let framePromise = null;
  const t0 = Date.now();

  const setInst = (id) => { inst = id || 'default'; };
  const setPhase = (name) => { phase = name; };

  const log = (s) => { LOG += s + '\n'; console.log(s); };

  // __nebScreen(inst) с авто-резолвом: если сессии по inst нет (вернулся {error,sessions}),
  // переключаемся на первый живой claude-* инстанс из списка (id мог смениться при реконсиле).
  const probe = async () => {
    let r = await p.evaluate((id) => window.__nebScreen && window.__nebScreen(id), inst);
    if (r && r.error && Array.isArray(r.sessions)) {
      const alt = r.sessions.find((s) => /claude-/.test(s)) || r.sessions.find((s) => s !== 'default') || r.sessions[0];
      if (alt && alt !== inst) { inst = alt; r = await p.evaluate((id) => window.__nebScreen && window.__nebScreen(id), inst); }
    }
    return r || {};
  };
  // Состояние ИНТЕРФЕЙСА (то, что видит чат-вью).
  const st = async () => (await probe())?.state || {};
  // Сырой вывод ТЕРМИНАЛА claude (ровный xterm-грид) — последние n непустых строк.
  const xterm = async (n = 16) => {
    const raw = await p.evaluate((id) => (window.__nebScreen && window.__nebScreen(id)?.xtermScreen) || '', inst);
    return raw.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
  };
  // Снимок ИНТЕРФЕЙСА из DOM — отрисовались ли наши карточки/бар и где фокус.
  const dom = async () => p.evaluate(() => {
    const planMd = document.querySelector('.plan-md');
    const sheen = document.querySelector('.compact-progress-sheen');
    const footer = document.querySelector('[data-composer-footer]');
    const txt = document.body.innerText || '';
    return {
      planMd: planMd ? getComputedStyle(planMd).fontSize : null,
      planTags: planMd ? [...planMd.querySelectorAll('h1,h2,h3,li,p,strong')].slice(0, 8).map((c) => c.tagName) : [],
      sheen: !!sheen,
      resumeCard: /Возобновить разговор|сесси/i.test(txt) && /⌨ Терминал|Отмена/.test(txt),
      active: document.activeElement ? document.activeElement.tagName : null,
      footerH: footer ? Math.round(footer.getBoundingClientRect().height) : null,
    };
  }).catch(() => ({}));

  const fmtState = (s) => {
    const o = s.permOptions ? s.permOptions.map((x) => x.digit + '=' + x.label).join(' | ') : '';
    const rp = s.resumePicker ? `${s.resumePicker.sessions.length}@${s.resumePicker.selectedIndex}` : 'null';
    return `alive=${s.alive} busy=${s.busy} mode=${s.mode} permMenu=${s.permMenu} kind=${s.permKind} isPlan=${s.permIsPlan} `
      + `progress=${s.progress} work="${s.workStatus || ''}" resumePicker=${rp}\n    opts: ${o}`;
  };

  // logFrame — основная единица: timestamp + фаза + состояние интерфейса + DOM + сырой терминал.
  const logFrame = async (label) => {
    const s = await st();
    const d = await dom();
    const xt = await xterm(16);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`\n===== [t=${dt}s][${phase}] ${label} =====`);
    log(`  STATE: ${fmtState(s)}`);
    log(`  DOM: planMd=${d.planMd} tags=[${(d.planTags || []).join(',')}] sheen=${d.sheen} resumeCard=${d.resumeCard} active=${d.active} footerH=${d.footerH}`);
    log(`  --- ТЕРМИНАЛ (хвост 16) ---\n${xt}`);
    return s;
  };

  const snap = async (label) => {
    fN++;
    await p.screenshot({ path: `${dir}/${pad(fN)}-${phase}-${label}.png` }).catch(() => {});
    return logFrame(label);
  };

  // Фоновый цикл: скрин каждые everyMs, помечен ТЕКУЩЕЙ фазой — чтобы покадрово видеть прогресс.
  const startFrames = (everyMs = 2000) => {
    framesOn = true;
    framePromise = (async () => {
      while (framesOn) {
        fN++;
        await p.screenshot({ path: `${dir}/${pad(fN)}-${phase}.png` }).catch(() => {});
        await p.waitForTimeout(everyMs);
      }
    })();
  };
  const stopFrames = async () => { framesOn = false; if (framePromise) await framePromise.catch(() => {}); };

  const box = () => p.locator('textarea[placeholder*="Сообщение для Claude"]').first();

  // Корректно закрыть claude: /exit завершает процесс → PTY-шелл возвращается → реапер чистит мёртвую
  // сессию. Без этого закрытие браузера оставляет claude висеть (orphan). Фолбэк — просто подождать.
  const closeClaude = async () => {
    try {
      log('\n[closeClaude] шлю /exit');
      await box().click({ timeout: 2000 });
      await box().fill('/exit');
      await box().press('Enter');
      await p.waitForTimeout(2500);
    } catch (e) { log('[closeClaude] не удалось через UI: ' + e.message); }
  };

  const flush = () => { writeFileSync(`${dir}/log.txt`, LOG); console.log(`\n📝 лог → ${dir}/log.txt`); };

  return { setInst, setPhase, log, st, xterm, dom, logFrame, snap, startFrames, stopFrames, box, closeClaude, flush };
}
