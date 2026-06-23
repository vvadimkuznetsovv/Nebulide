// Чистый детектор состояния экрана Claude Code (без React/xterm/DOM) — единственный
// источник правды и для приложения (Terminal.tsx), и для тестов (claudeScreen.test.ts).
// На вход — текст РЕНДЕР-ГРИДА терминала (ровные строки, как tmux capture-pane или
// xterm buffer.translateToString). На выход — структура состояния. Выверено на claude 2.1.175.
//
// Любой новый нюанс интерфейса claude → фикстура в claudeScreen.fixtures/ + проверка в
// claudeScreen.test.ts. Правка здесь = правка в проде (этот модуль бандлится во фронт).

// Prompt-ready (idle) индикаторы нижней строки. В НЕ-default режимах "? for shortcuts"
// заменяется на индикатор режима — поэтому idle = ЛЮБОЙ из них (иначе в acceptEdits/plan/
// auto claude «никогда не idle» и стоп залипает). Заодно даёт текущий режим.
export const IDLE_MARKS: { s: string; mode: string }[] = [
  { s: '? for shortcuts', mode: 'default' },      // claude ≤2.1.17x
  { s: 'for agents', mode: 'default' },            // claude 2.1.18x: "← for agents" заменил "? for shortcuts"
  { s: 'accept edits on', mode: 'acceptEdits' },
  { s: 'plan mode on', mode: 'plan' },
  { s: 'auto mode on', mode: 'auto' },
];

/** Scrape the live working line, e.g. "Caramelizing… (5s · ↑ 87 tokens)" или многословное
 *  "Compacting conversation… (3m 41s · ↑ 16.3k tokens)". Last match wins. */
export function extractWorkStatus(text: string): string {
  const withStats = text.match(/([A-Za-z]+(?: [a-z]+)*(?:…|\.\.\.)\s*\([^)]*tokens[^)]*\))/g);
  if (withStats && withStats.length) return cleanStatus(withStats[withStats.length - 1], 70);
  const glyph = text.match(/[✻✶✳✽✺✷✦✧·*]\s*([A-Za-z]+(?: [a-z]+)*(?:…|\.\.\.)[^\n]*)/);
  return glyph ? cleanStatus(glyph[1], 50) : '';
}

