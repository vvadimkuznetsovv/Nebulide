// Идемпотентно обеспечивает наличие ОТДЕЛЬНЫХ тест-пользователей (tester1/tester2) для
// изолированных параллельных тестов. КРИТИЧНО: тесты, меняющие воркспейс/раскладку, НЕЛЬЗЯ гонять
// под admin — изменения через cross-device sync уйдут в ЖИВУЮ сессию пользователя (закроют панели
// и т.п.). admin используем ТОЛЬКО для создания инвайта через API (раскладку это не трогает).
// Создание: логин admin → POST /api/admin/invites → POST /api/auth/register. Через global fetch (Node 18+).
const API = process.env.API || 'http://localhost:8080';
export const ADMIN = { username: 'admin', password: 'admin12345' };
export const TESTER1 = { username: 'tester1', password: 'tester12345' };
export const TESTER2 = { username: 'tester2', password: 'tester12345' };
// tester3 НУЖЕН для 3 ПАРАЛЛЕЛЬНЫХ claude: терминал на бэке = `term:{userID}:{instanceId}` (по ЮЗЕРУ,
// НЕ по workspace) → два окна ОДНОГО юзера дерутся за один терминал (WS Connection error). 3 разных
// юзера = 3 своих терминала = 3 параллельных claude.
export const TESTER3 = { username: 'tester3', password: 'tester12345' };

async function login(creds) {
  try {
    const r = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function ensureUser(creds) {
  const existing = await login(creds);
  if (existing && existing.access_token) return creds; // уже есть
  const adm = await login(ADMIN);
  if (!adm || !adm.access_token) throw new Error('ensureUser: admin login failed (проверь admin/admin12345 и бэк :8080)');
  const inv = await fetch(`${API}/api/admin/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adm.access_token}` },
    body: JSON.stringify({ expires_in_hours: 72 }),
  });
  const invd = await inv.json().catch(() => ({}));
  const code = invd.code || invd.Code;
  if (!code) throw new Error('ensureUser: invite create failed: ' + JSON.stringify(invd));
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password, invite_code: code }),
  });
  if (!reg.ok) {
    const e = await reg.json().catch(() => ({}));
    if (!/taken/i.test(JSON.stringify(e))) console.warn('[ensureUser] register warn:', JSON.stringify(e));
  }
  return creds;
}

export async function ensureTesters() {
  await ensureUser(TESTER1);
  await ensureUser(TESTER2);
  await ensureUser(TESTER3);
  return [TESTER1, TESTER2, TESTER3];
}

// Гарантировать именованный workspace у юзера (создать если нет) → вернуть его id. Нужно для
// «2 разных workspace с одного аккаунта»: каждое окно грузится в СВОЙ ws (инъекция localStorage),
// разные ws → нет лока, а уникальный claude-инстанс из окна Chat → нет коллизии терминала.
export async function ensureWorkspace(creds, name) {
  const lr = await login(creds);
  if (!lr?.access_token) throw new Error('ensureWorkspace: login failed ' + creds.username);
  const t = lr.access_token;
  const list = await (await fetch(`${API}/api/workspace-sessions`, { headers: { Authorization: `Bearer ${t}` } })).json().catch(() => []);
  let ws = Array.isArray(list) ? list.find((s) => s.name === name) : null;
  if (!ws) {
    const cr = await fetch(`${API}/api/workspace-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ name, device_tag: 'Desktop', snapshot: {} }) });
    ws = await cr.json();
  }
  return ws.id;
}

// CLI: node lib/users.mjs — создать tester1/tester2/tester3.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('lib/users.mjs')) {
  ensureTesters().then((t) => console.log('testers готовы:', t.map((x) => x.username))).catch((e) => { console.error(e.message); process.exit(1); });
}
