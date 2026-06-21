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
});