// Срезаем инлайн прогресс-бар (block-глифы) и хвостовой "NN%" из лейбла статуса — бар/процент
// выносим в отдельное поле (extractProgress) и рисуем настоящим прогресс-баром в чате.
function cleanStatus(s: string, max: number): string {
  return s.replace(/[█▉▊▋▌▍▎▏▰▱░▒▓].*$/u, '').replace(/\s*\d{1,3}\s*%\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Прогресс длинной операции (compact / SessionStart hooks): "…▱▱▱▱ 0%", "…▰▰▰ 33%".
 *  Числовой процент рядом с баром из block-глифов. Возвращает 0..100 (последний на экране) или null. */
export function extractProgress(text: string): number | null {
  const re = /[█▉▊▋▌▍▎▏▰▱░▒▓]\s*(\d{1,3})\s*%/g;
  let last: number | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = parseInt(m[1], 10);
    if (v >= 0 && v <= 100) last = v;
  }
  return last;
}

/** Чистим лейбл варианта permission в краткий русский (полный текст идёт в title). */
export function cleanPermLabel(raw: string): string {
  const r = raw.replace(/\s*\(shift\+tab\)\s*$/i, '').trim();
  if (/^no\b/i.test(r)) return 'Нет';
  if (/^yes$/i.test(r)) return 'Да';
  if (/^yes\b/i.test(r)) return /all edits|don'?t ask|allow all/i.test(r) ? 'Да, всегда' : 'Да, разрешить';
  return r.slice(0, 40);
}

export interface MenuOption { digit: string; label: string; raw: string; desc: string; checked?: boolean }
export interface QuestionTab { label: string; done: boolean }
export interface ScrapedMenu { kind: 'permission' | 'question'; multi: boolean; question: string; options: MenuOption[]; detail: string; tabs: QuestionTab[]; isPlan: boolean }

/** Табы мульти-вопроса AskUserQuestion: верхняя строка «←  ☐ Заголовок1  ✔️ Заголовок2  →».
 *  Даёт ЗАГОЛОВКИ вопросов и какие уже отвечены (✔️) → прогресс «вопрос N из M». */
export function scrapeQuestionTabs(lines: string[]): QuestionTab[] {
  // Маркеры табов claude: ☐ = вопрос НЕ отвечен, ☒ = отвечен (ballot-with-X), ✔/✓ = отвечен/Submit.
  for (const line of lines) {
    if (line.indexOf('←') < 0 || line.indexOf('→') < 0) continue;
    if (!/[☐☒✔✓]/.test(line)) continue;
    const inner = line.replace(/^[^←]*←/, '').replace(/→[^→]*$/, '');
    const tabs: QuestionTab[] = [];
    const re = /([☐☒✔✓])️?\s*([^☐☒✔✓]+?)(?=\s{2,}[☐☒✔✓]|\s*$)/g;
    for (let m = re.exec(inner); m; m = re.exec(inner)) {
      const label = m[2].trim();
      if (label) tabs.push({ label, done: /[☒✔✓]/.test(m[1]) }); // ☒/✔/✓ = отвечен
    }
    if (tabs.length) return tabs;
  }
  return [];
}

/** Скрейп ЛЮБОГО интерактивного select-меню claude из рендер-грида (выверено на 2.1.175):
 *  - permission: «Do you want to …?» + Yes/No(+allow) + футер «Esc to cancel · Tab to amend …»
 *  - question (AskUserQuestion): вопрос + МНОГО пунктов с описаниями (+ Type something / Chat
 *    about this) + футер «Enter to select · ↑/↓ to navigate · Esc to cancel».
 *  - plan (ExitPlanMode «Ready to code?»): футер «ctrl+g to edit in Vim · ~/.claude/plans/…».
 *  - подтверждение БЕЗ nav-футера («Change effort level?») — по курсору ❯ на пункте.
 *  Пункты берём ВСЕ (1..N, многоцифровые), описания (отступ под пунктом) собираем, мульти-
 *  селект — по чекбоксам [ ]/[✔]. Выбор — по цифре (проверено: цифра выбирает сразу). */
export function scrapeMenu(buf: string): ScrapedMenu | null {
  const lines = buf.split('\n');
  // Футер у самого низа → тип меню.
  let footerIdx = -1;
  let kind: 'permission' | 'question' = 'permission';
  // План-меню (ExitPlanMode «Ready to code?») — УНИКАЛЬНЫЙ футер без «Esc to cancel»:
  // «ctrl+g to edit in Vim · ~/.claude/plans/…». Проверяем первым.
  let isPlan = false;
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= 40; i--) {
    // ТОЛЬКО по уникальному "ctrl+g to edit". Путь ".claude/plans/" НЕ годится — claude
    // печатает "Planning: ~/.claude/plans/..." в обычном разговоре → ложно ловило футер на
    // этой строке и собирало варианты из случайного списка выше (баг: слова юзера как опции).
    if (/ctrl\+g to edit/.test(lines[i])) { footerIdx = i; kind = 'question'; isPlan = true; break; }
  }
  // СТРОГО: permission = «… Tab to amend …», question = «… Enter to select …».
  // Прочие select-меню (/model, /clear и т.п.) НЕ перехватываем (иначе кривая карта).
  if (footerIdx < 0) {
    for (let i = lines.length - 1; i >= 0 && lines.length - i <= 30; i--) {
      // ФУТЕР МОЖЕТ ПЕРЕНОСИТЬСЯ по ширине грида (узкий чат-онли вид): «… Esc to\ncancel». Склеиваем
      // со следующей строкой, иначе `Esc to cancel` не находится и детект меню «умирает» (без хуков).
      const t = lines[i] + ' ' + (lines[i + 1] || '');
      if (!/Esc to cancel/.test(t)) continue;
      if (/Tab to amend/.test(t)) { footerIdx = i; kind = 'permission'; break; }
      if (/Enter to select/.test(t)) { footerIdx = i; kind = 'question'; break; }
    }
  }
  // Фолбэк: подтверждающее меню БЕЗ явного nav-футера (напр. «Change effort level?»
  // при большом контексте) — якоримся на КУРСОР ❯ на нумерованном пункте у низа.
  if (footerIdx < 0) {
    for (let i = lines.length - 1; i >= 0 && lines.length - i <= 45; i--) {
      if (/^\s*❯\s*\d{1,2}\.\s+\S/.test(lines[i])) {
        let end = i + 1;
        while (end < lines.length && /^\s*[❯>]?\s*\d{1,2}\.\s/.test(lines[end])) end++;
        footerIdx = end; kind = 'question'; break;
      }
    }
  }
  if (footerIdx < 0) return null;
  // Пункт «1.» ближайший НАД футером — начало блока вариантов.
  let firstOptIdx = -1;
  for (let i = footerIdx - 1; i >= 0 && footerIdx - i <= 50; i--) {
    if (/^\s*[❯>]?\s*1\.\s/.test(lines[i])) { firstOptIdx = i; break; }
  }
  if (firstOptIdx < 0) return null;
  // Все пункты 1..N (многоцифровые) + их описания (отступ-строки под пунктом).
  const options: MenuOption[] = [];
  let cur: MenuOption | null = null;
  for (let i = firstOptIdx; i < footerIdx; i++) {
    const m = lines[i].match(/^\s*[❯>]?\s*(\d{1,2})\.\s+(.+?)\s*$/);
    if (m) {
      const raw = m[2].trim();
      // Чекбокс мульти-селекта: «[ ] Логи» / «[✔] Кэш» → checked + чистый лейбл.
      const cb = raw.match(/^\[([^\]]?)\]\s*(.*)$/);
      let label = kind === 'permission' ? cleanPermLabel(raw) : raw;
      let checked: boolean | undefined;
      if (cb) { checked = /[xX✔✓]/.test(cb[1]); label = cb[2].trim() || raw; }
      cur = { digit: m[1], label, raw, desc: '', checked };
      options.push(cur);
    } else if (cur && lines[i].trim() && !/^[❯>\s]*[╌╴─—═]+\s*$/.test(lines[i])) {
      cur.desc = (cur.desc ? cur.desc + ' ' : '') + lines[i].trim();
    }
  }
  if (options.length < 2) return null;
  const multi = kind === 'question' && options.some((o) => o.checked !== undefined);
  // Вопрос НАД пунктом 1: предпочитаем ближайшую строку, ОКАНЧИВАЮЩУЮСЯ на «?» (это и есть
  // заголовок-вопрос, напр. «Change effort level?» / «Do you want to proceed?»), иначе —
  // ближайшую непустую (описание уйдёт в detail).
  let question = '';
  let qIdx = firstOptIdx;
  let firstText = '';
  let firstTextIdx = firstOptIdx;
  for (let i = firstOptIdx - 1; i >= 0 && firstOptIdx - i <= 10; i--) {
    const t = lines[i].trim();
    if (!t || /^[╌╴─—═]+$/.test(t)) continue;
    if (!firstText) { firstText = t; firstTextIdx = i; }
    if (/\?$/.test(t)) { question = t.replace(/\s+/g, ' ').slice(0, 140); qIdx = i; break; }
  }
  if (!question && firstText) { question = firstText.replace(/\s+/g, ' ').slice(0, 140); qIdx = firstTextIdx; }
  // Деталь — контекст над вопросом/между вопросом и пунктами (разные источники по типу).
  let detail = '';
  if (kind === 'permission') {
    // Команда может быть МНОГОСТРОЧНОЙ (heredoc/SQL на 20+ строк) — ищем верхнюю линию
    // ───── далеко вверх (до 80 строк), иначе фолбэк терял всё кроме хвоста.
    let topIdx = -1;
    for (let i = qIdx - 1; i >= 0 && qIdx - i <= 80; i--) {
      if (/^[─—]{10,}$/.test(lines[i].trim())) { topIdx = i; break; }
    }
    const from = topIdx >= 0 ? topIdx + 1 : Math.max(0, qIdx - 50);
    detail = collectDetail(lines, from, qIdx, 2000);
  } else if (isPlan) {
    // Текст плана = блок между «Here is Claude's plan:» и вопросом (без линий-разделителей).
    // Длинный план может уходить выше вьюпорта в скроллбэк — ищем заголовок глубоко (до 200 строк)
    // и берём с большим запасом (cap 6000), чтобы показать план ЦЕЛИКОМ, а не его хвост.
    let hdr = -1;
    for (let i = qIdx - 1; i >= 0 && qIdx - i <= 200; i--) {
      if (/Here is Claude.s plan:/.test(lines[i])) { hdr = i; break; }
    }
    const from = hdr >= 0 ? hdr + 1 : Math.max(0, qIdx - 120);
    detail = collectDetail(lines, from, qIdx, 6000);
  } else if (kind === 'question' && qIdx < firstOptIdx - 1) {
    // Описание МЕЖДУ вопросом и пунктами (напр. у «Change effort level?» — про кэш/скорость).
    detail = collectDetail(lines, qIdx + 1, firstOptIdx, 600);
  }
  // Заголовки/прогресс мульти-вопроса — только для AskUserQuestion (не план/permission).
  const tabs = kind === 'question' && !isPlan ? scrapeQuestionTabs(lines) : [];
  return { kind, multi, question, options, detail, tabs, isPlan };
}

