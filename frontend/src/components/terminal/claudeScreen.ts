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
  if (withStats && withStats.length) return withStats[withStats.length - 1].replace(/\s+/g, ' ').trim().slice(0, 70);
  const glyph = text.match(/[✻✶✳✽✺✷✦✧·*]\s*([A-Za-z]+(?: [a-z]+)*(?:…|\.\.\.)[^\n]*)/);
  return glyph ? glyph[1].replace(/\s+/g, ' ').trim().slice(0, 50) : '';
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
export interface ScrapedMenu { kind: 'permission' | 'question'; multi: boolean; question: string; options: MenuOption[]; detail: string; tabs: QuestionTab[] }

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
      const t = lines[i];
      if (!t.includes('Esc to cancel')) continue;
      if (/Tab to amend/.test(t)) { footerIdx = i; kind = 'permission'; break; }
      if (/Enter to select/.test(t)) { footerIdx = i; kind = 'question'; break; }
    }
  }
  // Фолбэк: подтверждающее меню БЕЗ явного nav-футера (напр. «Change effort level?»
  // при большом контексте) — якоримся на КУРСОР ❯ на нумерованном пункте у низа.
  if (footerIdx < 0) {
    for (let i = lines.length - 1; i >= 0 && lines.length - i <= 22; i--) {
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
    let hdr = -1;
    for (let i = qIdx - 1; i >= 0 && qIdx - i <= 80; i--) {
      if (/Here is Claude.s plan:/.test(lines[i])) { hdr = i; break; }
    }
    const from = hdr >= 0 ? hdr + 1 : Math.max(0, qIdx - 40);
    detail = collectDetail(lines, from, qIdx, 2500);
  } else if (kind === 'question' && qIdx < firstOptIdx - 1) {
    // Описание МЕЖДУ вопросом и пунктами (напр. у «Change effort level?» — про кэш/скорость).
    detail = collectDetail(lines, qIdx + 1, firstOptIdx, 600);
  }
  // Заголовки/прогресс мульти-вопроса — только для AskUserQuestion (не план/permission).
  const tabs = kind === 'question' && !isPlan ? scrapeQuestionTabs(lines) : [];
  return { kind, multi, question, options, detail, tabs };
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
  menu: ScrapedMenu | null; // permission / question / plan / подтверждение
  hasMarkers: boolean;     // на экране есть busy- ИЛИ idle-маркер (claude жив и не в меню-загрузке)
  busy: boolean;           // claude РАБОТАЕТ (esc to interrupt / Compacting позже idle-маркера)
  idleVisible: boolean;    // виден idle-индикатор (можно обновить режим)
  mode: string;            // режим из idle-индикатора (или prevMode)
  workStatus: string;      // живая строка статуса при busy
  alive: boolean;          // claude TUI присутствует (маркеры ИЛИ любое меню)
}

/** ЧИСТЫЙ анализ экрана → состояние. Terminal.tsx применяет его к сессии и эмитит события;
 *  тесты проверяют этот результат на фикстурах. Точное зеркало прежней detectClaudeScreen. */
export function analyzeScreen(buf: string, prevMode: string): ScreenAnalysis {
  const resumeMenu = buf.includes('Resume from summary') && buf.includes('Resume full session') && /Don.?t ask me again/.test(buf);
  let resumeInfo = '';
  if (resumeMenu) { const m = buf.match(/This session is[^\n]*?tokens?\./); resumeInfo = m ? m[0].trim() : ''; }
  const menu = resumeMenu ? null : scrapeMenu(buf);

  // busy vs idle — позиция последнего маркера. Сжатие ("Compacting conversation…") = busy.
  // Новые версии claude (2.1.18x) УБРАЛИ "esc to interrupt" из части busy-состояний — теперь
  // живая строка статуса выглядит как "✻ Billowing… (… · ↓ 3 tokens)". Поэтому busy ловим и по
  // строке статуса со счётчиком токенов (тот же паттерн, что extractWorkStatus).
  const workRe = /[A-Za-z]+(?: [a-z]+)*(?:…|\.\.\.)\s*\([^)]*tokens[^)]*\)/g;
  let workIdx = -1;
  for (let m = workRe.exec(buf); m; m = workRe.exec(buf)) workIdx = m.index;
  const bi = Math.max(buf.lastIndexOf('esc to interrupt'), buf.lastIndexOf('Compacting conversation'), workIdx);
  // idle-присутствие: позиция последнего ЛЮБОГО idle-хинта (claude жив и ждёт ввода).
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
  const hasMarkers = bi >= 0 || idleIdx >= 0;
  const busy = hasMarkers && bi > idleIdx;
  return {
    resumeMenu,
    resumeInfo,
    menu,
    hasMarkers,
    busy,
    idleVisible: idleIdx >= 0,
    mode,
    workStatus: busy ? extractWorkStatus(buf) : '',
    alive: hasMarkers || resumeMenu || !!menu,
  };
}
