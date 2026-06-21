// Регресс-тесты детектора экрана claude на КОРПУСЕ ФИКСТУР (реальные гриды, снятые с
// claude 2.1.175). Любой новый нюанс → фикстура в claudeScreen.fixtures/ + кейс здесь.
// Зелёный тест на Windows = зелёный в проде на Linux (модуль один и тот же).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scrapeMenu, analyzeScreen } from './claudeScreen';

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
});
