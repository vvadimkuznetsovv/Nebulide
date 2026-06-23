import { useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { resolveLiveSession, tailClaudeSession } from '../../api/claudeSessions';
import type { RichMessage } from '../../api/claudeSessions';
import { sendToTerminal, submitPromptToTerminal, getTerminalScreenState } from './Terminal';
import { onActivity } from '../../utils/activityBus';
import { getSessionHint } from '../../utils/terminalViewMode';
import { listFiles } from '../../api/files';
import { listSkills } from '../../api/skills';
import ClaudeMessage from '../chat/ClaudeMessage';
import ReactMarkdown from 'react-markdown';

// "Чат" — тонкая обёртка над живым `claude` в PTY: лента из JSONL, действия → клавиши в PTY.
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

interface Props {
  instanceId: string;
  cwd?: string;
  /** Показать настоящий экран терминала (родные меню: permission / rewind / resume). */
  onRequestTerminal?: () => void;
  /** Слот переключателей вида (Терминал/Чат) — встраивается ПЕРВЫМ в строку инструментов чата,
   *  чтобы переключатели и инструменты жили в ОДНОЙ строке. */
  toggle?: ReactNode;
}

interface PermOption { digit: string; label: string; raw: string; desc?: string; checked?: boolean }
interface PermReq { kind?: 'permission' | 'question' | ''; multi?: boolean; question?: string; detail?: string; options: PermOption[]; tool?: string; input?: unknown; tabs?: { label: string; done: boolean }[]; isPlan?: boolean }

// Tail-кэш на instanceId (переживает перемонтирование вида).
interface TailCache { project: string; sessionFile: string; sessionId: string; cwd?: string; offset: number; messages: RichMessage[] }
const tailCache = new Map<string, TailCache>();
// instanceId, для которых claude уже хоть раз показал готовность (hook/экран). Module-level —
// переживает перемонтирование вида; решает «отправка до готовности claude теряется».
const readyInstances = new Set<string>();
// Черновик ввода на instanceId — переживает переключение вида (Чат↔Терминал размонтирует компонент).
const draftInputs = new Map<string, string>();
// Живой контекст/токены из statusLine на instanceId — переживает смену вида.
interface ContextInfo { used?: number; tin?: number; size?: number; model?: string; cost?: number }
const contextCache = new Map<string, ContextInfo>();
// Цвет индикатора контекста: нейтральный → жёлтый (65%+) → красный (85%+, близко к авто-сжатию).
function ctxColor(p: number): string { return p >= 85 ? 'var(--danger)' : p >= 65 ? '#e0b341' : 'var(--text-muted)'; }
function fmtTokens(n: number): string { return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n); }
const POLL_MS = 1200;
const plainText = (m: RichMessage) => m.blocks.filter(b => b.kind === 'text').map(b => b.text || '').join('\n').trim();

// Активное @-упоминание файла: последний '@' перед курсором, без пробелов после него,
// и сам '@' в начале или после пробела. Возвращает позицию '@' и текст-запрос после него.
function detectMention(value: string, cursor: number): { start: number; query: string } | null {
  const head = value.slice(0, cursor);
  const at = head.lastIndexOf('@');
  if (at < 0) return null;
  const between = head.slice(at + 1);
  if (/\s/.test(between)) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null;
  return { start: at, query: between };
}

// Слэш-команды Claude Code (снято с /меню claude 2.1.175). Палитра лишь вставляет
// текст в ввод — отправляется в PTY как обычная команда, поэтому список не ограничивает.
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/clear', desc: 'Новая сессия — очистить контекст (прошлая сохраняется, /resume)' },
  { cmd: '/compact', desc: 'Сжать контекст: резюме разговора' },
  { cmd: '/context', desc: 'Показать использование контекста (сетка)' },
  { cmd: '/usage', desc: 'Лимиты и использование плана' },
  { cmd: '/cost', desc: 'Стоимость/токены текущей сессии' },
  { cmd: '/effort', desc: 'Усилие мышления: low / medium / high / max' },
  { cmd: '/model', desc: 'Выбрать модель Claude' },
  { cmd: '/resume', desc: 'Возобновить прошлый разговор' },
  { cmd: '/rewind', desc: 'Откатить код и/или разговор к точке' },
  { cmd: '/review', desc: 'Ревью изменений' },
  { cmd: '/diff', desc: 'Незакоммиченные изменения и диффы по ходам' },
  { cmd: '/init', desc: 'Создать файл CLAUDE.md для проекта' },
  { cmd: '/memory', desc: 'Открыть файл памяти' },
  { cmd: '/agents', desc: 'Управление субагентами' },
  { cmd: '/mcp', desc: 'Управление MCP-серверами' },
  { cmd: '/permissions', desc: 'Правила разрешений (allow/deny)' },
  { cmd: '/plan', desc: 'Режим плана / текущий план сессии' },
  { cmd: '/status', desc: 'Статус Claude Code (версия, модель, аккаунт)' },
  { cmd: '/config', desc: 'Открыть настройки' },
  { cmd: '/skills', desc: 'Список доступных скиллов' },
  { cmd: '/plugin', desc: 'Управление плагинами' },
  { cmd: '/copy', desc: 'Скопировать последний ответ Claude' },
  { cmd: '/recap', desc: 'Краткое резюме сессии одной строкой' },
  { cmd: '/rename', desc: 'Переименовать текущий разговор' },
  { cmd: '/branch', desc: 'Создать ветку разговора в этой точке' },
  { cmd: '/export', desc: 'Экспортировать разговор' },
  { cmd: '/add-dir', desc: 'Добавить рабочую папку' },
  { cmd: '/vim', desc: 'Включить vim-режим ввода' },
  { cmd: '/help', desc: 'Справка по командам' },
];

// Скиллы Claude Code вызываются как слэш-команды. Список — из реального скана папок через API
// (api/skills): «свои» (.md в {workspace}/.claude/skills) + «claude» (плагины/бандл). См. ownSkills/claudeSkills.

// Нормализация пути для сравнения папок (cross-OS): '\' → '/', схлопнуть слэши, убрать
// хвостовой '/', привести к нижнему регистру (Windows регистронезависим).
function normFolder(p?: string): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

// Та же папка? Пустые значения трактуем как «совпадает» — нечего ребиндить, если папка
// неизвестна (бэкенд tier3 отдаёт пустой cwd). Сравниваем только когда обе известны.
function sameFolder(a?: string, b?: string): boolean {
  const na = normFolder(a), nb = normFolder(b);
  if (!na || !nb) return true;
  return na === nb;
}

// Подсветка ввода (оверлей-зеркало над textarea): ведущая /команда и @-файлы — цветные.
function renderInputHighlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  const cm = text.match(/^\/[a-zA-Z0-9_-]+/);
  if (cm) {
    nodes.push(<span key="cmd" style={{ color: 'var(--accent-bright)', fontWeight: 600 }}>{cm[0]}</span>);
    rest = text.slice(cm[0].length);
  }
  rest.split(/(@[^\s]+)/g).forEach((p, i) => {
    if (p.startsWith('@') && p.length > 1) nodes.push(<span key={'m' + i} style={{ color: 'var(--accent-bright)' }}>{p}</span>);
    else if (p) nodes.push(<span key={'t' + i}>{p}</span>);
  });
  nodes.push('​'); // якорь высоты для хвостового переноса
  return nodes;
}

// Активная слэш-команда: ввод начинается с '/', курсор внутри слова команды (до пробела).
function detectCommand(value: string, cursor: number): { query: string } | null {
  if (!value.startsWith('/')) return null;
  const sp = value.indexOf(' ');
  if (sp >= 0 && cursor > sp) return null; // курсор уже в аргументах
  return { query: value.slice(1, sp >= 0 ? sp : value.length) };
}

function mergeMsgs(prev: RichMessage[], inc: RichMessage[]): RichMessage[] {
  if (!inc.length) return prev;
  // Реальное user-сообщение из JSONL пришло → убрать оптимистичный плейсхолдер с тем же текстом.
  const incUserText = new Set(inc.filter(m => m.role === 'user').map(plainText));
  const base = incUserText.size
    ? prev.filter(m => !(m.uuid.startsWith('optimistic-') && incUserText.has(plainText(m))))
    : prev;
  const seen = new Set(base.map(m => m.uuid));
  const add = inc.filter(m => m.uuid && !seen.has(m.uuid));
  return add.length || base.length !== prev.length ? [...base, ...add] : prev;
}

const FONT_KEY = 'nebulide-agent-font-size';

// Permission modes — shown as a footer label under the input, colored per mode.
// Точный порядок Shift+Tab-цикла claude 2.1.x (выверено на сервере):
// default → acceptEdits → plan → auto → default. bypassPermissions/dontAsk — вне цикла
// (только через флаги), но могут прийти в hook permission_mode, поэтому есть в карте меток.
const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

const MODE_INFO: Record<PermissionMode, { label: string; color: string }> = {
  default: { label: 'Обычный', color: 'var(--text-muted)' },
  acceptEdits: { label: 'Авто-правки', color: 'var(--accent-bright)' },
  plan: { label: 'План', color: 'var(--success)' },
  auto: { label: 'Авто', color: 'var(--warning)' },
  dontAsk: { label: 'Не спрашивать', color: 'var(--warning)' },
  bypassPermissions: { label: 'Без ограничений', color: 'var(--danger)' },
};

