// Регресс-тесты детектора экрана claude на КОРПУСЕ ФИКСТУР (реальные гриды, снятые с
// claude 2.1.175). Любой новый нюанс → фикстура в claudeScreen.fixtures/ + кейс здесь.
// Зелёный тест на Windows = зелёный в проде на Linux (модуль один и тот же).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scrapeMenu, analyzeScreen, scrapeResumePicker, extractWorkStatus, extractProgress, extractError } from './claudeScreen';

const FX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'claudeScreen.fixtures');
const fx = (name: string) => readFileSync(join(FX_DIR, name), 'utf8');

describe('scrapeMenu — permission', () => {
  it('Bash, 2 варианта (shell-syntax «cannot be statically analyzed»)', () => {
    const m = scrapeMenu(fx('permission-bash-2opt.txt'))!;
    expect(m.kind).toBe('permission');
    expect(m.multi).toBe(false);
    expect(m.options.map((o) => o.digit)).toEqual(['1', '2']);
    expect(m.options.map((o) => o.label)).toEqual(['Да', 'Нет']);
    expect(m.question).toBe('Do you want to proceed?');
    expect(m.detail).toContain('V=$(echo test)');
    expect(m.detail).toContain('Bash command');
  });

  it('Write, 3 варианта (allow all edits)', () => {
    const m = scrapeMenu(fx('permission-write-3opt.txt'))!;
    expect(m.options.map((o) => o.digit)).toEqual(['1', '2', '3']);
    expect(m.options.map((o) => o.label)).toEqual(['Да', 'Да, всегда', 'Нет']);
    expect(m.question).toBe('Do you want to create cal.txt?');
    expect(m.detail).toContain('hello');
  });

  it('Bash, 3 варианта (allow reading from dir)', () => {
    const m = scrapeMenu(fx('permission-bash-3opt.txt'))!;
    expect(m.options.map((o) => o.digit)).toEqual(['1', '2', '3']);
    expect(m.options[1].label).toBe('Да, разрешить');
    expect(m.detail).toContain('ls -la /tmp');
  });
});

describe('scrapeMenu — question / plan / multiselect', () => {
  it('одиночный вопрос (git pull) — 6 пунктов с описаниями', () => {
    const m = scrapeMenu(fx('question-gitpull.txt'))!;
    expect(m.kind).toBe('question');
    expect(m.multi).toBe(false);
    expect(m.options.length).toBe(6);
    expect(m.question).toBe('Что делать с незакоммиченными правками перед git pull?');
    expect(m.options[0].raw).toContain('git stash');
    expect(m.options[0].desc).toContain('Спрятать');
  });

  it('табы мульти-вопроса — заголовки + прогресс (← ☐ Пул ✔️ Submit →)', () => {
    const m = scrapeMenu(fx('question-gitpull.txt'))!;
    expect(m.tabs.map((t) => t.label)).toContain('Пул');
    expect(m.tabs.find((t) => t.label === 'Пул')?.done).toBe(false);
    expect(m.tabs.find((t) => t.label === 'Submit')?.done).toBe(true);
  });

  it('мульти-селект (чекбоксы [ ]/[✔])', () => {
    const m = scrapeMenu(fx('multiselect-spores.txt'))!;
    expect(m.kind).toBe('question');
    expect(m.multi).toBe(true);
    expect(m.options[0].checked).toBe(false);
    expect(m.options[0].label).toBe('Споры внутри карточек');
  });

  it('план (Ready to code? / ExitPlanMode) — текст плана в detail', () => {
    const m = scrapeMenu(fx('plan-menu.txt'))!;
    expect(m.kind).toBe('question');
    expect(m.options.map((o) => o.digit)).toEqual(['1', '2', '3', '4']);
    expect(m.question).toContain('Would you like to proceed?');
    expect(m.detail).toContain('План: добавить файл ping.txt');
    expect(m.detail).toContain('Verification');
  });

  it('НЕ принимает "Planning: ~/.claude/plans/…" в разговоре за план-футер (слова юзера НЕ опции)', () => {
    const m = scrapeMenu(fx('question-with-tasklist-above.txt'))!;
    expect(m.question).toContain('Задача 4');
    expect(m.options[0].label).toContain('Этап + код 3DS');
    expect(m.options.map((o) => o.label).join(' ')).not.toContain('проверить что странице');
  });

  it('подтверждение БЕЗ nav-футера (Change effort level)', () => {
    const m = scrapeMenu(fx('change-effort-level.txt'))!;
    expect(m.kind).toBe('question');
    expect(m.options.map((o) => o.digit)).toEqual(['1', '2']);
    expect(m.question).toBe('Change effort level?');
    expect(m.detail).toContain('cached');
  });
});

