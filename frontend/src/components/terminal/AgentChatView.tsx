import { useState, useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { resolveLiveSession, tailClaudeSession } from '../../api/claudeSessions';
import type { RichMessage } from '../../api/claudeSessions';
import { sendToTerminal, submitPromptToTerminal, getTerminalScreenState } from './Terminal';
import { onActivity } from '../../utils/activityBus';
import { getSessionHint } from '../../utils/terminalViewMode';
import { listFiles } from '../../api/files';
import ClaudeMessage from '../chat/ClaudeMessage';

// "Чат" — тонкая обёртка над живым `claude` в PTY: лента из JSONL, действия → клавиши в PTY.
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

interface Props {
  instanceId: string;
  cwd?: string;
  /** Показать настоящий экран терминала (родные меню: permission / rewind / resume). */
  onRequestTerminal?: () => void;
}

interface PermReq { tool: string; input: unknown }

// Tail-кэш на instanceId (переживает перемонтирование вида).
interface TailCache { project: string; sessionFile: string; sessionId: string; offset: number; messages: RichMessage[] }
const tailCache = new Map<string, TailCache>();
// instanceId, для которых claude уже хоть раз показал готовность (hook/экран). Module-level —
// переживает перемонтирование вида; решает «отправка до готовности claude теряется».
const readyInstances = new Set<string>();
// Черновик ввода на instanceId — переживает переключение вида (Чат↔Терминал размонтирует компонент).
const draftInputs = new Map<string, string>();
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

function permSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'url', 'pattern']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    try { return JSON.stringify(o, null, 2); } catch { /* ignore */ }
  }
  return '';
}

function messageText(m: RichMessage): string {
  return m.blocks.map(b => b.text || b.content || b.name || '').join(' ').toLowerCase();
}