export interface ResumeSession { name: string; meta: string; selected: boolean }

/** Скрейп /resume-ПИКЕРА claude (список сессий, отдельный от меню сжатой сессии). Футер
 *  «… Type to search · Esc to cancel» + заголовок «Resume session (X of Y)». Каждая сессия =
 *  строка-ИМЯ (❯ на выбранной) + строка-МЕТА «58 seconds ago · HEAD · 62.2KB». Возвращает сессии
 *  по порядку + индекс выбранной — карточка по клику навигирует стрелками от выбранной к цели. */
export function scrapeResumePicker(buf: string): { sessions: ResumeSession[]; selectedIndex: number; total: number } | null {
  const lines = buf.split('\n');
  // Детект — по УНИКАЛЬНОМУ футеру, НЕ по заголовку «Resume session» (при многих сессиях он
  // выдавливается за верх вьюпорта). ВАЖНО: футер в узком терминале ПЕРЕНОСИТСЯ на 2–3 строки
  // («…Type to search» и «· Esc to cancel» оказываются на РАЗНЫХ строках), поэтому маркеры ищем в
  // СКЛЕЕННОМ хвосте (последние непустые строки), а не на одной строке.
  const tail = lines.filter((l) => l.trim()).slice(-14).join(' ');
  if (!/Esc to cancel/.test(tail) || !/(Type to search|to rename|show all projects|to preview)/.test(tail)) return null;
  const META = /\d+\s+(second|minute|hour|day|week|month)s?\s+ago/i;
  const sessions: ResumeSession[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!META.test(lines[i])) continue; // META-строка = «X ago · branch · size» под именем сессии
    const meta = lines[i].replace(/\s+/g, ' ').trim();
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    const nameLine = lines[j] || '';
    if (/Resume session|Search/i.test(nameLine)) continue;
    const selected = nameLine.indexOf('❯') >= 0;
    const name = nameLine.replace(/^[\s❯>↓↑]+/, '').trim(); // снять маркер выбора/скролла (❯ ↓ ↑)
    if (name) sessions.push({ name, meta, selected });
  }
  if (sessions.length < 1) return null;
  let selectedIndex = sessions.findIndex((s) => s.selected);
  if (selectedIndex < 0) selectedIndex = 0;
  // «Resume session (X of Y)» — общее число сессий Y (когда заголовок виден; при прокрутке вверху).
  // Если заголовок выдавлен — total = число видимых (минимум сколько точно есть).
  const m = buf.match(/Resume session\s*\(\s*\d+\s+of\s+(\d+)\s*\)/i);
  const total = m ? parseInt(m[1], 10) : sessions.length;
  return { sessions, selectedIndex, total };
}