describe('scrapeResumePicker — /resume список сессий', () => {
  it('сессии по порядку + выбранная (❯) + индекс + total из «X of Y»', () => {
    const r = scrapeResumePicker(fx('resume-picker.txt'))!;
    expect(r.sessions.length).toBeGreaterThanOrEqual(5);
    expect(r.sessions[0].name).toBe('Ответ одним словом');
    expect(r.sessions[0].selected).toBe(true);
    expect(r.selectedIndex).toBe(0);
    expect(r.total).toBe(16); // «Resume session (1 of 16)» → всего 16, хотя видно меньше
    expect(r.sessions.find((s) => s.name === 'Создать приложение todo на React')?.meta).toContain('99.1KB');
  });
  it('обычное меню НЕ принимается за resume-пикер', () => {
    expect(scrapeResumePicker(fx('question-gitpull.txt'))).toBeNull();
  });
  it('заголовок «Resume session» уехал за верх грида — пикер всё равно распознан по футеру', () => {
    // При многих сессиях шапка выдавливается из вьюпорта; детект должен держаться на футере.
    const noHeader = fx('resume-picker.txt').split('\n').filter((l) => !/Resume session/i.test(l)).join('\n');
    const r = scrapeResumePicker(noHeader)!;
    expect(r).not.toBeNull();
    expect(r.sessions.length).toBeGreaterThanOrEqual(5);
    expect(r.sessions[0].name).toBe('Ответ одним словом');
  });
  it('футер ПЕРЕНЕСЁН на 3 строки (узкий терминал) — пикер распознан, ❯/↓-маркеры сняты с имени', () => {
    // Реальный claude v2.1.185 в узком окне переносит футер: «Type to search» и «Esc to cancel»
    // оказываются на РАЗНЫХ строках. Раньше это давало null. Имена идут с ❯ (выбран) и ↓ (скролл).
    const buf = [
      '  Resume session (1 of 41)', '  ╭────────────╮', '  │ ⌕ Search…  │', '  ╰────────────╯', '',
      '  ❯ Написать рассказ об осени в лесу', '    1 minute ago · main · 41.7KB', '',
      '    Добавить счётчик кликов с localStorage', '    13 hours ago · main · 71.1KB', '',
      '  ↓ План добавления кнопки-счётчика на HTML', '    14 hours ago · main · 48.5KB', '',
      '    Ctrl+A to show all projects · Ctrl+B to only show current',
      '    branch · Space to preview · Ctrl+R to rename · Type to search',
      '    · Esc to cancel', '', '', '',
    ].join('\n');
    const r = scrapeResumePicker(buf)!;
    expect(r).not.toBeNull();
    expect(r.sessions.length).toBe(3);
    expect(r.total).toBe(41); // «(1 of 41)» — всего 41, видно 3 → карточка покажет «3 из 41»
    expect(r.sessions[0].name).toBe('Написать рассказ об осени в лесу');
    expect(r.sessions[0].selected).toBe(true);
    expect(r.sessions[2].name).toBe('План добавления кнопки-счётчика на HTML'); // ↓ снят
  });
  it('analyzeScreen: resumePicker распознан, menu не ложно-срабатывает', () => {
    const a = analyzeScreen(fx('resume-picker.txt'), 'default');
    expect(a.resumePicker).not.toBeNull();
    expect(a.menu).toBeNull();
    expect(a.alive).toBe(true);
  });
});