// Полная деталь permission из ХУКА (tool_input) — точная неусечённая команда/путь,
// в отличие от скрейпа экрана (может обрезаться). Для Bash → весь command целиком.
function permInputText(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'url', 'pattern', 'prompt']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return '';
}

function messageText(m: RichMessage): string {
  return m.blocks.map(b => b.text || b.content || b.name || '').join(' ').toLowerCase();
}

export default function ClaudeChatView({ instanceId, cwd, onRequestTerminal, toggle }: Props) {
  const [messages, setMessages] = useState<RichMessage[]>(() => tailCache.get(instanceId)?.messages ?? []);
  const [perm, setPerm] = useState<PermReq | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'working' | 'error' | 'closed'>('connecting');
  const [workStatus, setWorkStatus] = useState(''); // живой статус из экрана: "Caramelizing… (5s · ↑ 87 tokens)"
  const [error, setError] = useState(''); // ошибка/сетевая проблема claude (API Error / network) — красная карточка
  const [progress, setProgress] = useState<number | null>(null); // прогресс длинной операции (compact/hooks) 0..100, иначе null
  const [resumeMenu, setResumeMenu] = useState<{ info: string } | null>(null); // блокирующее меню "как восстановить"
  const [resumePicker, setResumePicker] = useState<{ sessions: { name: string; meta: string }[]; selectedIndex: number; total: number } | null>(null); // /resume — список сессий
  const [ctx, setCtx] = useState<ContextInfo | undefined>(() => contextCache.get(instanceId)); // живой контекст/токены
  const [input, setInput] = useState(() => draftInputs.get(instanceId) || '');
  const [pillCollapsed, setPillCollapsed] = useState(false);
  // @-упоминания файлов: автокомплит по дереву cwd
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<{ name: string; is_dir: boolean }[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  // Палитра слэш-команд: cmd — активный ввод команды; cmdOpen — открыта кнопкой (показать все).
  const [cmd, setCmd] = useState<{ query: string } | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(false);
  // Скиллы из реального скана (api/skills): свои (.md в workspace) + claude (плагины/бандл).
  const [ownSkills, setOwnSkills] = useState<{ cmd: string; desc: string }[]>([]);
  const [claudeSkills, setClaudeSkills] = useState<{ cmd: string; desc: string }[]>([]);
  // Drill-down навигация выпадашки (кнопкой): root → commands | skills → own | claude.
  const [paletteNav, setPaletteNav] = useState<'root' | 'commands' | 'skills' | 'own' | 'claude'>('root');
  const [paletteSearch, setPaletteSearch] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [fontPx, setFontPx] = useState(() => {
    const v = parseInt(localStorage.getItem(FONT_KEY) || '13', 10);
    return v >= 11 && v <= 20 ? v : 13;
  });
  const [listening, setListening] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null); // bottom overlay (absolute, auto height)
  const footerRef = useRef<HTMLDivElement | null>(null);   // mode line — collapses with scroll
  const rawRef = useRef(1);            // 1 = expanded, 0 = minimum (one row, footer hidden)
  const rafRef = useRef(0);            // throttle scroll → one update per frame
  const lastTopRef = useRef(0);        // previous scrollTop (for direction delta)
  const ignoreRef = useRef(false);     // ignore self-induced (resize clamp) scroll
  const contentHRef = useRef(38);      // cached textarea content height (avoids per-frame reflow)
  const stick = useRef(true);
  const pillRef = useRef({ x: 0, moved: false }); // swipe state for the stop button
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const inputBaseRef = useRef('');

  const cInit = tailCache.get(instanceId);
  const targetRef = useRef<{ project: string; sessionFile: string; offset: number; sessionId: string; cwd?: string } | null>(
    // offset из кэша берём ТОЛЬКО если есть кэш-сообщения, иначе 0 — иначе восстановимся
    // «в конце файла» без сообщений и чат будет пустым (хотя сессия полная).
    cInit ? { project: cInit.project, sessionFile: cInit.sessionFile, offset: cInit.messages?.length ? cInit.offset : 0, sessionId: cInit.sessionId, cwd: cInit.cwd } : null
  );
  const pollingRef = useRef(false);
  const emptyReloadRef = useRef(false); // один форс full-reload на сессию при offset>0 без сообщений
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // claude может ещё грузиться (~2-3с после запуска) — не теряем первое сообщение:
  // показываем оптимистично, но шлём в PTY, только когда claude реально готов
  // (детектор экрана busy/idle или hook). pendingSend — отложенный текст.
  const pendingSendRef = useRef<string | null>(null);
  // Свободный ответ на меню («Tell Claude what to change» / «Type something»): после активации
  // claude в ТЕКСТОВОМ режиме, но план/меню ещё на экране → гейт menuUp заблокировал бы отправку.
  // Флаг говорит submit: следующий текст слать НЕСМОТРЯ на видимое меню (мы сами в него вошли).
  const freeTextRef = useRef(false);
  // Инлайн-фидбэк по плану: клик «Tell Claude what to change» НЕ закрывает карточку и НЕ лезет в
  // нижний композер — раскрывает поле ПОД кнопками прямо в карточке плана (план остаётся виден).
  // null = закрыто; строка = открыто (текущий текст). Ref — чтобы 250мс-опрос «пиннил» карточку.
  const [planFb, setPlanFbState] = useState<string | null>(null);
  const planFbRef = useRef<string | null>(null);
  const setPlanFb = useCallback((v: string | null) => { planFbRef.current = v; setPlanFbState(v); }, []);
  // Анти-дубль: setInput('') асинхронен, поэтому быстрый повтор Enter (автоповтор/двойное
  // нажатие) брал бы один и тот же input из замыкания → два сабмита. Гасим повтор того же
  // текста в окне 1.5с.
  const lastSubmitRef = useRef<{ text: string; t: number }>({ text: '', t: 0 });
  // Детали последнего запроса доступа из хука (tool + input) — обогащают карточку,
  // видимостью которой управляет ЭКРАН (надёжно, не теряется при ремоунте).
  const permDetailsRef = useRef<{ tool?: string; input?: unknown } | null>(null);

  // Send raw bytes (keystrokes) to the live PTY.
  const sendKey = useCallback((data: string) => { sendToTerminal(instanceId, data); }, [instanceId]);

  const persist = useCallback(() => {
    const t = targetRef.current;
    if (t) tailCache.set(instanceId, { project: t.project, sessionFile: t.sessionFile, sessionId: t.sessionId, cwd: t.cwd, offset: t.offset, messages: messagesRef.current });
  }, [instanceId]);

  // ── Poll the JSONL tail (incremental; rewind → full reload via parent_uuid break) ──
  const poll = useCallback(async (full = false): Promise<void> => {
    const t = targetRef.current;
    if (!t || pollingRef.current) return;
    // offset>0, но сообщений нет → закэшированный offset «съел» полную загрузку (чат пустой,
    // хотя сессия полная). Принудительный full-reload подтянет активную ветку с offset=0.
    // Гард: один раз на сессию (сбрасывается в reconcile) — чтобы не зациклить на реально
    // пустой ветке.
    if (!full && t.offset > 0 && messagesRef.current.length === 0 && !emptyReloadRef.current) {
      emptyReloadRef.current = true;
      return poll(true);
    }
    pollingRef.current = true;
    try {
      const { data } = await tailClaudeSession(t.project, t.sessionFile, full ? 0 : t.offset);
      t.offset = data.offset;
      if (data.session_id) t.sessionId = data.session_id;
      if (!data.messages.length) return;
      const sc = scrollRef.current;
      stick.current = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
      if (full) {
        // Сохраняем оптимистичные плейсхолдеры, чьё реальное сообщение ещё НЕ в JSONL —
        // иначе только что отправленный текст пропадает из чата (а в терминале есть).
        const reUser = new Set(data.messages.filter(m => m.role === 'user').map(plainText));
        const keptOpt = messagesRef.current.filter(m => m.uuid.startsWith('optimistic-') && !reUser.has(plainText(m)));
        const next = keptOpt.length ? [...data.messages, ...keptOpt] : data.messages;
        messagesRef.current = next;
        setMessages(next);
        return;
      }
      const cur = messagesRef.current;
      const first = data.messages[0];
      // Игнорируем оптимистичные плейсхолдеры при rewind-детекции — иначе их uuid
      // (optimistic-*) рвёт цепочку parent_uuid и вызывает лишний full-reload на каждой отправке.
      const real = cur.filter(m => !m.uuid.startsWith('optimistic-'));
      const lastUuid = real.length ? real[real.length - 1].uuid : '';
      const known = new Set(real.map(m => m.uuid));
      if (real.length > 0 && first.parent_uuid && lastUuid && first.parent_uuid !== lastUuid && !known.has(first.uuid)) {
        pollingRef.current = false;
        return poll(true);
      }
      setMessages(prev => mergeMsgs(prev, data.messages));
    } catch { /* transient */ }
    finally { pollingRef.current = false; persist(); }
  }, [persist]);

  // Привязать вид к сессии: записываем cwd (из ответа бэка, иначе — папка терминала),
  // сбрасываем offset/empty-guard, чистим оптимистичные плейсхолдеры (kept), грузим ленту.
  const bindSession = useCallback((data: { project: string; session_file: string; session_id: string; cwd?: string }) => {
    tailCache.delete(instanceId);
    targetRef.current = { project: data.project, sessionFile: data.session_file, offset: 0, sessionId: data.session_id || '', cwd: data.cwd || cwd };
    const keptOpt = messagesRef.current.filter(m => m.uuid.startsWith('optimistic-'));
    messagesRef.current = keptOpt; // синхронно, чтобы параллельный poll не подмешал старую сессию
    setMessages(keptOpt);
    emptyReloadRef.current = false;
    setStatus('ready');
    poll(true);
  }, [instanceId, cwd, poll]);

  // Пересвязать вид с папкой терминала. rebind(null) сбрасывает текущую привязку →
  // следующий reconcile() резолвит сессию для актуального cwd заново (смена папки).
  // (Параметр зарезервирован: непустой id в будущем мог бы привязать конкретную сессию;
  // сейчас любой вызов сбрасывает привязку, а reconcile резолвит правильную сессию.)
  const rebind = useCallback((_sessionId: string | null) => {
    targetRef.current = null;
    emptyReloadRef.current = false;
  }, []);

  // ── Resolve + keep reconciling which JSONL this terminal's claude writes ──
  // Backend tier-1 (hook-tracked instanceId→session) даёт ТОЧНУЮ сессию (непустой
  // session_id) и переопределяет слабый cwd/новейший фолбэк. Резолвим периодически,
  // НЕ завязываясь на разовое событие хука: чинит «два терминала тянут одну историю»
  // и следует за перезапуском claude / сменой сессии (--resume) в том же терминале.
  const reconcile = useCallback(async () => {
    try {
      const { data } = await resolveLiveSession(instanceId, cwd, getSessionHint(instanceId));
      if (!data.session_file) return;
      const cur = targetRef.current;
      const authoritative = !!data.session_id; // непустой = точная сессия из хука
      // Смена ПАПКИ терминала: привязанная сессия из другой папки (известны обе) →
      // принудительный ребинд на сессию актуального cwd. Срабатывает и при первом
      // открытии вида в другой папке (cur уже из кэша другой папки).
      const folderChanged = !!cur && !!data.cwd && !sameFolder(cur.cwd, data.cwd);
      if (folderChanged) {
        rebind(null);
        bindSession(data);
      } else if (!cur) {
        bindSession(data);
      } else if (authoritative && data.session_id !== cur.sessionId) {
        // tier-1 указал другую сессию (чужой фолбэк / перезапуск) → переключаемся.
        bindSession(data);
      }
    } catch { /* claude ещё не стартовал — ретраим */ }
  }, [instanceId, cwd, rebind, bindSession]);

  // Сброс чата: очистить ленту/кэш и пересвязаться с папкой терминала (reconcile подтянет).
  const resetChat = useCallback(() => {
    tailCache.delete(instanceId);
    draftInputs.delete(instanceId);
    rebind(null);
    messagesRef.current = [];
    setMessages([]);
    setInput('');
    setPerm(null);
    setResumeMenu(null);
    setStatus('connecting');
    reconcile();
  }, [instanceId, rebind, reconcile]);

  useEffect(() => {
    // Авто-ребинд ПРИ ОТКРЫТИИ вида: если папка терминала (cwd) не совпадает с папкой
    // привязанной (кэшированной) сессии — сбрасываем привязку, чтобы reconcile() ниже
    // переразрешил сессию для правильной папки.
    const cur = targetRef.current;
    if (cur && cwd && !sameFolder(cur.cwd, cwd)) rebind(null);
    reconcile();
    const iv = setInterval(reconcile, 3000);
    return () => { clearInterval(iv); recognitionRef.current?.abort(); };
  }, [reconcile, cwd, rebind]);

  useEffect(() => {
    poll();
    const id = setInterval(() => poll(), POLL_MS);
    return () => clearInterval(id);
  }, [status, poll]);

  // ── Hooks: только session-reconcile, режим и ДЕТАЛИ permission. Состояние экрана
  //    (busy/idle/think/меню/permission-видимость) берём из частого ОПРОСА ниже. ──
  useEffect(() => {
    return onActivity((e) => {
      // Живой контекст/токены из statusLine.
      if (e.type === 'claude_status') {
        if (e.instanceId !== instanceId) return;
        const c = { used: e.usedPercentage, tin: e.totalInputTokens, size: e.contextWindowSize, model: e.model, cost: e.costUsd };
        contextCache.set(instanceId, c);
        setCtx(c);
        return;
      }
      if (e.type !== 'claude_hook' || e.instanceId !== instanceId) return;
      if (e.sessionId && e.sessionId !== targetRef.current?.sessionId) reconcile();
      if (e.permissionMode && e.permissionMode in MODE_INFO) setMode(e.permissionMode as PermissionMode);
      if (e.event === 'PermissionRequest' || (e.event === 'Notification' && e.tool)) {
        permDetailsRef.current = { tool: e.tool, input: e.toolInput };
        setPillCollapsed(false);
      }
      poll();
    });
  }, [instanceId, poll, reconcile]);

  // ── Частый опрос ТЕКУЩЕГО состояния экрана claude (250мс). Надёжно — НЕ теряется при
  //    ремоунте/смене вида. Источник правды для стоп-кнопки, индикатора, resume/perm-меню. ──
  useEffect(() => {
    const la = { busy: undefined as boolean | undefined, ws: '', err: '', resume: false, permSig: '', mode: '', rp: '', compactActive: false, flashUntil: 0 };
    const tick = () => {
      const st = getTerminalScreenState(instanceId);
      if (!st) return;
      if (st.alive) {
        readyInstances.add(instanceId);
        const pend = pendingSendRef.current;
        if (pend && !st.resumeMenu && !st.permMenu && !st.resumePicker) { pendingSendRef.current = null; submitPromptToTerminal(instanceId, pend); setTimeout(() => poll(), 600); }
      }
      // Режим claude — из экрана (надёжно, не теряется при ремоунте/смене вида).
      if (st.mode && st.mode !== la.mode) { la.mode = st.mode; setMode(st.mode as PermissionMode); }
      if (st.busy !== la.busy) { la.busy = st.busy; setStatus(st.busy ? 'working' : 'ready'); }
      const ws = st.busy ? st.workStatus : '';
      if (ws !== la.ws) { la.ws = ws; setWorkStatus(ws); }
      if ((st.errorMsg || '') !== la.err) { la.err = st.errorMsg || ''; setError(st.errorMsg || ''); }
      // Прогресс компакта: claude отдаёт estimate, который доходит лишь до ~30% и операция
      // завершается — бар «обрывался» на 30% и пропадал (выглядело сломано). Поэтому при ЗАВЕРШЕНИИ
      // (был прогресс, busy спал) доводим бар до 100% и держим ~800мс, затем гасим.
      if (st.busy && st.progress != null) { la.compactActive = true; la.flashUntil = 0; setProgress(st.progress); }
      else if (!st.busy && la.compactActive) { la.compactActive = false; la.flashUntil = Date.now() + 800; setProgress(100); }
      else if (la.flashUntil && Date.now() < la.flashUntil) { /* держим 100% завершения */ }
      else { la.flashUntil = 0; setProgress(st.busy ? (st.progress ?? null) : null); }
      if (st.resumeMenu !== la.resume) { la.resume = st.resumeMenu; setResumeMenu(st.resumeMenu ? { info: st.resumeInfo } : null); }
      // /resume-пикер — список сессий; сигнатура = кол-во + выбранная, чтобы перерисовывать при навигации.
      const rpSig = st.resumePicker ? st.resumePicker.sessions.length + ':' + st.resumePicker.selectedIndex + ':' + st.resumePicker.total : '';
      // total делаем «липким» (только растёт): заголовок «Resume session (X of Y)» сначала за верхом
      // вьюпорта (total=видимые ~10), при листании появляется (Y=48) — иначе «N из Y» дёргался 10↔48.
      if (rpSig !== la.rp) { la.rp = rpSig; setResumePicker(prev => st.resumePicker ? { sessions: st.resumePicker.sessions.map((x) => ({ name: x.name, meta: x.meta })), selectedIndex: st.resumePicker.selectedIndex, total: Math.max(st.resumePicker.total, prev?.total || 0) } : null); }
      // permission — варианты СКРЕЙПЛЕНЫ с экрана (2 или 3); сигнатура = вопрос+цифры.
      // Сигнатура включает состояние чекбоксов (✔/ ) — чтобы тогл в мульти-селекте перерисовывал карточку.
      const permSig = st.permMenu ? st.permKind + '|' + st.permQuestion + '|' + (st.permOptions || []).map(o => o.digit + (o.checked ? '1' : o.checked === false ? '0' : '')).join('') + '|' + (st.permTabs || []).map(t => t.label + (t.done ? '1' : '0')).join(',') : '';
      if (permSig !== la.permSig) {
        la.permSig = permSig;
        if (st.permMenu) {
          const d = permDetailsRef.current;
          setPerm({ kind: st.permKind, multi: st.permMulti, question: st.permQuestion, detail: st.permDetail, options: st.permOptions || [], tool: d?.tool, input: d?.input, tabs: st.permTabs || [], isPlan: st.permIsPlan });
        } else if (planFbRef.current === null) { setPerm(null); permDetailsRef.current = null; } // открытый инлайн-фидбэк плана пиннит карточку
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [instanceId, poll]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (sc && stick.current) sc.scrollTop = sc.scrollHeight;
  }, [messages, perm, status]);

  const RANGE = 120;   // px of scroll to fully toggle the input open/closed
  const MIN_ROW = 38;  // textarea never smaller than one row
  const FOOTER_H = 46; // buttons row full height (30px buttons + 6/9 padding)

  // Cache the textarea's natural content height — only re-measured on input,
  // so the per-frame scroll resize never does an `auto` reflow (= no flicker).
  const measureContent = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const prev = ta.style.height;
    ta.style.height = 'auto';
    contentHRef.current = ta.scrollHeight;
    ta.style.height = prev;
  }, []);

  // Apply expansion raw∈[0,1]: textarea cap shrinks from 50% → one row, footer
  // collapses — the input shrinks IN PLACE (never moves, never disappears).
  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const half = Math.floor((rootRef.current?.clientHeight ?? 600) * 0.5);
    const maxH = Math.round(MIN_ROW + (half - MIN_ROW) * rawRef.current);
    ta.style.height = Math.min(contentHRef.current, maxH) + 'px';
    ta.style.overflowY = contentHRef.current > maxH ? 'auto' : 'hidden';
  }, []);

  const applyRaw = useCallback((raw: number) => {
    rawRef.current = raw;
    const f = footerRef.current;
    if (f) { f.style.height = Math.round(FOOTER_H * raw) + 'px'; f.style.opacity = raw < 0.04 ? '0' : '1'; }
    autoGrow();
  }, [autoGrow]);

  useEffect(() => { measureContent(); autoGrow(); }, [input, measureContent, autoGrow]);

  // Черновик ввода переживает размонтирование (переключение Чат↔Терминал).
  useEffect(() => {
    if (input) draftInputs.set(instanceId, input); else draftInputs.delete(instanceId);
  }, [input, instanceId]);

  // @-автокомплит: грузим файлы каталога (dir-часть запроса), фильтруем по name-части.
  useEffect(() => {
    if (!mention) { setMentionFiles([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      const q = mention.query;
      const slash = q.lastIndexOf('/');
      const dir = slash >= 0 ? q.slice(0, slash) : '';
      const namePart = (slash >= 0 ? q.slice(slash + 1) : q).toLowerCase();
      const base = cwd ? (dir ? `${cwd}/${dir}` : cwd) : (dir || undefined);
      try {
        const { data } = await listFiles(base);
        if (!alive) return;
        const files = (data.files || [])
          .filter(f => !namePart || f.name.toLowerCase().includes(namePart))
          .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
          .slice(0, 8)
          .map(f => ({ name: f.name, is_dir: f.is_dir }));
        setMentionFiles(files);
        setMentionIdx(0);
      } catch { if (alive) setMentionFiles([]); }
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [mention, cwd]);

  // Вставить выбранный файл/папку вместо @-запроса. Папка → остаёмся в @-режиме (углубляемся).
  const pickMention = useCallback((f: { name: string; is_dir: boolean }) => {
    if (!mention) return;
    const slash = mention.query.lastIndexOf('/');
    const dirPrefix = slash >= 0 ? mention.query.slice(0, slash + 1) : '';
    const inserted = '@' + dirPrefix + f.name + (f.is_dir ? '/' : ' ');
    const before = input.slice(0, mention.start);
    const after = input.slice(mention.start + 1 + mention.query.length);
    const newVal = before + inserted + after;
    setInput(newVal);
    setMention(f.is_dir ? { start: mention.start, query: dirPrefix + f.name + '/' } : null);
    const pos = (before + inserted).length;
    setTimeout(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(pos, pos); } }, 0);
  }, [input, mention]);

  // Команды/скиллы, подходящие под текущий ввод (или все, если палитра открыта кнопкой
  // с пустым '/'). Скиллы Claude Code вызываются так же, как слэш-команды.
  const cmdQuery = (cmd?.query || '').toLowerCase();
  const paletteOpen = !!(cmd || cmdOpen);
  const allSkills = [...ownSkills, ...claudeSkills];
  const cmdMatches = paletteOpen
    ? SLASH_COMMANDS.filter(c => c.cmd.slice(1).toLowerCase().startsWith(cmdQuery))
    : [];
  const skillMatches = paletteOpen
    ? allSkills.filter(c => c.cmd.slice(1).toLowerCase().startsWith(cmdQuery))
    : [];
  // Плоский список для клавиатурной навигации при вводе '/' (cmdIdx — сквозь обе секции).
  const paletteFlat = [...cmdMatches, ...skillMatches];

  const pickCommand = useCallback((c: { cmd: string }) => {
    setInput(c.cmd + ' ');
    setCmd(null); setCmdOpen(false); setCmdIdx(0);
    setTimeout(() => { const ta = taRef.current; if (ta) { const p = c.cmd.length + 1; ta.focus(); ta.setSelectionRange(p, p); } }, 0);
  }, []);

  // Свежий список скиллов из API (свои + claude). Обновляем на маунте и при открытии палитры.
  const refreshSkills = useCallback(async () => {
    try {
      const { data } = await listSkills();
      setOwnSkills((data.own || []).map(s => ({ cmd: '/' + s.name, desc: s.description || 'Свой скилл' })));
      setClaudeSkills((data.claude || []).map(s => ({ cmd: '/' + s.name, desc: s.description || 'Скилл Claude' })));
    } catch { /* нет API/скиллов — оставляем пусто */ }
  }, []);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);

  // Закрывать выпадашку команд/скиллов по клику ВНЕ композера (capture-phase pointerdown — как
  // ContextMenu). НЕ полагаемся на blur текстареи: при заходе в список autoFocus поля «Поиск…»
  // крадёт фокус → blur → палитра мигала и закрывалась (баг). composerRef оборачивает палитру +
  // textarea + кнопку, поэтому contains() покрывает все внутренние клики.
  useEffect(() => {
    if (!cmdOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && composerRef.current && composerRef.current.contains(t)) return;
      setCmdOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [cmdOpen]);

  // Direction-based: scrolling DOWN opens the input (even mid-history), scrolling
  // UP closes it; pinned fully open at the very bottom. Self-induced scroll (the
  // resize clamp) is ignored so it can't feed back into a jitter loop.
  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (ignoreRef.current) { lastTopRef.current = sc.scrollTop; return; }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const s = scrollRef.current;
      if (!s) return;
      const top = s.scrollTop;
      const dist = s.scrollHeight - top - s.clientHeight;
      const delta = top - lastTopRef.current;
      lastTopRef.current = top;
      stick.current = dist < 40;
      let raw = dist < 6 ? 1 : rawRef.current + delta / RANGE; // bottom → full; else by direction
      raw = Math.min(1, Math.max(0, raw));
      if (Math.abs(raw - rawRef.current) < 0.003) return;
      ignoreRef.current = true;
      applyRaw(raw);
      requestAnimationFrame(() => { ignoreRef.current = false; });
    });
  }, [applyRaw]);

  const scrollToBottom = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    stick.current = true;
    sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  }, []);

  const expandComposer = useCallback(() => {
    const sc = scrollRef.current;
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  }, []);

  const sendUser = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    // Анти-дубль: тот же текст за <1.5с — повторный сабмит (гонка stale-замыкания), игнор.
    const now = Date.now();
    if (lastSubmitRef.current.text === text && now - lastSubmitRef.current.t < 1500) return;
    lastSubmitRef.current = { text, t: now };
    setInput('');
    setMention(null);
    setCmd(null); setCmdOpen(false);
    stick.current = true;
    // Оптимистично показываем СВОЁ сообщение сразу — реальное из JSONL дедуплицирует его
    // (mergeMsgs). Статус 'working' НЕ ставим оптимистично — он придёт из чтения экрана
    // (terminal_busy), когда claude реально начнёт; при сорванном сабмите стоп не загорится.
    const optimistic: RichMessage = { uuid: `optimistic-${Date.now()}`, role: 'user', blocks: [{ kind: 'text', text }] };
    setMessages(prev => { const next = [...prev, optimistic]; messagesRef.current = next; return next; });
    // Если открыто блокирующее меню (permission/resume) — НЕЛЬЗЯ слать текст: Enter в конце
    // подтвердил бы меню (по умолчанию ❯ Yes). Придерживаем до закрытия меню.
    const scr = getTerminalScreenState(instanceId);
    // Свободный ответ (freeTextRef) — claude уже ждёт текст, видимое план-меню игнорируем и шлём.
    const menuUp = !freeTextRef.current && !!(scr && (scr.resumeMenu || scr.permMenu || scr.resumePicker));
    freeTextRef.current = false;
    if (readyInstances.has(instanceId) && !menuUp) {
      submitPromptToTerminal(instanceId, text); // claude готов, меню нет → шлём (bracketed paste + Enter)
      setTimeout(() => poll(), 600);
    } else {
      // claude грузится ИЛИ открыто меню — придержим. Флаш в опросе экрана идёт только при
      // !resumeMenu && !permMenu, поэтому текст не подтвердит меню. Фолбэк тоже это проверяет.
      pendingSendRef.current = text;
      setTimeout(() => {
        if (pendingSendRef.current !== text) return;
        const s = getTerminalScreenState(instanceId);
        if (s && (s.resumeMenu || s.permMenu || s.resumePicker)) return; // меню ещё открыто — НЕ отправляем
        pendingSendRef.current = null; submitPromptToTerminal(instanceId, text); setTimeout(() => poll(), 600);
      }, 9000);
    }
    scrollToBottom();
  }, [input, instanceId, poll, scrollToBottom]);

  // "Вернуться к сообщению" → открыть РОДНОЙ rewind в claude (Esc Esc на пустом вводе) и
  // показать настоящий экран терминала; выбор сообщения/охвата человек делает в родном меню.
  const onRewind = useCallback((_m: RichMessage) => {
    sendKey('\x1b\x1b');
    onRequestTerminal?.();
  }, [sendKey, onRequestTerminal]);

  // Ответ на запрос доступа: цифра в нумерованное меню claude (1=да / 2=да навсегда / 3=нет).
  // Калибровано на claude 2.1.175: нумерованные меню срабатывают по нажатию цифры БЕЗ Enter
  // (проверено на trust-промпте — «1» подтверждает сразу). Лишний \r отправил бы пустой ввод.
  const decide = useCallback((digit: string) => {
    sendKey(digit);
    setPerm(null);
    setTimeout(() => poll(), 400);
  }, [sendKey, poll]);

  // «Type something» / «Chat about this» / «Tell Claude what to change» = свободный ответ: цифра
  // в меню плана/вопроса лишь ПЕРЕМЕЩАЕТ курсор на пункт (❯), а АКТИВИРУЕТ его Enter — без него
  // claude не входит в текстовый ввод (проверено логом plan-flow: ❯ 4 висит, текст не уходит).
  // Поэтому: цифра → Enter (активировать) → закрыть карточку → раскрыть нижнее поле (фокус композера).
  const chooseOption = useCallback((o: PermOption, isPlan?: boolean) => {
    const free = /type something|chat about|tell claude|свой ответ|ввести|написать/i.test(o.label);
    if (free && isPlan) {
      // ПЛАН: активируем пункт у claude (цифра+Enter → он ждёт текст-правку), но карточку НЕ закрываем
      // и композер НЕ трогаем — раскрываем инлайн-поле ПОД кнопками. План остаётся на экране.
      sendKey(o.digit);
      setTimeout(() => sendKey('\r'), 90);
      setPlanFb(''); // открыть инлайн-поле (карточка пиннится опросом, см. setPerm-гейт)
    } else if (free) {
      sendKey(o.digit);
      setTimeout(() => sendKey('\r'), 90); // Enter активирует выбранный пункт → claude ждёт текст
      freeTextRef.current = true; // следующий текст из композера слать, игнорируя видимое меню
      setPerm(null);
      applyRaw(1); // РАСКРЫТЬ композер — поле ввода «выдвигается» (футер+textarea на полную)
      setTimeout(() => { applyRaw(1); taRef.current?.focus(); }, 200);
    } else {
      decide(o.digit);
    }
  }, [sendKey, decide, applyRaw, setPlanFb]);

  // Отправить инлайн-правку плана: текст уходит в claude (он в режиме «Tell Claude what to change»),
  // затем закрываем поле и карточку — claude перепланирует с учётом правки.
  const submitPlanFb = useCallback(() => {
    const text = (planFbRef.current || '').trim();
    if (!text) return;
    submitPromptToTerminal(instanceId, text);
    setPlanFb(null);
    setPerm(null);
    setTimeout(() => poll(), 500);
  }, [instanceId, poll, setPlanFb]);

  // Мульти-селект: цифра ТОГЛИТ чекбокс — карточку НЕ закрываем, опрос перечитает новое
  // состояние (✔). Калибровано на claude 2.1.175.
  const toggleOption = useCallback((digit: string) => {
    sendKey(digit);
  }, [sendKey]);

  // Мульти-селект submit: стрелка вправо → экран «Ready to submit?» (Submit answers/Cancel) —
  // он распознаётся как обычное question-меню и показывается этой же карточкой.
  const submitMulti = useCallback(() => {
    sendKey('\x1b[C');
    setTimeout(() => poll(), 250);
  }, [sendKey, poll]);

  // Ответ на меню "как восстановить" (claude --resume): 1=из сводки, 2=полностью, 3=не спрашивать.
  const resumeChoose = useCallback((digit: '1' | '2' | '3') => {
    sendKey(digit);
    setResumeMenu(null);
    setTimeout(() => poll(), 500);
  }, [sendKey, poll]);

  // Клик по сессии в /resume-пикере: навигируем стрелками от ВЫБРАННОЙ к ЦЕЛИ, затем Enter.
  const resumePickerChoose = useCallback((targetIndex: number, selectedIndex: number) => {
    const delta = targetIndex - selectedIndex;
    const key = delta > 0 ? '\x1b[B' : '\x1b[A';
    for (let i = 0; i < Math.abs(delta); i++) sendKey(key);
    setTimeout(() => sendKey('\r'), 120 + Math.abs(delta) * 12); // Enter после прокрутки курсора
    setResumePicker(null);
    setTimeout(() => poll(), 700);
  }, [sendKey, poll]);

  // Листание /resume-пикера: claude рисует ОКНО списка (видно не все сессии разом). Пачка стрелок
  // ↓/↑ двигает курсор за край окна → claude прокручивает → опрос (250мс) ре-скрейпит новую порцию.
  const scrollResume = useCallback((dir: 1 | -1) => {
    const key = dir > 0 ? '\x1b[B' : '\x1b[A';
    for (let i = 0; i < 3; i++) sendKey(key); // 3 шага за клик — плавнее (было 6, «прыгало»)
    setTimeout(() => poll(), 300);
  }, [sendKey, poll]);

  // Сменить режим = Shift+Tab в реальный claude (циклит default→acceptEdits→plan→auto).
  // Оптимистично крутим метку в ТОМ ЖЕ порядке, что и claude; точный режим придёт по hook.
  const cycleMode = useCallback(() => {
    sendKey('\x1b[Z');
    const i = MODE_CYCLE.indexOf(mode);
    setMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length]);
  }, [sendKey, mode]);

  const changeFont = useCallback((delta: number) => {
    setFontPx(prev => {
      const next = Math.min(20, Math.max(11, prev + delta));
      localStorage.setItem(FONT_KEY, String(next));
      return next;
    });
  }, []);

  // ── Voice input (Web Speech API) ──
  const toggleVoice = useCallback(() => {
    if (listening) { recognitionRef.current?.stop(); return; }
    const SR = (window as typeof window & { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      || (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) { toast.error('Голосовой ввод не поддерживается в этом браузере'); return; }
    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = false;
    inputBaseRef.current = input ? input + ' ' : '';
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(inputBaseRef.current + txt);
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') toast.error(`Голос: ${e.error}`);
    };
    rec.onend = () => { setListening(false); recognitionRef.current = null; };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening, input]);

  const visibleMessages = query.trim()
    ? messages.filter(m => messageText(m).includes(query.trim().toLowerCase()))
    : messages;
  const modeInfo = MODE_INFO[mode] || MODE_INFO.default;

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
      {/* Единая шапка: переключатели Терминал/Чат (слот toggle) + инструменты чата (Find, вниз,
          шрифт, терминал, индикатор контекста) — всё в ОДНОЙ строке. */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.12)' }}>
        {toggle}
        {toggle && <span style={{ flexShrink: 0, width: 1, height: 18, margin: '0 2px', background: 'var(--glass-border)' }} />}
        {findOpen ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по чату…"
              style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit' }} />
            {query && <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{visibleMessages.length}</span>}
            <button type="button" onClick={() => { setFindOpen(false); setQuery(''); }} style={iconBtn}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </>
        ) : (
          <>
            {ctx && typeof ctx.used === 'number' && (
              <div title={`Контекст: ${ctx.tin?.toLocaleString() ?? '?'} / ${(ctx.size ?? 200000).toLocaleString()} токенов${ctx.model ? ' · ' + ctx.model : ''}${ctx.cost ? ' · $' + ctx.cost.toFixed(3) : ''}`}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: ctxColor(ctx.used), userSelect: 'none' }}>
                <span style={{ width: 32, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden', flexShrink: 0 }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(100, ctx.used)}%`, background: ctxColor(ctx.used) }} />
                </span>
                <span>{ctx.used}%{ctx.tin != null ? ' · ' + fmtTokens(ctx.tin) : ''}</span>
              </div>
            )}
            <span style={{ flex: 1 }} />
            <button type="button" onClick={scrollToBottom} title="Вниз" style={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
            </button>
            <button type="button" onClick={() => setFindOpen(true)} title="Поиск" style={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </button>
            <button type="button" onClick={() => changeFont(-1)} title="Меньше шрифт" style={iconBtn}>A−</button>
            <button type="button" onClick={() => changeFont(1)} title="Больше шрифт" style={iconBtn}>A+</button>
            {onRequestTerminal && (
              <button type="button" onClick={onRequestTerminal} title="Открыть настоящий терминал" style={iconBtn}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
              </button>
            )}
          </>
        )}
      </div>

      {/* Messages + inline permission card */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px', WebkitOverflowScrolling: 'touch', ['--chat-fs' as string]: `${fontPx}px` } as React.CSSProperties}>
        {messages.length === 0 && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            {targetRef.current ? 'Напишите сообщение, чтобы начать.' : 'Ожидание запуска Claude…'}
          </div>
        )}
        {visibleMessages.map(m => <ClaudeMessage key={m.uuid} msg={m} onRewind={onRewind} />)}

        {/* Меню "как восстановить" (claude --resume сжатой сессии) — обёрнуто картой */}
        {!query && resumeMenu && (
          <div style={{ margin: '10px 0', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.45)', background: 'rgba(var(--accent-rgb),0.1)' }}>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Восстановить чат</div>
              {resumeMenu.info && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>{resumeMenu.info}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 12px', borderTop: '1px solid var(--glass-border)' }}>
              <button type="button" onClick={() => resumeChoose('1')} style={pbtn('rgba(var(--accent-rgb),0.18)', 'rgba(var(--accent-rgb),0.4)', 'var(--accent-bright)')}>Из сводки (реком.)</button>
              <button type="button" onClick={() => resumeChoose('2')} style={pbtn('rgba(255,255,255,0.06)', 'var(--glass-border)', 'var(--text-secondary)')}>Полностью как есть</button>
              <button type="button" onClick={() => resumeChoose('3')} style={pbtn('rgba(255,255,255,0.04)', 'var(--glass-border)', 'var(--text-muted)')}>Не спрашивать</button>
            </div>
          </div>
        )}

        {/* /resume — список сессий, обёрнут картой (клик навигирует курсор в claude + Enter) */}
        {!query && resumePicker && (
          <div style={{ margin: '10px 0', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.45)', background: 'rgba(var(--accent-rgb),0.1)' }}>
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Возобновить сессию</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{resumePicker.sessions.length} из {Math.max(resumePicker.total, resumePicker.sessions.length)}</span>
              {resumePicker.total > resumePicker.sessions.length && (
                <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>листай ↓↑ чтобы видеть старее</span>
              )}
            </div>
            {/* Листание: ↑ новее / ↓ старее — двигают окно списка в claude (видно не все разом). */}
            <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px' }}>
              <button type="button" onClick={() => scrollResume(-1)} style={{ ...pbtn('rgba(var(--accent-rgb),0.1)', 'rgba(var(--accent-rgb),0.3)', 'var(--accent-bright)'), flex: 1, padding: '5px 0', fontSize: 11.5 }}>↑ новее</button>
              <button type="button" onClick={() => scrollResume(1)} style={{ ...pbtn('rgba(var(--accent-rgb),0.1)', 'rgba(var(--accent-rgb),0.3)', 'var(--accent-bright)'), flex: 1, padding: '5px 0', fontSize: 11.5 }}>↓ старее</button>
            </div>
            <div style={{ maxHeight: 480, overflowY: 'auto', borderTop: '1px solid var(--glass-border)' }}>
              {resumePicker.sessions.map((s, i) => (
                <button key={i} type="button" onClick={() => resumePickerChoose(i, resumePicker.selectedIndex)}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, width: '100%', textAlign: 'left', padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit',
                    background: i === resumePicker.selectedIndex ? 'rgba(var(--accent-rgb),0.15)' : 'transparent', border: 'none', borderBottom: '1px solid var(--glass-border)', color: 'var(--text-primary)' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.meta}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--glass-border)' }}>
              <button type="button" onClick={() => { setResumePicker(null); sendKey('\x1b'); }} style={pbtn('rgba(255,255,255,0.05)', 'var(--glass-border)', 'var(--text-secondary)')}>Отмена</button>
              {onRequestTerminal && <button type="button" onClick={() => { setResumePicker(null); onRequestTerminal(); }} style={pbtn('rgba(255,255,255,0.05)', 'var(--glass-border)', 'var(--text-secondary)')}>⌨ Терминал</button>}
            </div>
          </div>
        )}

        {/* (4) permission — варианты и текст СКРЕЙПЛЕНЫ с реального экрана (2 или 3 кнопки) */}
        {!query && perm && (
          <div style={{ margin: '10px 0', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.45)', background: 'rgba(var(--accent-rgb),0.1)' }}>
            {/* Шапка мульти-вопроса: заголовки вопросов (☐/✔) + «Вопрос N из M» — прогресс по табам claude */}
            {perm.kind === 'question' && (perm.tabs || []).filter(t => !/^submit/i.test(t.label)).length > 1 && (() => {
              const qTabs = (perm.tabs || []).filter(t => !/^submit/i.test(t.label));
              const answered = qTabs.filter(t => t.done).length;
              const total = qTabs.length;
              const current = Math.min(answered + 1, total);
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(var(--accent-rgb),0.08)' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-bright)', whiteSpace: 'nowrap' }}>Вопрос {current} из {total}</span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
                    {qTabs.map((t, i) => {
                      const isCurrent = !t.done && i === answered;
                      return (
                        <span key={t.label + i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px', borderRadius: 999,
                          background: t.done ? 'rgba(var(--success-rgb),0.15)' : isCurrent ? 'rgba(var(--accent-rgb),0.22)' : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${t.done ? 'rgba(var(--success-rgb),0.45)' : isCurrent ? 'rgba(var(--accent-rgb),0.5)' : 'var(--glass-border)'}`,
                          color: t.done ? 'var(--success)' : isCurrent ? 'var(--accent-bright)' : 'var(--text-muted)', fontWeight: isCurrent ? 700 : 500 }}>
                          <span style={{ fontSize: 10 }}>{t.done ? '✓' : isCurrent ? '◉' : '○'}</span>{t.label}
                        </span>
                      );
                    })}
                  </span>
                </div>
              );
            })()}
            <div style={{ padding: '10px 12px' }}>
              {(() => {
                // Полную команду берём из хука (точная), иначе — скрейп экрана.
                const hookCmd = permInputText(perm.input);
                const detailText = hookCmd || perm.detail || '';
                return (
                  <>
                    <div style={{ fontSize: perm.isPlan ? 16 : 12.5, fontWeight: 700, color: 'var(--text-primary)', marginBottom: detailText ? (perm.isPlan ? 12 : 6) : 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {perm.isPlan ? <><span style={{ fontSize: 18 }}>📋</span>План Claude</> : (perm.question || 'Claude запрашивает доступ')}
                    </div>
                    {detailText && (
                      perm.isPlan
                        ? <div className="plan-md" style={{ fontSize: 14.5, lineHeight: 1.72, color: 'var(--text-primary)', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--glass-border)', borderRadius: 12, padding: '16px 18px', maxHeight: 'min(70vh, 720px)', overflow: 'auto' }}>
                            <ReactMarkdown>{detailText}</ReactMarkdown>
                          </div>
                        : <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11, lineHeight: 1.45, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--glass-border)', borderRadius: 8, maxHeight: 320, overflow: 'auto' }}>
                            {detailText}
                          </pre>
                    )}
                    {perm.isPlan && perm.question && (
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 12 }}>{perm.question}</div>
                    )}
                  </>
                );
              })()}
            </div>
            <div style={{ display: 'flex', flexDirection: perm.kind === 'question' ? 'column' : 'row', gap: 8, flexWrap: 'wrap', padding: '10px 12px', borderTop: '1px solid var(--glass-border)' }}>
              {perm.isPlan && planFb !== null ? (
                // ИНЛАЙН-ПОЛЕ правки плана — раскрылось ПОД кнопкой; план-карточка выше остаётся.
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea autoFocus value={planFb} onChange={e => setPlanFb(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitPlanFb(); } }}
                    placeholder="Что Claude изменить в плане? (Ctrl+Enter — отправить)"
                    style={{ width: '100%', minHeight: 70, resize: 'vertical', padding: '10px 12px', borderRadius: 8, fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-primary)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(var(--accent-rgb),0.45)', outline: 'none', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={submitPlanFb} disabled={!planFb.trim()} style={{ ...pbtn('rgba(var(--accent-rgb),0.22)', 'rgba(var(--accent-rgb),0.5)', 'var(--accent-bright)'), opacity: planFb.trim() ? 1 : 0.5, cursor: planFb.trim() ? 'pointer' : 'default' }}>Отправить правку →</button>
                    <button type="button" onClick={() => { setPlanFb(null); sendKey('\x1b'); setTimeout(() => poll(), 300); }} style={pbtn('rgba(255,255,255,0.05)', 'var(--glass-border)', 'var(--text-secondary)')}>Отмена</button>
                  </div>
                </div>
              ) : perm.multi ? (
                <>
                  {perm.options.map((o) => (
                    <button key={o.digit} type="button" title={o.raw} onClick={() => o.checked === undefined ? decide(o.digit) : toggleOption(o.digit)}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left', padding: '8px 11px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                        background: o.checked ? 'rgba(var(--success-rgb),0.13)' : 'rgba(var(--accent-rgb),0.07)',
                        border: `1px solid ${o.checked ? 'rgba(var(--success-rgb),0.45)' : 'rgba(var(--accent-rgb),0.28)'}`, color: 'var(--text-primary)' }}>
                      {o.checked === undefined
                        ? <span style={{ flexShrink: 0, minWidth: 18, height: 18, lineHeight: '18px', textAlign: 'center', borderRadius: 5, fontSize: 11, fontWeight: 700, background: 'rgba(var(--accent-rgb),0.25)', color: 'var(--accent-bright)' }}>{o.digit}</span>
                        : <span style={{ flexShrink: 0, width: 18, height: 18, lineHeight: '15px', textAlign: 'center', borderRadius: 5, fontSize: 12, fontWeight: 800, border: `1.5px solid ${o.checked ? 'var(--success)' : 'var(--text-muted)'}`, color: o.checked ? 'var(--success)' : 'transparent' }}>✓</span>}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{o.label}</span>
                        {o.desc && <span style={{ display: 'block', fontSize: 11, lineHeight: 1.4, color: 'var(--text-muted)', marginTop: 2 }}>{o.desc}</span>}
                      </span>
                    </button>
                  ))}
                  <button type="button" onClick={submitMulti} style={pbtn('rgba(var(--success-rgb),0.2)', 'rgba(var(--success-rgb),0.5)', 'var(--success)')}>Готово →</button>
                </>
              ) : perm.kind === 'question'
                ? perm.options.map((o) => {
                    const free = /type something|chat about|tell claude/i.test(o.label);
                    return (
                    <button key={o.digit} type="button" title={o.raw} onClick={() => chooseOption(o, perm.isPlan)}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left', padding: '8px 11px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', background: free ? 'rgba(255,255,255,0.04)' : 'rgba(var(--accent-rgb),0.1)', border: `1px solid ${free ? 'var(--glass-border)' : 'rgba(var(--accent-rgb),0.3)'}`, color: 'var(--text-primary)' }}>
                      <span style={{ flexShrink: 0, minWidth: 18, height: 18, lineHeight: '18px', textAlign: 'center', borderRadius: 5, fontSize: 11, fontWeight: 700, background: 'rgba(var(--accent-rgb),0.25)', color: 'var(--accent-bright)' }}>{free ? '✎' : o.digit}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{o.label}</span>
                        {(free || o.desc) && <span style={{ display: 'block', fontSize: 11, lineHeight: 1.4, color: 'var(--text-muted)', marginTop: 2 }}>{free ? 'Поле для правки раскроется ниже' : o.desc}</span>}
                      </span>
                    </button>
                  ); })
                : perm.options.map((o) => {
                    const isNo = /^нет/i.test(o.label) || /^no\b/i.test(o.raw);
                    const isPlainYes = o.label === 'Да';
                    const style = isNo
                      ? pbtn('rgba(var(--danger-rgb),0.12)', 'rgba(var(--danger-rgb),0.35)', 'var(--danger)')
                      : isPlainYes
                        ? pbtn('rgba(var(--success-rgb),0.18)', 'rgba(var(--success-rgb),0.4)', 'var(--success)')
                        : pbtn('rgba(var(--accent-rgb),0.18)', 'rgba(var(--accent-rgb),0.4)', 'var(--accent-bright)');
                    return <button key={o.digit} type="button" title={o.raw} onClick={() => decide(o.digit)} style={style}>{o.label}</button>;
                  })}
              {onRequestTerminal && !(perm.isPlan && planFb !== null) && (
                <button type="button" onClick={() => { setPerm(null); onRequestTerminal(); }} style={pbtn('rgba(255,255,255,0.05)', 'var(--glass-border)', 'var(--text-secondary)')}>⌨ Терминал</button>
              )}
            </div>
          </div>
        )}

        {/* Ошибка/сеть claude — ОДНА красная карточка (детект из экрана; не плодим повторы ретраев). */}
        {!query && error && (
          <div style={{ margin: '10px 0', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(var(--danger-rgb),0.5)', background: 'rgba(var(--danger-rgb),0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 12px' }}>
              <span style={{ flexShrink: 0, fontSize: 15, lineHeight: '20px' }}>⚠️</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--danger)' }}>Ошибка Claude</span>
                <span style={{ display: 'block', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 3, wordBreak: 'break-word' }}>{error}</span>
                {/check your network|Waiting for API/i.test(error) && (
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Нет связи с API Anthropic — проверьте интернет/VPN. Claude повторяет запрос автоматически.</span>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Живой индикатор «думает» — из чтения экрана. При длинной операции (compact/hooks)
            лейбл и НАСТОЯЩИЙ прогресс-бар обёрнуты ОДНОЙ карточкой (процент вынесен из текста). */}
        {status === 'working' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 4px 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-bright)', fontSize: 12.5 }}>
              <span className="claude-chat-pulse" style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>✻</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workStatus || 'Claude думает…'}</span>
              {progress != null && <span style={{ flexShrink: 0, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontSize: 11.5, color: 'var(--text-muted)' }}>{progress}%</span>}
            </div>
            {progress != null && (
              <span style={{ position: 'relative', display: 'block', alignSelf: 'flex-start', width: 'min(220px, 60%)', height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                {/* Заливка: градиент, ширина через scaleX (GPU); поверх — бегущий блик. */}
                <span style={{ position: 'absolute', inset: 0, transformOrigin: 'left center', transform: `scaleX(${Math.min(1, Math.max(0, progress / 100))})`, borderRadius: 999, background: 'linear-gradient(90deg, var(--accent), var(--accent-bright))', transition: 'transform 0.35s ease', overflow: 'hidden' }}>
                  <span className="compact-progress-sheen" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '45%', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)' }} />
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Composer (pill + input + mode footer) — in normal flow, so the full
          message history always sits ABOVE the input (never behind it). */}
      <div ref={composerRef} style={{ flexShrink: 0 }}>

      {/* Input + voice */}
      <div style={{ position: 'relative', flexShrink: 0, borderTop: '1px solid var(--glass-border)', padding: 8, background: 'rgba(0,0,0,0.15)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {/* (5) red stop button — anchored directly ABOVE the send button (tracks
            it even when the input is one row). Swipe right → sticks to the edge. */}
        {status === 'working' && (
          pillCollapsed ? (
            <button type="button" title="Показать кнопку стоп" onClick={() => setPillCollapsed(false)}
              onPointerDown={(e) => { pillRef.current = { x: e.clientX, moved: false }; }}
              onPointerUp={(e) => { if (e.clientX - pillRef.current.x < -28) setPillCollapsed(false); }}
              style={{ position: 'absolute', right: 0, bottom: 'calc(100% + 6px)', zIndex: 6, width: 20, height: 38, borderRadius: '10px 0 0 10px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'pan-y',
                background: 'rgba(var(--danger-rgb),0.22)', border: '1px solid rgba(var(--danger-rgb),0.5)', borderRight: 'none', color: 'var(--danger)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
          ) : (
            <button type="button" title="Остановить (смахни вправо, чтобы свернуть)"
              onPointerDown={(e) => { pillRef.current = { x: e.clientX, moved: false }; }}
              onPointerMove={(e) => { if (Math.abs(e.clientX - pillRef.current.x) > 8) pillRef.current.moved = true; }}
              onPointerUp={(e) => { if (e.clientX - pillRef.current.x > 36) setPillCollapsed(true); }}
              onClick={() => { if (!pillRef.current.moved) sendKey('\x1b'); }}
              style={{ position: 'absolute', right: 8, bottom: 'calc(100% + 6px)', zIndex: 6, width: 38, height: 38, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'pan-y',
                background: 'rgba(var(--danger-rgb),0.22)', border: '1px solid rgba(var(--danger-rgb),0.5)', color: 'var(--danger)' }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2.5" /></svg>
            </button>
          )
        )}
        {/* Палитра под вводом. Ввод '/' → плоский фильтр (Команды+Скиллы, cmdIdx сквозной).
            Кнопкой → drill-down: root → Команды | Скиллы → Свои | Claude → список. Скиллы — из API. */}
        {paletteOpen && (cmd ? (
          paletteFlat.length > 0 && (() => {
            const row = (c: { cmd: string; desc: string }, flat: number, keyId: string) => {
              const matchLen = c.cmd.slice(1).toLowerCase().startsWith(cmdQuery) ? cmdQuery.length : 0;
              return (
                <div key={keyId} onMouseDown={(e) => { e.preventDefault(); pickCommand(c); }}
                  onMouseEnter={() => setCmdIdx(flat)}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 11px', fontSize: 12.5, cursor: 'pointer', background: flat === cmdIdx ? 'rgba(var(--accent-rgb),0.22)' : 'transparent' }}>
                  <span style={{ flexShrink: 0, fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent-bright)' }}>
                    /<span style={{ color: 'var(--text-primary)', background: matchLen ? 'rgba(var(--accent-rgb),0.35)' : 'transparent', borderRadius: 3 }}>{c.cmd.slice(1, 1 + matchLen)}</span>{c.cmd.slice(1 + matchLen)}
                  </span>
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11.5 }}>{c.desc}</span>
                </div>
              );
            };
            const hdrStyle: React.CSSProperties = { padding: '6px 11px 3px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', position: 'sticky', top: 0, background: 'rgba(10,2,16,0.98)' };
            return (
              <div style={{ position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 4px)', zIndex: 9, maxHeight: 320, overflowY: 'auto', borderRadius: 10, background: 'rgba(10,2,16,0.98)', border: '1px solid var(--glass-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                {cmdMatches.length > 0 && <div style={hdrStyle}>Команды</div>}
                {cmdMatches.map((c, i) => row(c, i, 'cmd:' + c.cmd))}
                {skillMatches.length > 0 && <div style={{ ...hdrStyle, borderTop: cmdMatches.length ? '1px solid var(--glass-border)' : 'none' }}>Скиллы</div>}
                {skillMatches.map((c, i) => row(c, cmdMatches.length + i, 'skill:' + c.cmd))}
              </div>
            );
          })()
        ) : (() => {
          const drop: React.CSSProperties = { position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 4px)', zIndex: 9, maxHeight: 340, overflowY: 'auto', borderRadius: 10, background: 'rgba(10,2,16,0.98)', border: '1px solid var(--glass-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' };
          const go = (to: typeof paletteNav) => { setPaletteNav(to); setPaletteSearch(''); setCmdIdx(0); };
          const navRow = (label: string, to: typeof paletteNav, hint: string) => (
            <button key={to} type="button" onMouseDown={(e) => { e.preventDefault(); go(to); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 12px', cursor: 'pointer', background: 'transparent', border: 'none', borderBottom: '1px solid var(--glass-border)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>
              </span>
              <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 16 }}>›</span>
            </button>
          );
          const back = (label: string, to: typeof paletteNav) => (
            <button type="button" onMouseDown={(e) => { e.preventDefault(); go(to); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 11px', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', border: 'none', borderBottom: '1px solid var(--glass-border)', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, position: 'sticky', top: 0 }}>
              ‹ {label}
            </button>
          );
          if (paletteNav === 'root') return <div style={drop}>{navRow('Команды', 'commands', 'Слэш-команды Claude Code')}{navRow('Скиллы', 'skills', 'Свои .md и скиллы Claude')}</div>;
          if (paletteNav === 'skills') return <div style={drop}>{back('Назад', 'root')}{navRow('Свои', 'own', 'Загруженные тобой .md-скиллы')}{navRow('Claude', 'claude', 'Плагины и встроенные')}</div>;
          const items = paletteNav === 'commands' ? SLASH_COMMANDS : paletteNav === 'own' ? ownSkills : claudeSkills;
          const q = paletteSearch.toLowerCase();
          const filtered = items.filter(c => !q || c.cmd.slice(1).toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
          const crumb = paletteNav === 'commands' ? 'Команды' : paletteNav === 'own' ? 'Скиллы › Свои' : 'Скиллы › Claude';
          return (
            <div style={drop}>
              {back(crumb, paletteNav === 'commands' ? 'root' : 'skills')}
              <input autoFocus value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && filtered[0]) { e.preventDefault(); pickCommand(filtered[0]); } else if (e.key === 'Escape') { e.preventDefault(); setCmdOpen(false); } }}
                placeholder="Поиск…" style={{ width: '100%', boxSizing: 'border-box', padding: '7px 11px', background: 'rgba(255,255,255,0.04)', border: 'none', borderBottom: '1px solid var(--glass-border)', outline: 'none', color: 'var(--text-primary)', fontSize: 12.5, fontFamily: 'inherit' }} />
              {filtered.length ? filtered.map((c, i) => (
                <div key={c.cmd + ':' + i} onMouseDown={(e) => { e.preventDefault(); pickCommand(c); }}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 11px', fontSize: 12.5, cursor: 'pointer' }}>
                  <span style={{ flexShrink: 0, fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent-bright)' }}>{c.cmd}</span>
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11.5 }}>{c.desc}</span>
                </div>
              )) : <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{paletteNav === 'own' ? 'Своих скиллов пока нет — загрузи .md в панели «Скиллы»' : 'Ничего не найдено'}</div>}
            </div>
          );
        })())}
        {/* @-автокомплит файлов */}
        {mention && mentionFiles.length > 0 && (
          <div style={{ position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 4px)', zIndex: 8, maxHeight: 220, overflowY: 'auto', borderRadius: 10, background: 'rgba(10,2,16,0.97)', border: '1px solid var(--glass-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
            {mentionFiles.map((f, i) => (
              <div key={f.name} onMouseDown={(e) => { e.preventDefault(); pickMention(f); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 12.5, cursor: 'pointer', background: i === mentionIdx ? 'rgba(var(--accent-rgb),0.2)' : 'transparent', color: 'var(--text-primary)' }}>
                <span style={{ flexShrink: 0 }}>{f.is_dir ? '📁' : '📄'}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}{f.is_dir ? '/' : ''}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <div ref={overlayRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, padding: '9px 12px', border: '1px solid transparent', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'hidden', pointerEvents: 'none', color: 'var(--text-primary)' }}>
          {renderInputHighlight(input)}
        </div>
        <textarea
          ref={taRef}
          className="agent-input"
          value={input}
          onScroll={(e) => { if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop; }}
          onChange={(e) => {
            const v = e.target.value;
            const cur = e.target.selectionStart ?? v.length;
            setInput(v);
            setMention(detectMention(v, cur));
            const c = detectCommand(v, cur);
            setCmd(c); setCmdIdx(0);
            if (cmdOpen && !c) setCmdOpen(false);
          }}
          onFocus={expandComposer}
          onKeyDown={(e) => {
            if (paletteOpen && paletteFlat.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx(i => Math.min(i + 1, paletteFlat.length - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx(i => Math.max(i - 1, 0)); return; }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const sel = paletteFlat[Math.min(cmdIdx, paletteFlat.length - 1)];
                // Ввод УЖЕ полная команда без аргументов (/compact, /clear) + Enter → ОТПРАВЛЯЕМ в claude;
                // иначе (частичный ввод / Tab) — дополняем строку команды.
                if (e.key === 'Enter' && input.trim() === sel.cmd) { setCmd(null); setCmdOpen(false); sendUser(); }
                else pickCommand(sel);
                return;
              }
              if (e.key === 'Escape') { e.preventDefault(); setCmd(null); setCmdOpen(false); return; }
            }
            if (mention && mentionFiles.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => Math.min(i + 1, mentionFiles.length - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => Math.max(i - 1, 0)); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionFiles[mentionIdx]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing) { e.preventDefault(); sendUser(); }
            else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); }
          }}
          placeholder="Сообщение для Claude… (/ — команды, @ — файл)"
          rows={1}
          style={{ display: 'block', width: '100%', position: 'relative', resize: 'none', minHeight: 38, padding: '9px 12px', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4, background: 'rgba(var(--accent-rgb),0.06)', border: '1px solid var(--glass-border)', color: 'transparent', caretColor: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }}
        />
        </div>
        <button type="button" onClick={toggleVoice} title="Голосовой ввод"
          style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: listening ? 'rgba(var(--danger-rgb),0.18)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${listening ? 'rgba(var(--danger-rgb),0.4)' : 'var(--glass-border)'}`, color: listening ? 'var(--danger)' : 'var(--text-muted)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" />
          </svg>
        </button>
        <button type="button" onClick={sendUser} disabled={!input.trim()}
          style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 10, cursor: input.trim() ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--accent-rgb),0.2)', border: '1px solid rgba(var(--accent-rgb),0.4)', color: 'var(--accent-bright)', opacity: input.trim() ? 1 : 0.5 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* (6) Кнопки под вводом: «команды и скиллы» + режим + сброс. Collapses with scroll. */}
      <div ref={footerRef} style={{ flexShrink: 0, padding: '6px 10px 9px', background: 'rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, overflow: 'hidden', boxSizing: 'border-box' }}>
        {/* Команды и скиллы — иконка-открывашка drill-down выпадашки (без текста) */}
        <button type="button" title="Команды и скиллы Claude" onClick={() => { const next = !cmdOpen; setCmdOpen(next); if (next) { setPaletteNav('root'); setPaletteSearch(''); refreshSkills(); } setCmdIdx(0); setTimeout(() => taRef.current?.focus(), 0); }}
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 30, borderRadius: 8, cursor: 'pointer',
            background: cmdOpen ? 'rgba(var(--accent-rgb),0.28)' : 'rgba(255,255,255,0.05)', border: `1px solid ${cmdOpen ? 'rgba(var(--accent-rgb),0.5)' : 'var(--glass-border)'}`, color: 'var(--accent-bright)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
          </svg>
        </button>
        {/* Режим работы Claude — клик циклит (Shift+Tab) */}
        <button type="button" onClick={cycleMode} title="Сменить режим Claude (Shift+Tab)"
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, minHeight: 30, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 12.5, lineHeight: 1, userSelect: 'none',
            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', color: modeInfo.color }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}><polygon points="5 3 19 12 5 21 5 3" /></svg>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>режим:</span>
          <span style={{ color: modeInfo.color }}>{modeInfo.label}</span>
        </button>
        <span style={{ flex: 1, minWidth: 0 }} />
        {/* Сброс чата — пересвязать с папкой терминала, очистить ленту вида */}
        <button type="button" onClick={resetChat} title="Сбросить чат (пересвязать с папкой терминала)"
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, cursor: 'pointer',
            background: 'rgba(255,255,255,0.04)', border: '1px solid var(--glass-border)', color: 'var(--text-muted)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      </div>
      </div>{/* /composer */}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 28, height: 26, padding: '0 7px',
  borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
  background: 'rgba(255,255,255,0.04)', border: '1px solid var(--glass-border)', color: 'var(--text-muted)',
};

function pbtn(bg: string, border: string, color: string): React.CSSProperties {
  return { padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: bg, border: `1px solid ${border}`, color };
}
