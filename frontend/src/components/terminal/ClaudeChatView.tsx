import { useState, useEffect, useRef, useCallback } from 'react';
import { resolveLiveSession, tailClaudeSession } from '../../api/claudeSessions';
import type { RichMessage } from '../../api/claudeSessions';
import { onActivity } from '../../utils/activityBus';
import { sendCommandWhenReady, sendToTerminal } from './Terminal';
import ClaudeMessage from '../chat/ClaudeMessage';

interface Props {
  /** Live mode: terminal instance running claude. */
  instanceId?: string;
  /** Hint: dir claude was launched in (improves live resolution without hooks). */
  cwd?: string;
  /** History mode: render a specific past session (read-only). */
  project?: string;
  sessionFile?: string;
  readOnly?: boolean;
}

// Module-level cache so toggling Terminal⇄Chat / hiding the panel keeps the
// rendered conversation, byte offset and scroll position (no reload, no jump).
interface ChatCache {
  project: string;
  sessionFile: string;
  sessionId: string;
  offset: number;
  messages: RichMessage[];
  scrollTop: number;
}
const chatCache = new Map<string, ChatCache>();

const POLL_MS = 1500;

function mergeMessages(prev: RichMessage[], incoming: RichMessage[]): RichMessage[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map(m => m.uuid));
  const add = incoming.filter(m => m.uuid && !seen.has(m.uuid));
  if (add.length === 0) return prev;
  return [...prev, ...add];
}