describe('analyzeScreen — busy / idle / режим / сжатие', () => {
  it('idle, режим default', () => {
    const a = analyzeScreen(fx('idle-default.txt'), 'default');
    expect(a.busy).toBe(false);
    expect(a.idleVisible).toBe(true);
    expect(a.mode).toBe('default');
    expect(a.menu).toBeNull();
  });

  it('idle в plan-режиме → mode=plan', () => {
    const a = analyzeScreen(fx('idle-plan-mode.txt'), 'default');
    expect(a.busy).toBe(false);
    expect(a.mode).toBe('plan');
  });

  it('busy (esc to interrupt) + живой статус', () => {
    const a = analyzeScreen(fx('busy-working.txt'), 'default');
    expect(a.busy).toBe(true);
    expect(a.workStatus).toContain('Caramelizing');
  });

  it('сжатие контекста = busy + полная строка статуса', () => {
    const a = analyzeScreen(fx('compacting.txt'), 'default');
    expect(a.busy).toBe(true);
    expect(a.workStatus).toBe('Compacting conversation… (3m 41s · ↑ 16.3k tokens)');
    expect(a.progress).toBeNull(); // токен-форма без бара → процента нет
  });

  it('compact с инлайн прогресс-баром: процент вынесен, лейбл очищен', () => {
    const line = '✻ Compacting conversation…▱▱▱▱▱▱▱▱▱▱0%──── simple-click-counter ──';
    expect(extractWorkStatus(line)).toBe('Compacting conversation…');
    expect(extractProgress(line)).toBe(0);
  });

  it('частично заполненный бар → числовой процент, без бара → null', () => {
    expect(extractProgress('✽ Running SessionStart hooks…… (35s)▰▰▰▰▰33%')).toBe(33);
    expect(extractProgress('Compacting conversation… (3m 41s · ↑ 16.3k tokens)')).toBeNull();
  });

  it('ошибки claude (API Error / сеть) → extractError + analyzeScreen.errorMsg', () => {
    expect(extractError('✶ Waiting for API response · will retry in 10s · check your network'))
      .toBe('Waiting for API response · will retry in 10s · check your network');
    expect(extractError('  API Error: 500 Internal server error. This is a server-side issue'))
      .toBe('API Error: 500 Internal server error. This is a server-side issue');
    expect(extractError('обычный экран без ошибок')).toBe('');
    const a = analyzeScreen('❯ привет\n✶ Waiting for API response · will retry in 5s · check your network\n  ? for shortcuts', 'default');
    expect(a.errorMsg).toContain('check your network');
  });

  it('старая ошибка УШЛА из хвоста (новый вывод снизу) → НЕ показываем (не «залипает»)', () => {
    // Разовая «API Error» в начале, потом claude дал много нового вывода → ошибка вне хвоста → гаснет.
    const lines = ['API Error: 500 server error'];
    for (let i = 0; i < 30; i++) lines.push(`строка ответа claude номер ${i} — всё хорошо, работаем дальше`);
    expect(extractError(lines.join('\n'))).toBe('');
  });

  it('голый спиннер «✶ Shenaniganing…» (plan-режим, без скобок/esc) → busy + workStatus', () => {
    // Реальный кадр из plan-flow: claude думает, показывая только глиф+слово+«…». Раньше busy=false.
    const buf = '❯ составь план\n\n✶ Shenaniganing…\n\n  ⏸ plan mode on (shift+tab to cycle)';
    const a = analyzeScreen(buf, 'plan');
    expect(a.busy).toBe(true);
    expect(a.workStatus).toBe('Shenaniganing…');
  });

  it('РЕАЛЬНЫЙ формат /compact (claude v2.1.185): бар на отдельной строке с пробелом перед %', () => {
    // Снято из живого лога: спиннер + лейбл, БАР отдельной строкой «▰▱…▱ 3%» (пробел перед %).
    const buf = '❯ /compact\n✽ Compacting conversation…\n  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 3%';
    expect(extractProgress(buf)).toBe(3);
    expect(extractWorkStatus('✶ Compacting conversation…')).toBe('Compacting conversation…');
  });

  it('меню НЕ ложно-срабатывает на нумерованном списке в ответе', () => {
    const a = analyzeScreen('● Вот ответ:\n  1. первый пункт\n  2. второй пункт\n\n  ? for shortcuts', 'default');
    expect(a.menu).toBeNull();
    expect(a.busy).toBe(false);
  });

  // claude 2.1.18x: "← for agents" вместо "? for shortcuts", busy без "esc to interrupt".
  it('idle claude 2.1.18x ("← for agents") → alive, не busy', () => {
    const a = analyzeScreen(fx('idle-agents.txt'), 'default');
    expect(a.alive).toBe(true);       // РАНЬШЕ было false → чат придерживал сообщения
    expect(a.busy).toBe(false);
    expect(a.idleVisible).toBe(true);
    expect(a.mode).toBe('default');
  });

  it('busy claude 2.1.18x (строка статуса с токенами, без "esc to interrupt") → busy', () => {
    const a = analyzeScreen(fx('busy-agents-tokens.txt'), 'default');
    expect(a.busy).toBe(true);        // РАНЬШЕ было false → «думает» не показывалось
    expect(a.workStatus).toContain('Billowing');
  });

  it('спиннер ВЫШЕ постоянного футера «← for agents» (claude 2.1.186) → busy (НЕ по позиции!)', () => {
    // Точный кейс «мышления с трудом»: таймер-спиннер у инпута, а idle-футер ВСЕГДА ниже него.
    // Прежняя логика «bi > idleIdx» давала busy=false. Теперь — по присутствию маркера в хвосте.
    const buf = [
      '❯ Напиши рассказ про осень', '✶ Skedaddling… (11s · ↓ 342 tokens)', '',
      '────────────', '❯ ', '────────────',
      '  Opus 4.8 (1M context) · ctx 5% (46k / 1000k)', '  ← for agents',
    ].join('\n');
    const a = analyzeScreen(buf, 'default');
    expect(a.busy).toBe(true);
    expect(a.workStatus).toContain('Skedaddling');
  });

  it('завершённый индикатор «✻ Brewed for 18s» (без «…») над футером → НЕ busy', () => {
    const buf = [
      '  текст ответа claude…', '✻ Brewed for 18s', '',
      '────────────', '❯ ', '────────────', '  ← for agents',
    ].join('\n');
    const a = analyzeScreen(buf, 'default');
    expect(a.busy).toBe(false); // «Brewed for 18s» без «…»/скобок-таймера — работа ЗАВЕРШЕНА
  });
});
