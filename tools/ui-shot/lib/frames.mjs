// Общий харнесс для покадровых адаптивных тестов фич чат-обёртки (план / compact / resume).
// Даёт: фоновый frame-grabber (скрин раз в N мс, помечен текущей ФАЗОЙ), logFrame (в лог пишет
// и состояние ИНТЕРФЕЙСА — __nebScreen().state + DOM-проверки, и сырой вывод ТЕРМИНАЛА — xtermScreen),
// snap (скрин + logFrame), и closeClaude (шлёт /exit, чтобы НЕ плодить orphan-claude).
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const pad = (n) => String(n).padStart(3, '0');
const RR = (rel) => fileURLToPath(new URL('../node_modules/' + rel, import.meta.url));

// Самодостаточный плеер на rrweb.Replayer (надёжен в file://): реальный DOM в iframe + контролы
// play/pause, рестарт, скраббер, скорость 1×/2×/4×. Скрипты грузятся с domcontentloaded (recording.js
// крупный — событие load блокируется, но плеер строится из inline-скрипта сразу).
const PLAYER_HTML = (dir) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>rrweb — ${dir}</title>
<link rel="stylesheet" href="./rrweb.css">
<style>
 body{margin:0;background:#0d0a14;color:#e8e3f0;font-family:system-ui,sans-serif}
 #bar{display:flex;align-items:center;gap:10px;padding:10px 14px;position:sticky;top:0;background:#16131f;border-bottom:1px solid #2e2545;z-index:10}
 button{background:#241c3a;color:#e8e3f0;border:1px solid #3a2e57;border-radius:7px;padding:6px 12px;cursor:pointer;font-size:13px}
 button:hover{border-color:#7F00FF}
 #seek{flex:1;accent-color:#7F00FF}
 #time{font-variant-numeric:tabular-nums;font-size:12px;color:#b8adce;min-width:96px;text-align:right}
 #wrap{display:flex;justify-content:center;padding:14px}
 .speed.active{background:#7F00FF;border-color:#7F00FF}
</style></head><body>
<div id="bar">
 <button id="pp">▶ Play</button><button id="rs" title="Сначала">⟲</button>
 <input id="seek" type="range" min="0" max="1000" value="0">
 <span id="time">0.0 / 0.0s</span>
 <button class="speed active" data-s="1">1×</button><button class="speed" data-s="2">2×</button><button class="speed" data-s="4">4×</button>
</div>
<div id="wrap"><div id="app"></div></div>
<script src="./rrweb.umd.min.cjs"></script>
<script src="./recording.js"></script>
<script>
 var rep = new window.rrweb.Replayer(window.__events||[], { root: document.getElementById('app'), showWarning:false, mouseTail:false, speed:1 });
 var total = rep.getMetaData().totalTime || 1;
 var seek=document.getElementById('seek'), time=document.getElementById('time'), pp=document.getElementById('pp');
 var playing=false, scrubbing=false;
 function fmt(ms){return (ms/1000).toFixed(1);}
 function tick(){ if(!scrubbing){ var t=Math.min(rep.getCurrentTime(), total); seek.value=Math.round(t/total*1000)||0; time.textContent=fmt(t)+' / '+fmt(total)+'s'; if(playing && t>=total){playing=false;pp.textContent='▶ Play';} } requestAnimationFrame(tick); }
 tick();
 pp.onclick=function(){ if(playing){rep.pause();playing=false;pp.textContent='▶ Play';} else {var t=rep.getCurrentTime()>=total?0:rep.getCurrentTime(); rep.play(t);playing=true;pp.textContent='⏸ Pause';} };
 document.getElementById('rs').onclick=function(){ rep.play(0); playing=true; pp.textContent='⏸ Pause'; };
 seek.addEventListener('input',function(){ scrubbing=true; var t=seek.value/1000*total; time.textContent=fmt(t)+' / '+fmt(total)+'s'; });
 seek.addEventListener('change',function(){ var t=seek.value/1000*total; if(playing){rep.play(t);}else{rep.pause(t);} scrubbing=false; });
 Array.prototype.forEach.call(document.querySelectorAll('.speed'),function(btn){ btn.onclick=function(){ document.querySelectorAll('.speed').forEach(function(x){x.classList.remove('active');}); btn.classList.add('active'); rep.setConfig({speed:+btn.dataset.s}); }; });
</script></body></html>`;

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
    const ta = document.querySelector('textarea[placeholder*="Сообщение для Claude"]');
    const txt = document.body.innerText || '';
    return {
      planMd: planMd ? getComputedStyle(planMd).fontSize : null,
      planTags: planMd ? [...planMd.querySelectorAll('h1,h2,h3,li,p,strong')].slice(0, 8).map((c) => c.tagName) : [],
      sheen: !!sheen,
      resumeCard: /Возобновить сессию/i.test(txt),
      active: document.activeElement ? document.activeElement.tagName : null,
      taH: ta ? Math.round(ta.getBoundingClientRect().height) : null, // высота поля ввода (раскрылось ли)
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

  // Завершить claude этого прогона БЕЗ /exit (он засорял открытое меню). Закрытие браузера рвёт WS,
  // но PTY с claude висит (реапер без таймаута) → orphan копятся, тормозят ПК. Поэтому НАПРЯМУЮ
  // убиваем claude.exe, ПОРОЖДЁННЫЕ тестом — родитель powershell/pwsh/cmd (PTY-шелл бэкенда). VS Code/
  // агентские claude (родитель Code.exe) НЕ трогаем. Так нет ни /exit, ни orphan.
  const closeClaude = async () => {
    const PS = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { "
      + "$par=(Get-CimInstance Win32_Process -Filter (\"ProcessId=\"+$_.ParentProcessId) -ErrorAction SilentlyContinue); "
      + "if ($par -and @('powershell.exe','pwsh.exe','cmd.exe') -contains $par.Name) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }";
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', PS], { stdio: 'ignore' });
      log('\n[closeClaude] тест-claude (родитель powershell/cmd) завершён, orphan не копятся');
    } catch (e) { log('\n[closeClaude] kill не удался: ' + e.message); }
  };

  const flush = () => { writeFileSync(`${dir}/log.txt`, LOG); console.log(`\n📝 лог → ${dir}/log.txt`); };

  // rrweb: инжектим рекордер в страницу (после openClaude — SPA стабилен, без перезагрузок), копим
  // события DOM-мутаций/действий в window.__rr. inline* + collectFonts — для офлайн-точности плеера.
  const startRecording = async () => {
    try {
      const src = readFileSync(RR('rrweb/dist/rrweb.umd.min.cjs'), 'utf8');
      await p.addScriptTag({ content: src });
      await p.evaluate(() => {
        if (!window.rrweb) return;
        window.__rr = [];
        window.__rrStop = window.rrweb.record({ emit: (e) => window.__rr.push(e), inlineStylesheet: true, inlineImages: true, collectFonts: true });
      });
      log('[rrweb] запись DOM начата');
    } catch (e) { log('[rrweb] не удалось стартовать: ' + e.message); }
  };

  // Сохранить запись как офлайн-плеер: recording.js (события JS-присваиванием — file:// не умеет fetch),
  // rrweb UMD + его CSS, player.html. ВАЖНО: используем СОБСТВЕННЫЙ плеер на `rrweb.Replayer` (а не
  // пакет rrweb-player — его Svelte-обёртка тихо НЕ строит реплей в file://, проверено). Replayer
  // надёжно рендерит реальный DOM в iframe; контролы (play/pause/скраббер/скорость) — свои.
  const saveRecording = async () => {
    try {
      const ev = await p.evaluate(() => window.__rr || []);
      if (!ev.length) { log('[rrweb] событий нет (запись не стартовала?)'); return; }
      writeFileSync(`${dir}/recording.js`, 'window.__events = ' + JSON.stringify(ev) + ';');
      copyFileSync(RR('rrweb/dist/rrweb.umd.min.cjs'), `${dir}/rrweb.umd.min.cjs`);
      copyFileSync(RR('rrweb/dist/style.css'), `${dir}/rrweb.css`);
      writeFileSync(`${dir}/player.html`, PLAYER_HTML(dir));
      log(`[rrweb] 🎬 запись (${ev.length} событий) → открой ${dir}/player.html`);
    } catch (e) { log('[rrweb] сохранение не удалось: ' + e.message); }
  };

  return { setInst, setPhase, log, st, xterm, dom, logFrame, snap, startFrames, stopFrames, box, closeClaude, flush, startRecording, saveRecording };
}