/** Собрать строки [from, to) в текст: пропустить чисто-разделительные, обрезать пустые края. */
function collectDetail(lines: string[], from: number, to: number, cap: number): string {
  const raw: string[] = [];
  for (let i = from; i < to; i++) {
    if (/^[╌╴─—═]+$/.test(lines[i].trim())) continue;
    raw.push(lines[i].replace(/\s+$/, ''));
  }
  while (raw.length && !raw[0].trim()) raw.shift();
  while (raw.length && !raw[raw.length - 1].trim()) raw.pop();
  return raw.join('\n').slice(0, cap);
}

export interface ScreenAnalysis {
  resumeMenu: boolean;     // блокирующее меню «как восстановить» (claude --resume сжатой сессии)
  resumeInfo: string;
  resumePicker: { sessions: ResumeSession[]; selectedIndex: number; total: number } | null; // /resume — список сессий
  menu: ScrapedMenu | null; // permission / question / plan / подтверждение
  hasMarkers: boolean;     // на экране есть busy- ИЛИ idle-маркер (claude жив и не в меню-загрузке)
  busy: boolean;           // claude РАБОТАЕТ (esc to interrupt / Compacting позже idle-маркера)
  idleVisible: boolean;    // виден idle-индикатор (можно обновить режим)
  mode: string;            // режим из idle-индикатора (или prevMode)
  workStatus: string;      // живая строка статуса при busy (без инлайн-бара/процента)
  progress: number | null; // прогресс длинной операции (compact/hooks) 0..100, иначе null
  alive: boolean;          // claude TUI присутствует (маркеры ИЛИ любое меню)
  errorMsg: string;        // ошибка/сетевая проблема claude (API Error / Waiting for API · network) — в чат КРАСНЫМ
  effort: string;          // текущий уровень усилий из футера («● high · /effort») — low/medium/high/xhigh/max, иначе ''
  usage: UsageInfo | null; // недельный usage (% + дата сброса) — только когда виден /usage-экран, иначе null
}

