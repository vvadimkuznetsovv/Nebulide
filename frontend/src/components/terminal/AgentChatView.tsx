import { useState, useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { resolveLiveSession, tailClaudeSession } from '../../api/claudeSessions';
import type { RichMessage } from '../../api/claudeSessions';
import { sendToTerminal, sendCommandWhenReady } from './Terminal';
import { onActivity } from '../../utils/activityBus';
import ClaudeMessage from '../chat/ClaudeMessage';

// "Чат" — тонкая обёртка над живым `claude` в PTY: лента из JSONL, действия → клавиши в PTY.
type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

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
const POLL_MS = 1200;
function mergeMsgs(prev: RichMessage[], inc: RichMessage[]): RichMessage[] {
  if (!inc.length) return prev;
  const seen = new Set(prev.map(m => m.uuid));
  const add = inc.filter(m => m.uuid && !seen.has(m.uuid));
  return add.length ? [...prev, ...add] : prev;
}

const FONT_KEY = 'nebulide-agent-font-size';

// Permission modes — shown as a footer label under the input, cycled by
// click / Shift+Tab, colored per mode (classic Claude Code style).
const MODES: { id: PermissionMode; label: string; color: string }[] = [
  { id: 'default', label: 'Обычный', color: 'var(--text-muted)' },
  { id: 'plan', label: 'План', color: 'var(--success)' },
  { id: 'acceptEdits', label: 'Авто-правки', color: 'var(--accent-bright)' },
  { id: 'bypassPermissions', label: 'Всё разрешено', color: 'var(--warning)' },
];

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
  const [input, setInput] = useState('');
  const [pillCollapsed, setPillCollapsed] = useState(false);
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
    cInit ? { project: cInit.project, sessionFile: cInit.sessionFile, offset: cInit.offset, sessionId: cInit.sessionId } : null
  );
  const pollingRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Send raw bytes (keystrokes) to the live PTY.
  const sendKey = useCallback((data: string) => { sendToTerminal(instanceId, data); }, [instanceId]);

  const persist = useCallback(() => {
    const t = targetRef.current;
    if (t) tailCache.set(instanceId, { project: t.project, sessionFile: t.sessionFile, sessionId: t.sessionId, offset: t.offset, messages: messagesRef.current });
  }, [instanceId]);

  // ── Resolve the live session (which JSONL this terminal's claude writes) ──
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (targetRef.current) { if (!cancelled) setStatus('ready'); return; }
      try {
        const { data } = await resolveLiveSession(instanceId, cwd);
        if (cancelled) return;
        if (data.session_file) {
          targetRef.current = { project: data.project, sessionFile: data.session_file, offset: 0, sessionId: data.session_id || '' };
          setStatus('ready');
        }
      } catch { /* claude not started yet — retry */ }
    }
    resolve();
    const retry = setInterval(() => { if (!targetRef.current) resolve(); }, 2000);
    return () => { cancelled = true; clearInterval(retry); recognitionRef.current?.abort(); };
  }, [instanceId, cwd]);

  // ── Poll the JSONL tail (incremental; rewind → full reload via parent_uuid break) ──
  const poll = useCallback(async (full = false): Promise<void> => {
    const t = targetRef.current;
    if (!t || pollingRef.current) return;
    pollingRef.current = true;
    try {
      const { data } = await tailClaudeSession(t.project, t.sessionFile, full ? 0 : t.offset);
      t.offset = data.offset;
      if (data.session_id) t.sessionId = data.session_id;
      if (!data.messages.length) return;
      const sc = scrollRef.current;
      stick.current = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
      if (full) { setMessages(data.messages); return; }
      const cur = messagesRef.current;
      const first = data.messages[0];
      const lastUuid = cur.length ? cur[cur.length - 1].uuid : '';
      const known = new Set(cur.map(m => m.uuid));
      if (cur.length > 0 && first.parent_uuid && lastUuid && first.parent_uuid !== lastUuid && !known.has(first.uuid)) {
        pollingRef.current = false;
        return poll(true);
      }
      setMessages(prev => mergeMsgs(prev, data.messages));
    } catch { /* transient */ }
    finally { pollingRef.current = false; persist(); }
  }, [persist]);

  useEffect(() => {
    poll();
    const id = setInterval(() => poll(), POLL_MS);
    return () => clearInterval(id);
  }, [status, poll]);

  // ── Live signals from Claude Code hooks (permission / mode / working) ──
  useEffect(() => {
    return onActivity((e) => {
      if ('instanceId' in e && e.instanceId !== instanceId) return;
      if (e.type === 'claude_hook') {
        if (e.permissionMode) setMode(e.permissionMode as PermissionMode);
        if (e.event === 'PreToolUse' || e.event === 'UserPromptSubmit') setStatus('working');
        else if (e.event === 'Stop' || e.event === 'SessionEnd') { setStatus('ready'); setPerm(null); }
        if (e.event === 'PermissionRequest' || e.event === 'Notification') {
          setPillCollapsed(false);
          setPerm({ tool: e.tool || 'инструмент', input: e.toolInput });
        }
        poll();
      } else if (e.type === 'terminal_streaming_start') {
        setStatus('working');
      } else if (e.type === 'terminal_streaming_end') {
        setStatus('ready'); poll();
      }
    });
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

  const expandComposer = useCallback(() => {
    const sc = scrollRef.current;
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  }, []);

  const sendUser = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setStatus('working');
    stick.current = true;
    sendCommandWhenReady(instanceId, text); // текст + Enter в реальный claude (PTY)
    setTimeout(() => poll(), 400);
  }, [input, instanceId, poll]);

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

  // Сменить режим = Shift+Tab в реальный claude (циклит default→acceptEdits→plan…).
  const cycleMode = useCallback(() => {
    sendKey('\x1b[Z');
    const i = MODES.findIndex(x => x.id === mode);
    setMode(MODES[(i + 1) % MODES.length].id); // оптимистично; точный режим придёт по hook
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
  const modeInfo = MODES.find(x => x.id === mode) || MODES[0];

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
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /></svg>
            </button>
          )
        )}
        <textarea
          ref={taRef}
          className="agent-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={expandComposer}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser(); }
            else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); }
          }}
          placeholder="Сообщение для Claude…"
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