export default function ClaudeChatView({ instanceId, cwd, onRequestTerminal }: Props) {
  const [messages, setMessages] = useState<RichMessage[]>(() => tailCache.get(instanceId)?.messages ?? []);
  const [perm, setPerm] = useState<PermReq | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'working' | 'error' | 'closed'>('connecting');
  const [workStatus, setWorkStatus] = useState(''); // живой статус из экрана: "Caramelizing… (5s · ↑ 87 tokens)"
  const [resumeMenu, setResumeMenu] = useState<{ info: string } | null>(null); // блокирующее меню "как восстановить"
  const [input, setInput] = useState(() => draftInputs.get(instanceId) || '');
  const [pillCollapsed, setPillCollapsed] = useState(false);
  // @-упоминания файлов: автокомплит по дереву cwd
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<{ name: string; is_dir: boolean }[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
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
  const targetRef = useRef<{ project: string; sessionFile: string; offset: number; sessionId: string } | null>(
    // offset из кэша берём ТОЛЬКО если есть кэш-сообщения, иначе 0 — иначе восстановимся
    // «в конце файла» без сообщений и чат будет пустым (хотя сессия полная).
    cInit ? { project: cInit.project, sessionFile: cInit.sessionFile, offset: cInit.messages?.length ? cInit.offset : 0, sessionId: cInit.sessionId } : null
  );
  const pollingRef = useRef(false);
  const emptyReloadRef = useRef(false); // один форс full-reload на сессию при offset>0 без сообщений
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // claude может ещё грузиться (~2-3с после запуска) — не теряем первое сообщение:
  // показываем оптимистично, но шлём в PTY, только когда claude реально готов
  // (детектор экрана busy/idle или hook). pendingSend — отложенный текст.
  const pendingSendRef = useRef<string | null>(null);
  // Детали последнего запроса доступа из хука (tool + input) — обогащают карточку,
  // видимостью которой управляет ЭКРАН (надёжно, не теряется при ремоунте).
  const permDetailsRef = useRef<{ tool?: string; input?: unknown } | null>(null);

  // Send raw bytes (keystrokes) to the live PTY.
  const sendKey = useCallback((data: string) => { sendToTerminal(instanceId, data); }, [instanceId]);

  const persist = useCallback(() => {
    const t = targetRef.current;
    if (t) tailCache.set(instanceId, { project: t.project, sessionFile: t.sessionFile, sessionId: t.sessionId, offset: t.offset, messages: messagesRef.current });
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
      if (!cur) {
        targetRef.current = { project: data.project, sessionFile: data.session_file, offset: 0, sessionId: data.session_id || '' };
        emptyReloadRef.current = false;
        setStatus('ready');
        poll(true);
      } else if (authoritative && data.session_id !== cur.sessionId) {
        // tier-1 указал другую сессию (чужой фолбэк / перезапуск) → переключаемся.
        // Оптимистичные плейсхолдеры СОХРАНЯЕМ — иначе отправленный текст пропадёт.
        tailCache.delete(instanceId);
        targetRef.current = { project: data.project, sessionFile: data.session_file, offset: 0, sessionId: data.session_id };
        const keptOpt = messagesRef.current.filter(m => m.uuid.startsWith('optimistic-'));
        messagesRef.current = keptOpt; // синхронно, чтобы параллельный poll не подмешал старую сессию
        setMessages(keptOpt);
        emptyReloadRef.current = false;
        setStatus('ready');
        poll(true);
      }
    } catch { /* claude ещё не стартовал — ретраим */ }
  }, [instanceId, cwd, poll]);

  useEffect(() => {
    reconcile();
    const iv = setInterval(reconcile, 3000);
    return () => { clearInterval(iv); recognitionRef.current?.abort(); };
  }, [reconcile]);

  useEffect(() => {
    poll();
    const id = setInterval(() => poll(), POLL_MS);
    return () => clearInterval(id);
  }, [status, poll]);

  // ── Hooks: только session-reconcile, режим и ДЕТАЛИ permission. Состояние экрана
  //    (busy/idle/think/меню/permission-видимость) берём из частого ОПРОСА ниже. ──
  useEffect(() => {
    return onActivity((e) => {
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
    const la = { busy: undefined as boolean | undefined, ws: '', resume: false, perm: false, mode: '' };
    const tick = () => {
      const st = getTerminalScreenState(instanceId);
      if (!st) return;
      if (st.alive) {
        readyInstances.add(instanceId);
        const pend = pendingSendRef.current;
        if (pend && !st.resumeMenu && !st.permMenu) { pendingSendRef.current = null; submitPromptToTerminal(instanceId, pend); setTimeout(() => poll(), 600); }
      }
      // Режим claude — из экрана (надёжно, не теряется при ремоунте/смене вида).
      if (st.mode && st.mode !== la.mode) { la.mode = st.mode; setMode(st.mode as PermissionMode); }
      if (st.busy !== la.busy) { la.busy = st.busy; setStatus(st.busy ? 'working' : 'ready'); }
      const ws = st.busy ? st.workStatus : '';
      if (ws !== la.ws) { la.ws = ws; setWorkStatus(ws); }
      if (st.resumeMenu !== la.resume) { la.resume = st.resumeMenu; setResumeMenu(st.resumeMenu ? { info: st.resumeInfo } : null); }
      if (st.permMenu !== la.perm) {
        la.perm = st.permMenu;
        if (st.permMenu) { const d = permDetailsRef.current; setPerm({ tool: d?.tool || st.permQuestion, input: d?.input }); }
        else { setPerm(null); permDetailsRef.current = null; }
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
  const FOOTER_H = 32; // mode-line full height

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
    setInput('');
    setMention(null);
    stick.current = true;
    // Оптимистично показываем СВОЁ сообщение сразу — реальное из JSONL дедуплицирует его
    // (mergeMsgs). Статус 'working' НЕ ставим оптимистично — он придёт из чтения экрана
    // (terminal_busy), когда claude реально начнёт; при сорванном сабмите стоп не загорится.
    const optimistic: RichMessage = { uuid: `optimistic-${Date.now()}`, role: 'user', blocks: [{ kind: 'text', text }] };
    setMessages(prev => { const next = [...prev, optimistic]; messagesRef.current = next; return next; });
    // Если открыто блокирующее меню (permission/resume) — НЕЛЬЗЯ слать текст: Enter в конце
    // подтвердил бы меню (по умолчанию ❯ Yes). Придерживаем до закрытия меню.
    const scr = getTerminalScreenState(instanceId);
    const menuUp = !!(scr && (scr.resumeMenu || scr.permMenu));
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
        if (s && (s.resumeMenu || s.permMenu)) return; // меню ещё открыто — НЕ отправляем
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
  const decide = useCallback((digit: '1' | '2' | '3') => {
    sendKey(digit);
    setPerm(null);
    setTimeout(() => poll(), 400);
  }, [sendKey, poll]);

  // Ответ на меню "как восстановить" (claude --resume): 1=из сводки, 2=полностью, 3=не спрашивать.
  const resumeChoose = useCallback((digit: '1' | '2' | '3') => {
    sendKey(digit);
    setResumeMenu(null);
    setTimeout(() => poll(), 500);
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
      {/* Slim toolbar: Find + Font (ported from terminal) */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.12)' }}>
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

        {/* (4) permission lives in the conversation flow — never overlays the input */}
        {!query && perm && (
          <div style={{ margin: '10px 0', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(var(--accent-rgb),0.45)', background: 'rgba(var(--accent-rgb),0.1)' }}>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 6 }}>
                Claude запрашивает доступ: <b style={{ color: 'var(--accent-bright)' }}>{perm.tool}</b>
              </div>
              {/* (1) expandable full request */}
              <details style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--glass-border)', borderRadius: 8 }}>
                <summary style={{ cursor: 'pointer', padding: '6px 10px', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  <span style={{ flexShrink: 0 }}>▸</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{permSummary(perm.input).split('\n')[0]}</span>
                </summary>
                <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11, lineHeight: 1.45, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-secondary)', borderTop: '1px solid var(--glass-border)', maxHeight: 220, overflow: 'auto' }}>
                  {permSummary(perm.input)}
                </pre>
              </details>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 12px', borderTop: '1px solid var(--glass-border)' }}>
              <button type="button" onClick={() => decide('1')} style={pbtn('rgba(var(--success-rgb),0.18)', 'rgba(var(--success-rgb),0.4)', 'var(--success)')}>Да</button>
              <button type="button" onClick={() => decide('2')} style={pbtn('rgba(var(--accent-rgb),0.18)', 'rgba(var(--accent-rgb),0.4)', 'var(--accent-bright)')}>Да навсегда</button>
              <button type="button" onClick={() => decide('3')} style={pbtn('rgba(var(--danger-rgb),0.12)', 'rgba(var(--danger-rgb),0.35)', 'var(--danger)')}>Нет</button>
              {onRequestTerminal && (
                <button type="button" onClick={() => { setPerm(null); onRequestTerminal(); }} style={pbtn('rgba(255,255,255,0.05)', 'var(--glass-border)', 'var(--text-secondary)')}>⌨ Открыть терминал</button>
              )}
            </div>
          </div>
        )}

        {/* Живой индикатор «думает» — из чтения экрана (видно, что claude не висит) */}
        {status === 'working' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px 2px', color: 'var(--accent-bright)', fontSize: 12.5 }}>
            <span className="claude-chat-pulse" style={{ fontSize: 14, lineHeight: 1 }}>✻</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workStatus || 'Claude думает…'}</span>
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
        <textarea
          ref={taRef}
          className="agent-input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setMention(detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length));
          }}
          onFocus={expandComposer}
          onKeyDown={(e) => {
            if (mention && mentionFiles.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => Math.min(i + 1, mentionFiles.length - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => Math.max(i - 1, 0)); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionFiles[mentionIdx]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser(); }
            else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); }
          }}
          placeholder="Сообщение для Claude… (@ — файл)"
          rows={1}
          style={{ flex: 1, resize: 'none', minHeight: 38, padding: '9px 12px', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4, background: 'rgba(var(--accent-rgb),0.06)', border: '1px solid var(--glass-border)', color: 'var(--text-primary)', outline: 'none' }}
        />
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

      {/* (6) mode footer under input — colored, click / Shift+Tab cycles. Collapses with scroll. */}
      <div ref={footerRef} style={{ flexShrink: 0, padding: '6px 12px 9px', background: 'rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, overflow: 'hidden', boxSizing: 'border-box' }}>
        <span onClick={cycleMode} title="Сменить режим (Shift+Tab)" style={{ cursor: 'pointer', fontWeight: 600, userSelect: 'none', color: modeInfo.color }}>
          ⏵ {modeInfo.label}
        </span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>shift+tab — сменить режим</span>
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