/** Ошибка/сетевая проблема claude для показа КРАСНЫМ в чате (одной карточкой, не плодим). Ловим
 *  «API Error: …» (последнюю) и ретрай «Waiting for API response · … · check your network». Из РФ
 *  API часто недоступен → claude висит на ретраях; пользователь должен видеть это явно. */
export function extractError(buf: string): string {
  // ТОЛЬКО в ХВОСТЕ кадра (последние ~12 непустых строк у инпута). Иначе разовая ошибка из scrollback
  // «залипала» бы навсегда в карточке. Новая активность claude выталкивает её из хвоста → карточка гаснет.
  const tail = buf.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  const apiErr = tail.match(/API Error:[^\n│]*/g);
  if (apiErr && apiErr.length) return cleanStatus(apiErr[apiErr.length - 1], 180);
  const net = tail.match(/Waiting for API response[^\n│]*?check your network/);
  if (net) return cleanStatus(net[0], 180);
  return '';
}

export interface UsageInfo { weeklyPercent: number; resetAt: number }

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** «Resets Jun 27, 8am (Europe/Moscow)» → epoch-ms (локальное время; для дневной гранулярности TZ не
 *  критична — порог считается в ОКРУГЛЁННЫХ днях). Год не указан → текущий, с откатом на следующий. */
