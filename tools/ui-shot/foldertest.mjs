// ТОЧЕЧНЫЙ тест резолва сессии по ПАПКЕ (баг «открыл новую папку — показалась старая сессия
// чужой»). Две подпапки workspace, в каждой своя сессия. Резолв по cwd ОБЯЗАН вернуть сессию
// ИМЕННО этой папки, а пустая папка → НЕ глобально-новейшую (пусто). API-уровень, детерминир.
const API = 'http://localhost:8080/api';
const results = [];
const ok = (n, pass, extra = '') => { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };

// 1) логин
const lr = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin12345' }) });
const lj = await lr.json();
const token = lj.access_token || lj.token || lj.accessToken;
if (!token) { console.log('НЕТ токена:', JSON.stringify(lj).slice(0, 200)); process.exitCode = 1; }

const resolve = async (cwd) => {
  const u = new URL(`${API}/claude-sessions/live`);
  u.searchParams.set('instanceId', 'foldertest-' + Math.random().toString(36).slice(2, 7));
  if (cwd) u.searchParams.set('cwd', cwd);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
};

// аргументы: пути папок A,B,EMPTY и ожидаемые слаги — передаются из bash
const [cwdA, cwdB, cwdEmpty, slugA, slugB] = process.argv.slice(2);

const rA = await resolve(cwdA);
const rB = await resolve(cwdB);
const rE = await resolve(cwdEmpty);
console.log('  A →', rA.project, rA.session_file?.slice(0, 8));
console.log('  B →', rB.project, rB.session_file?.slice(0, 8));
console.log('  EMPTY →', rE.project || '(пусто)', rE.session_file?.slice(0, 8) || '');

ok('резолв cwd=A вернул сессию ПАПКИ A', rA.project === slugA && !!rA.session_file, rA.project);
ok('резолв cwd=B вернул сессию ПАПКИ B', rB.project === slugB && !!rB.session_file, rB.project);
ok('cwd=A НЕ подменился новейшей B (cwd-специфичность)', rA.project === slugA && rA.project !== slugB);
ok('пустая папка → НЕ глобально-новейшая чужая сессия (пусто)', !rE.session_file, rE.project || 'пусто');

console.log(`\n=== ИТОГ folder-resolve: ${results.filter(Boolean).length}/${results.length} ===`);
process.exitCode = results.every(Boolean) ? 0 : 1;
