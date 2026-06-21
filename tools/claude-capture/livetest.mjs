// Живой тест паритета: спавнит НАСТОЯЩИЙ claude через node-pty с изолированным CLAUDE_CONFIG_DIR
// (где зарегистрированы наши хуки) + env хука → claude должен дёрнуть хуки → POST на мок.
// Аргументы: <CLAUDE_CONFIG_DIR> <cwd> <screenDumpPath>
import * as pty from 'node-pty';
import { execSync } from 'child_process';
import { writeFileSync, readdirSync, existsSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');

function resolveClaude() {
  if (process.platform !== 'win32') return 'claude';
  const la = process.env.LOCALAPPDATA || '';
  // РЕАЛЬНЫЙ бинарь WinGet (не 0-байтный алиас в Links, который node-pty не запускает).
  const pkgs = `${la}\\Microsoft\\WinGet\\Packages`;
  try {
    for (const d of readdirSync(pkgs)) {
      if (/Anthropic\.ClaudeCode/i.test(d)) {
        const exe = `${pkgs}\\${d}\\claude.exe`;
        if (existsSync(exe)) return exe;
      }
    }
  } catch { /* нет каталога Packages — пробуем дальше */ }
  try {
    const p = execSync('where claude', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (p) return p;
  } catch { /* where не нашёл */ }
  return `${la}\\Microsoft\\WinGet\\Links\\claude.exe`;
}
const CLAUDE = resolveClaude();
console.error('[livetest] CLAUDE =', CLAUDE);

const env = { ...process.env };
for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
env.CLAUDE_CONFIG_DIR = process.argv[2];
env.NEBULIDE_HOOK_TOKEN = 'live-tok';
env.NEBULIDE_HOOK_URL = 'http://localhost:18080/api/hooks/claude';
env.NEBULIDE_INSTANCE_ID = 'live-1';
const dump = process.argv[4];

let p;
try {
  p = pty.spawn(CLAUDE, [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.argv[3], env });
} catch (e) { console.error('[livetest] spawn FAILED:', e.message); process.exit(1); }

let buf = '';
p.onData((d) => { buf += d; });
p.onExit((e) => console.error('[livetest] claude exited code=', e.exitCode));

(async () => {
  await sleep(9000);
  if (dump) writeFileSync(dump, stripAnsi(buf).split('\n').filter((l) => l.trim()).slice(-25).join('\n'));
  p.write('1');
  await sleep(2500);
  p.write('\x1b[200~привет одним словом\x1b[201~');
  await sleep(150); p.write('\r');
  await sleep(13000);
  if (dump) writeFileSync(dump + '.2', stripAnsi(buf).split('\n').filter((l) => l.trim()).slice(-25).join('\n'));
  try { p.kill(); } catch { /* */ }
  process.exit(0);
})().catch((e) => { console.error('[livetest] runtime:', e); process.exit(1); });