export default function ClaudeChatView({ instanceId, cwd, project, sessionFile, readOnly }: Props) {
  const live = !!instanceId && !readOnly;
  const cacheKey = live ? `live:${instanceId}` : `hist:${project}/${sessionFile}`;

  const [messages, setMessages] = useState<RichMessage[]>(() => chatCache.get(cacheKey)?.messages ?? []);
  const [pending, setPending] = useState<RichMessage[]>([]);
  const [status, setStatus] = useState('');
  const [resolving, setResolving] = useState(true);
  const [input, setInput] = useState('');

  // Resolved target (project/sessionFile/offset/sessionId) lives in a ref so the
  // poll loop reads the latest without re-subscribing.
  const cachedInit = chatCache.get(cacheKey);
  const targetRef = useRef<{ project: string; sessionFile: string; offset: number; sessionId: string } | null>(
    cachedInit
      ? { project: cachedInit.project, sessionFile: cachedInit.sessionFile, offset: cachedInit.offset, sessionId: cachedInit.sessionId }
      : null
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const persist = useCallback(() => {
    const t = targetRef.current;
    if (!t) return;
    chatCache.set(cacheKey, {
      project: t.project, sessionFile: t.sessionFile, sessionId: t.sessionId,
      offset: t.offset, messages: messagesRef.current,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  }, [cacheKey]);

  // ── Resolve target ──
  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      // History mode: target is given.
      if (!live && project && sessionFile) {
        if (!targetRef.current) targetRef.current = { project, sessionFile, offset: 0, sessionId: '' };
        if (!cancelled) setResolving(false);
        return;
      }
      // Live mode: ask backend which JSONL this terminal writes to.
      if (live && instanceId) {
        if (targetRef.current) { if (!cancelled) setResolving(false); return; }
        try {
          const { data } = await resolveLiveSession(instanceId, cwd);
          if (cancelled) return;
          if (data.session_file) {
            targetRef.current = { project: data.project, sessionFile: data.session_file, offset: 0, sessionId: data.session_id || '' };
            setResolving(false);
          }
        } catch {
          // claude not started yet — retry below
        }
      }
    }

    resolve();
    // Retry resolution every 2s until we have a target (live, waiting for claude).
    const retry = setInterval(() => { if (!targetRef.current) resolve(); }, 2000);
    return () => { cancelled = true; clearInterval(retry); };
  }, [live, instanceId, cwd, project, sessionFile]);

  // ── Poll tail ──
  const pollingRef = useRef(false);
  const poll = useCallback(async (full = false): Promise<void> => {
    const t = targetRef.current;
    if (!t || pollingRef.current) return;
    pollingRef.current = true;
    try {
      const { data } = await tailClaudeSession(t.project, t.sessionFile, full ? 0 : t.offset);
      t.offset = data.offset;
      if (data.session_id) t.sessionId = data.session_id;
      if (data.messages.length === 0) return;

      const sc = scrollRef.current;
      stickToBottomRef.current = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 100;

      if (full) {
        setMessages(data.messages);
      } else {
        // Rewind/branch detection: if the first new message's parent isn't the
        // last shown message, the active branch changed → full reload.
        const cur = messagesRef.current;
        const first = data.messages[0];
        const lastUuid = cur.length ? cur[cur.length - 1].uuid : '';
        const known = new Set(cur.map(m => m.uuid));
        if (cur.length > 0 && first.parent_uuid && lastUuid && first.parent_uuid !== lastUuid && !known.has(first.uuid)) {
          pollingRef.current = false;
          return poll(true);
        }
        setMessages(prev => mergeMessages(prev, data.messages));
      }
      // Real user messages arrived → drop matching optimistic ones.
      setPending(prevP => prevP.filter(p =>
        !data.messages.some(m => m.role === 'user' && m.blocks.some(b => b.kind === 'text' && b.text === p.blocks[0]?.text))
      ));
    } catch {
      /* transient */
    } finally {
      pollingRef.current = false;
      persist();
    }
  }, [persist]);

  useEffect(() => {
    if (resolving && !targetRef.current) return;
    poll();
    if (!live) return; // history: single load
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [resolving, live, poll]);

  // ── Live activity (hooks + terminal streaming) ──
  useEffect(() => {
    if (!live || !instanceId) return;
    return onActivity((e) => {
      if ('instanceId' in e && e.instanceId !== instanceId) return;
      switch (e.type) {
        case 'claude_hook':
          if (e.event === 'PreToolUse') setStatus(`▶ ${e.tool || 'инструмент'}…`);
          else if (e.event === 'PostToolUse') setStatus('обработка…');
          else if (e.event === 'UserPromptSubmit') setStatus('Claude думает…');
          else if (e.event === 'Stop' || e.event === 'SessionEnd') setStatus('');
          poll(); // hook = something changed → pull JSONL now
          break;
        case 'terminal_streaming_start':
          if (!status) setStatus('Claude работает…');
          break;
        case 'terminal_streaming_end':
          setStatus('');
          poll();
          break;
      }
    });
  }, [live, instanceId, poll, status]);

  // ── Scroll handling ──
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const cached = chatCache.get(cacheKey);
    if (cached && cached.scrollTop > 0) sc.scrollTop = cached.scrollTop;
    else sc.scrollTop = sc.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sc = scrollRef.current;
    if (sc && stickToBottomRef.current) sc.scrollTop = sc.scrollHeight;
  }, [messages, pending, status]);

  const handleScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    stickToBottomRef.current = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 100;
  }, []);

  // Persist messages/offset/scroll on unmount (e.g. toggling back to terminal).
  useEffect(() => () => persist(), [persist]);

  // ── Send ──
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !instanceId) return;
    setInput('');
    setPending(prev => [...prev, { uuid: `pending-${Date.now()}`, role: 'user', blocks: [{ kind: 'text', text }] }]);
    stickToBottomRef.current = true;
    const ok = await sendCommandWhenReady(instanceId, text);
    if (!ok) setStatus('Терминал недоступен');
    setTimeout(poll, 400);
  }, [input, instanceId, poll]);

  const sendKey = useCallback((data: string) => { if (instanceId) sendToTerminal(instanceId, data); }, [instanceId]);

  const all = [...messages, ...pending];
  const empty = all.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg, transparent)' }}>
      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px', WebkitOverflowScrolling: 'touch' }}>
        {empty && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            {resolving && live ? 'Ожидание запуска Claude…' : 'Пока нет сообщений.'}
          </div>
        )}
        {all.map((m) => <ClaudeMessage key={m.uuid} msg={m} />)}
        {status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', margin: '4px 0', fontSize: 12, color: 'var(--accent)' }}>
            <span className="claude-chat-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
            {status}
          </div>
        )}
      </div>

      {/* Input (live only) */}
      {live && (
        <div style={{ flexShrink: 0, borderTop: '1px solid var(--glass-border)', padding: 8, background: 'rgba(0,0,0,0.15)' }}>
          {/* Quick control keys for TUI menus / approvals */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            {[
              { label: 'Enter', data: '\r' },
              { label: 'Esc', data: '\x1b' },
              { label: '↑', data: '\x1b[A' },
              { label: '↓', data: '\x1b[B' },
              { label: '1', data: '1\r' },
              { label: '2', data: '2\r' },
              { label: 'y', data: 'y\r' },
              { label: 'n', data: 'n\r' },
            ].map(k => (
              <button key={k.label} type="button" onClick={() => sendKey(k.data)}
                style={{ padding: '5px 11px', borderRadius: 6, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                  background: 'rgba(var(--accent-rgb),0.08)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
                {k.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Сообщение для Claude…"
              rows={1}
              style={{
                flex: 1, resize: 'none', maxHeight: 120, minHeight: 38, padding: '9px 12px',
                borderRadius: 10, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4,
                background: 'rgba(var(--accent-rgb),0.06)', border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)', outline: 'none',
              }}
            />
            <button type="button" onClick={send} disabled={!input.trim()}
              style={{
                flexShrink: 0, width: 38, height: 38, borderRadius: 10, cursor: input.trim() ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(var(--accent-rgb),0.2)', border: '1px solid rgba(var(--accent-rgb),0.4)',
                color: 'var(--accent-bright)', opacity: input.trim() ? 1 : 0.5,
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
