// Серверная ОС (где живёт PTY) — НУЖНА для построения shell-команд запуска claude. На Windows
// шелл = PowerShell 5.1: там НЕТ `&&` и `mkdir -p` (они валятся: «&& не является разделителем»).
// Поэтому команды «открыть чат в папке» / «resume сессии» строим по ОС: PowerShell (;, New-Item,
// Set-Location) или Unix (&&, mkdir -p, cd). ОС берём из /api/health (бэкенд отдаёт runtime.GOOS).
let serverOs: string | null = null;

export async function fetchServerOs(): Promise<string> {
  if (serverOs) return serverOs;
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    serverOs = (d && d.os) || 'linux';
  } catch {
    serverOs = 'linux';
  }
  return serverOs as string;
}

export function getServerOs(): string { return serverOs || 'linux'; }
export function isWindowsServer(): boolean { return getServerOs() === 'windows'; }

/** Команда: перейти в папку (если задана) и выполнить claude-команду (`claude` или `claude --resume <id>`).
 *  Простой `cd` + запуск. Папку гарантирует бэкенд (createLocked делает MkdirAll), поэтому mkdir тут не нужен.
 *  Разделитель под ОС: bash — `&&` (claude не запустится, если cd упал), PowerShell 5.1 — `;` (там нет `&&`). */
export function buildCdClaudeCmd(absPath: string | undefined, claudeCmd: string): string {
  if (!absPath) return claudeCmd;
  if (isWindowsServer()) return `cd "${absPath}"; ${claudeCmd}`;
  return `cd "${absPath}" && ${claudeCmd}`;
}
