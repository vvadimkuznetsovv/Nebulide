// Харнесс захвата состояний Claude Code.
//
// Спавнит НАСТОЯЩИЙ claude через node-pty (ConPTY на Windows / PTY на Linux), прогоняет его
// вывод через @xterm/headless (ТОТ ЖЕ рендер, что в проде — xtermScreenText), шлёт
// скриптованные клавиши и снимает рендер-грид → фикстура для claudeScreen.test.ts.
//
// Запуск:   node capture.mjs <scenario>            — печатает снапшот(ы)
//           SAVE=1 node capture.mjs <scenario>     — ещё и пишет в claudeScreen.fixtures/
//           node capture.mjs --list                — список сценариев
//
// Требует установленного и залогиненного claude (та же auth, что у обычного CLI).
// claude запускается в одноразовой temp-папке, проект не трогается.

import * as pty from 'node-pty';
import headlessPkg from '@xterm/headless'; // CommonJS-модуль → default-импорт
const { Terminal } = headlessPkg;
import { writeFileSync, mkdtempSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const COLS = 120, ROWS = 44;
// claude на Windows ставится как .exe в WinGet Links — резолвим полный путь через where.
function resolveClaude() {
  if (process.platform !== 'win32') return 'claude';
  try { return execSync('where claude', { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || 'claude.exe'; }
  catch { return 'claude.exe'; }
}
const CLAUDE = resolveClaude();
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
const FIX_DIR = new URL('../../frontend/src/components/terminal/claudeScreen.fixtures/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Снимок рендер-грида — РОВНО как xtermScreenText() в проде (translateToString по строкам).
function snapshot(term) {
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) {
    const ln = b.getLine(y);
    out.push(ln ? ln.translateToString(true) : '');
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

// Сценарий: args для claude + шаги. Шаг: {wait}|{key}|{prompt}|{snap}.
const SCENARIOS = {
  'permission-write-3opt': {
    args: [],
    steps: [{ wait: 9000 }, { key: '1' }, { wait: 2500 },
      { prompt: 'Создай файл cal.txt с одним словом hello' }, { wait: 9000 }, { snap: 'permission-write-3opt' }],
  },
  'permission-bash-2opt': {
    args: [],
    steps: [{ wait: 9000 }, { key: '1' }, { wait: 2500 },
      { prompt: 'Выполни ровно эту bash-команду и ничего больше: V=$(echo test) && echo $V' }, { wait: 9000 }, { snap: 'permission-bash-2opt' }],
  },
  'plan-menu': {
    args: ['--permission-mode', 'plan'],
    steps: [{ wait: 9000 }, { key: '1' }, { wait: 2500 },
      { prompt: 'Составь короткий план как добавить файл ping.txt со словом pong. Просто план, ничего не делай.' },
      { wait: 28000 }, { snap: 'plan-menu' }],
  },
};

async function run() {
  const name = process.argv[2];
  if (!name || name === '--list') {
    console.log('Сценарии:', Object.keys(SCENARIOS).join(', '));
    process.exit(name ? 0 : 1);
  }
  const sc = SCENARIOS[name];
  if (!sc) { console.error('Неизвестный сценарий:', name, '— есть:', Object.keys(SCENARIOS).join(', ')); process.exit(1); }

  const cwd = mkdtempSync(join(tmpdir(), 'claude-cap-'));
  // Снимаем маркеры родительской claude-сессии — иначе вложенный запуск блокируется
  // («cannot be launched inside another Claude Code session»).
  const env = { ...process.env };
  for (const k of Object.keys(env)) { if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]; }
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const p = pty.spawn(CLAUDE, sc.args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env });
  p.onData((d) => term.write(d));

  for (const step of sc.steps) {
    if (step.wait) await sleep(step.wait);
    if (step.key) p.write(step.key);
    if (step.prompt) { p.write(PASTE_START + step.prompt + PASTE_END); await sleep(60); p.write('\r'); }
    if (step.snap) {
      const text = snapshot(term);
      console.log(`\n===== SNAPSHOT [${step.snap}] =====\n${text}\n===== /SNAPSHOT =====`);
      if (process.env.SAVE) {
        writeFileSync(new URL(`${step.snap}.txt`, FIX_DIR), text + '\n');
        console.log(`→ сохранено в фикстуры: ${step.snap}.txt`);
      }
    }
  }
  try { p.kill(); } catch { /* ignore */ }
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