function parseResetDate(monDay: string, hh: string, mm: string, ampm: string): number {
  const md = monDay.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})/);
  if (!md) return 0;
  const mon = MONTHS[md[1].toLowerCase()];
  if (mon === undefined) return 0;
  const day = parseInt(md[2], 10);
  let hour = parseInt(hh, 10) % 12;
  if (/pm/i.test(ampm)) hour += 12;
  const min = mm ? parseInt(mm, 10) : 0;
  const now = new Date();
  let year = now.getFullYear();
  if (new Date(year, mon, day, hour, min).getTime() < now.getTime() - 86400000) year += 1; // дата прошла → следующий год
  return new Date(year, mon, day, hour, min).getTime();
}

/** Скрейп экрана `/usage`: НЕДЕЛЬНЫЙ usage % («Current week (all models)») + дата сброса. Возвращает
 *  null, если /usage-экран не виден. Формат (claude 2.1.186):
 *    Current week (all models)
 *    █████…    59% used
 *    Resets Jun 27, 8am (Europe/Moscow)                                                        */
export function scrapeUsage(buf: string): UsageInfo | null {
  if (!/Current week/.test(buf) || !/%\s*used/.test(buf)) return null; // не /usage-экран
  // Берём СЕГМЕНТ от заголовка «Current week (all models)» до СЛЕДУЮЩЕГО недельного блока. Работаем по
  // подстроке, а НЕ построчно: xterm-перерисовка иногда «слипает» заголовок, бар и «NN% used» в одну
  // строку (видно в живом кадре: «…Current week (all models)███▉  57% used»). % и Resets берём из сегмента.
  const head = buf.search(/Current week \(all models\)/i);
  const idx = head >= 0 ? head : buf.search(/Current week/i);
  if (idx < 0) return null;
  const after = buf.slice(idx + 'Current week (all models)'.length);
  const next = after.search(/Current week \(/i); // начало следующего блока (Sonnet only / др.)
  const seg = next >= 0 ? after.slice(0, next) : after.slice(0, 260);
  const pm = seg.match(/(\d{1,3})%\s*used/i);
  if (!pm) return null;
  const weeklyPercent = parseInt(pm[1], 10);
  const rm = seg.match(/Resets\s+([A-Za-z]{3,}\s+\d{1,2}),?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
  const resetAt = rm ? parseResetDate(rm[1], rm[2], rm[3], rm[4]) : 0;
  return { weeklyPercent, resetAt };
}

/** «Режим монстра доступен»: usage НИЖЕ дневного порога (недо-использование → остаток лимита сгорит).
 *  Таблица по daysElapsed = 7 − round(daysUntilReset): чем больше дней прошло, тем выше допустимый %.
 *  Анкеры пользователя: день1<10, день2<20, «~2 дня до сброса»=день5≤60, последний день→100. */
export function monsterMode(weeklyPercent: number, daysUntilReset: number): boolean {
  const daysElapsed = Math.min(7, Math.max(1, 7 - Math.round(daysUntilReset)));
  const THRESH: Record<number, number> = { 1: 10, 2: 20, 3: 30, 4: 45, 5: 60, 6: 80, 7: 100 };
  return weeklyPercent <= THRESH[daysElapsed];
}

/** ЧИСТЫЙ анализ экрана → состояние. Terminal.tsx применяет его к сессии и эмитит события;
 *  тесты проверяют этот результат на фикстурах. Точное зеркало прежней detectClaudeScreen. */
export function analyzeScreen(buf: string, prevMode: string): ScreenAnalysis {
  const resumeMenu = buf.includes('Resume from summary') && buf.includes('Resume full session') && /Don.?t ask me again/.test(buf);
  let resumeInfo = '';
  if (resumeMenu) { const m = buf.match(/This session is[^\n]*?tokens?\./); resumeInfo = m ? m[0].trim() : ''; }
  const resumePicker = resumeMenu ? null : scrapeResumePicker(buf);
  const menu = resumeMenu || resumePicker ? null : scrapeMenu(buf);

  // busy vs idle — позиция последнего маркера. Сжатие ("Compacting conversation…") = busy.
  // Новые версии claude (2.1.18x) УБРАЛИ "esc to interrupt" из части busy-состояний — теперь
  // живая строка статуса выглядит как "✻ Billowing… (… · ↓ 3 tokens)". Поэтому busy ловим и по
  // строке статуса со счётчиком токенов (тот же паттерн, что extractWorkStatus).
  // Ловим спиннер по «Слово… (… tokens …)» ИЛИ по «Слово… (Ns …)» — первые секунды claude
  // показывает «Contemplating… (3s)» БЕЗ счётчика токенов (токены ещё не потекли), и старый
  // паттерн (только tokens) пропускал ~7с работы → индикатор «думает» появлялся с задержкой.
  // ── busy: по ПРИСУТСТВИЮ активного маркера работы в ХВОСТЕ кадра (живой статус всегда у инпута внизу),
  // НЕ по позиции относительно idle-футера. В claude 2.1.18x футер «← for agents» висит ВНИЗУ ВСЕГДА
  // (ниже спиннера) → прежняя логика «bi > idleIdx» давала busy=false почти всегда («мышление с трудом»).
  // Маркеры (есть только пока claude РАБОТАЕТ): «esc to interrupt», «Compacting conversation»,
  // таймер-спиннер «Word… (Ns · tokens)», голый спиннер-звезда «✶ Word…». Завершённые индикаторы
  // («✻ Brewed for 18s» — БЕЗ «…») НЕ матчатся. Хвост (≈22 строки) — чтобы scrollback не давал ложняк.
  const tail = buf.split('\n').slice(-22).join('\n');
  const busy = /esc to interrupt|Compacting conversation/.test(tail)
    || /[A-Za-z]+(?: [a-z]+)*(?:…|\.\.\.)\s*\([^)]*(?:tokens|\d+s)[^)]*\)/.test(tail)
    || /(?:^|\n)\s*[✻✶✳✽✺✷✦✧✢✸✹⣾⣽⣻⢿⡿⣟⣯⣷]\s+[A-Z][a-z]+(?:…|\.\.\.)/.test(tail);
  // idle-присутствие: позиция последнего idle-хинта (для alive/idleVisible/режима).
  let idleIdx = -1;
  for (const m of IDLE_MARKS) { const idx = buf.lastIndexOf(m.s); if (idx > idleIdx) idleIdx = idx; }
  // Режим — ТОЛЬКО из специфичных маркеров (plan/acceptEdits/auto). "← for agents" / "? for
  // shortcuts" — общий хинт, есть во ВСЕХ режимах (в т.ч. рядом с "plan mode on"), режим не задаёт.
  let mode = prevMode;
  let modeIdx = -1;
  for (const m of IDLE_MARKS) {
    if (m.mode === 'default') continue;
    const idx = buf.lastIndexOf(m.s);
    if (idx > modeIdx) { modeIdx = idx; mode = m.mode; }
  }
  if (idleIdx >= 0 && modeIdx < 0) mode = 'default'; // idle есть, спец-маркера режима нет → default
  const hasMarkers = busy || idleIdx >= 0;
  return {
    resumeMenu,
    resumeInfo,
    resumePicker,
    menu,
    hasMarkers,
    busy,
    idleVisible: idleIdx >= 0,
    mode,
    workStatus: busy ? extractWorkStatus(buf) : '',
    progress: busy ? extractProgress(buf) : null,
    alive: hasMarkers || resumeMenu || !!menu || !!resumePicker,
    errorMsg: extractError(buf),
    // Текущий effort из футера claude: «● high · /effort» / «high · /effort».
    effort: (buf.match(/\b(low|medium|high|xhigh|max)\b[^\n]{0,10}\/effort/i)?.[1] || '').toLowerCase(),
    usage: scrapeUsage(buf), // недельный usage — не null только на /usage-экране
  };
}
