import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  listLLMSessions,
  createLLMSession,
  deleteLLMSession,
  getLLMMessages,
  sendLLMMessage,
  analyzeImage,
  trimLLMContext,
  type LLMSession,
  type LLMMessage,
} from '../../api/llm';
import api from '../../api/client';
import toast from 'react-hot-toast';

const MAX_INPUT_CHARS = 100000;

// ── Icons ──
const MicIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);
const CopyIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);
const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);
const PunctuateIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="18" r="1.5" fill="currentColor" /><circle cx="14" cy="18" r="1.5" fill="currentColor" />
    <path d="M10 4c0 4-6 6-6 10" /><line x1="18" y1="4" x2="18" y2="14" />
  </svg>
);
const EnhanceIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);
const SearchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const RetryIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);
const EditIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);
const AttachIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);
const GlobeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);
const TrashIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => toast.success('Copied', { duration: 1000 })).catch(() => toast.error('Copy failed', { duration: 3000 }));
}

export default function LLMPanel() {
  const [sessions, setSessions] = useState<LLMSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LLMMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [showSessions, setShowSessions] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ file: File; preview: string } | null>(null);
  const [analyzingImage, setAnalyzingImage] = useState(false);
  const [totalChars, setTotalChars] = useState(0);
  const [showTrimConfirm, setShowTrimConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listLLMSessions().then((r) => setSessions(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeSessionId) { setMessages([]); return; }
    getLLMMessages(activeSessionId).then((r) => { setMessages(r.data.messages || []); setTotalChars(r.data.total_chars || 0); }).catch(() => {});
  }, [activeSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamContent]);

  // Search filter
  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  const handleNewChat = useCallback(async () => {
    try {
      const res = await createLLMSession();
      setSessions((prev) => [res.data, ...prev]);
      setActiveSessionId(res.data.id);
      setShowSessions(false);
    } catch { toast.error('Failed to create chat', { duration: 4000 }); }
  }, []);

  const handleDeleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteLLMSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) { setActiveSessionId(null); setMessages([]); }
    } catch { toast.error('Failed to delete chat', { duration: 4000 }); }
  }, [activeSessionId]);

  // Stop streaming
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    if (streamContent) {
      // Keep partial response as a message
      setMessages((prev) => [...prev, {
        id: 'partial-' + Date.now(), session_id: activeSessionId || '',
        role: 'assistant', content: streamContent + '\n\n[Stopped]', in_context: true, created_at: new Date().toISOString(),
      }]);
      setStreamContent('');
    }
  }, [streamContent, activeSessionId]);

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handleSend = useCallback(async (overrideContent?: string) => {
    const content = (overrideContent || input).trim();
    if ((!content && !attachedImage) || !activeSessionId || streaming) return;
    if (!overrideContent) setInput('');
    setStreaming(true);
    setStreamContent('');

    // Analyze image if attached
    let imageDescription = '';
    const currentImage = attachedImage;
    if (currentImage) {
      setAnalyzingImage(true);
      setAttachedImage(null);
      try {
        const base64 = await fileToBase64(currentImage.file);
        const visionRes = await analyzeImage(base64);
        imageDescription = visionRes.data.description;
      } catch {
        toast.error('Failed to analyze image', { duration: 4000 });
      }
      setAnalyzingImage(false);
    }

    const displayContent = content || (imageDescription ? '[Image sent]' : '');
    const userMsg: LLMMessage = {
      id: 'temp-' + Date.now(), session_id: activeSessionId,
      role: 'user', content: imageDescription ? `🖼️ ${displayContent}` : displayContent, in_context: true, created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Build content with web search prefix if enabled
    let finalContent = content || 'Describe and analyze this image.';
    if (webSearch) {
      finalContent = `[Web Search Enabled] ${finalContent}\n\nPlease search the internet for the most up-to-date information to answer this question. Include sources/URLs where possible.`;
    }

    const abort = new AbortController();
    abortRef.current = abort;

    sendLLMMessage(activeSessionId, finalContent,
      (chunk) => { if (!abort.signal.aborted) setStreamContent((prev) => prev + chunk); },
      () => {
        setStreaming(false);
        getLLMMessages(activeSessionId).then((r) => { setMessages(r.data.messages || []); setStreamContent(''); setTotalChars(r.data.total_chars || 0); });
        listLLMSessions().then((r) => setSessions(r.data || []));
      },
      (err) => { setStreaming(false); setStreamContent(''); if (!abort.signal.aborted) toast.error('LLM error: ' + err.slice(0, 100), { duration: 5000 }); },
      imageDescription || undefined,
    );
  }, [input, activeSessionId, streaming, webSearch, attachedImage]);

  // Retry last user message
  const handleRetry = useCallback(() => {
    if (streaming) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // Remove last assistant message
    setMessages((prev) => {
      const idx = prev.length - 1;
      if (idx >= 0 && prev[idx].role === 'assistant') return prev.slice(0, idx);
      return prev;
    });
    handleSend(lastUser.content);
  }, [messages, streaming, handleSend]);

  // Edit & resend a user message
  const handleEditSend = useCallback(() => {
    if (!editText.trim() || !editingMsgId || !activeSessionId) return;
    // Remove this message and everything after it
    const idx = messages.findIndex((m) => m.id === editingMsgId);
    if (idx >= 0) setMessages((prev) => prev.slice(0, idx));
    setEditingMsgId(null);
    handleSend(editText.trim());
    setEditText('');
  }, [editText, editingMsgId, activeSessionId, messages, handleSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Voice
  const toggleVoice = useCallback(async () => {
    if (voiceActive) { recognitionRef.current?.stop(); setVoiceActive(false); return; }
    const SR = window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) { toast.error('Speech recognition not supported', { duration: 4000 }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch {
      toast.error('Microphone access denied. Check site permissions in browser settings.', { duration: 5000 });
      return;
    }
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (e: SpeechRecognitionEvent) => {
        const text = e.results[e.results.length - 1][0].transcript;
        setInput((prev) => prev ? prev + ' ' + text : text);
      };
      rec.onerror = () => setVoiceActive(false);
      rec.onend = () => setVoiceActive(false);
      recognitionRef.current = rec;
      rec.start();
      setVoiceActive(true);
    } catch (e) {
      toast.error('Voice input failed: ' + String(e), { duration: 4000 });
    }
  }, [voiceActive]);

  const handleTrim = useCallback(async (keep: number) => {
    if (!activeSessionId) return;
    try {
      await trimLLMContext(activeSessionId, keep);
      const r = await getLLMMessages(activeSessionId);
      setMessages(r.data.messages || []);
      setTotalChars(r.data.total_chars || 0);
      setShowTrimConfirm(false);
      toast.success(`Context trimmed, keeping last ${keep} messages`);
    } catch { toast.error('Trim failed', { duration: 4000 }); }
  }, [activeSessionId]);

  const handleTransform = useCallback(async (endpoint: 'punctuate' | 'enhance') => {
    if (!input.trim() || processing) return;
    setProcessing(true);
    try {
      const res = await api.post<{ result: string }>(`/llm/${endpoint}`, { text: input });
      setInput(res.data.result);
    } catch { toast.error(`${endpoint} failed`, { duration: 4000 }); }
    setProcessing(false);
    inputRef.current?.focus();
  }, [input, processing]);

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  // ── Session list ──
  if (showSessions && !activeSessionId) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>LLM Chats</span>
          <button type="button" className="btn-glass px-2 py-1 rounded text-[11px]" onClick={handleNewChat}>+ New</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mx-auto mb-2" style={{ opacity: 0.15, color: 'var(--accent)' }}>
                  <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
                </svg>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No chats yet</p>
              </div>
            </div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className="group px-3 py-2.5 cursor-pointer transition-colors"
              style={{ borderBottom: '1px solid var(--glass-border)' }}
              onClick={() => { setActiveSessionId(s.id); setShowSessions(false); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--glass-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs truncate flex-1" style={{ color: 'var(--text-primary)' }}>{s.title}</span>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{timeAgo(s.updated_at)}</span>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--text-tertiary)' }}
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    title="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{s.model.split('/').pop()}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Chat view ──
  const displayMessages = searchQuery.trim() ? filteredMessages : messages;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--glass-border)' }}>
        <button type="button" className="btn-glass p-1 rounded" onClick={() => { setShowSessions(true); setActiveSessionId(null); setSearchOpen(false); setSearchQuery(''); }} title="Back">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs truncate flex-1" style={{ color: 'var(--text-secondary)' }}>
          {sessions.find((s) => s.id === activeSessionId)?.title || 'Chat'}
        </span>
        <button type="button" className={`btn-glass p-1 rounded${searchOpen ? ' active' : ''}`}
          onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearchQuery(''); }} title="Search chat">
          <SearchIcon />
        </button>
        <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(127,0,255,0.1)', color: 'var(--accent)', border: '1px solid rgba(127,0,255,0.2)' }}>
          {sessions.find((s) => s.id === activeSessionId)?.model.split('/').pop() || 'LLM'}
        </span>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="px-3 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--glass-border)' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="glass-input w-full px-2.5 py-1.5 rounded text-xs"
            autoFocus
          />
          {searchQuery && (
            <div className="text-[9px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {filteredMessages.length} of {messages.length} messages
            </div>
          )}
        </div>
      )}

      {/* Context warning */}
      {totalChars > 250000 && !showTrimConfirm && (
        <div className="px-3 py-1.5 shrink-0 flex items-center gap-2" style={{
          background: 'rgba(255, 150, 0, 0.1)', borderBottom: '1px solid rgba(255, 150, 0, 0.3)',
        }}>
          <span className="text-[10px]" style={{ color: 'rgb(255, 180, 50)' }}>
            ⚠️ Context approaching limit ({Math.round(totalChars / 1000)}k / ~300k chars)
          </span>
          <button type="button" className="btn-glass px-2 py-0.5 rounded text-[10px]"
            onClick={() => setShowTrimConfirm(true)}
            style={{ color: 'rgb(255, 180, 50)', border: '1px solid rgba(255, 150, 0, 0.3)' }}>
            Trim context
          </button>
        </div>
      )}

      {/* Trim confirmation */}
      {showTrimConfirm && (
        <div className="px-3 py-2 shrink-0" style={{
          background: 'rgba(255, 150, 0, 0.08)', borderBottom: '1px solid rgba(255, 150, 0, 0.2)',
        }}>
          <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            Old messages will be marked as out-of-context. History stays visible but AI won't see them. Keep last:
          </p>
          <div className="flex items-center gap-1.5">
            {[10, 20, 40, 60].map((n) => (
              <button key={n} type="button" className="btn-glass px-2 py-1 rounded text-[10px]"
                onClick={() => handleTrim(n)}>
                {n} msgs
              </button>
            ))}
            <div className="flex-1" />
            <button type="button" className="btn-glass px-2 py-1 rounded text-[10px]"
              onClick={() => setShowTrimConfirm(false)} style={{ color: 'var(--text-muted)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {displayMessages.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {searchQuery ? 'No matches' : 'Start a conversation'}
            </p>
          </div>
        )}
        {displayMessages.map((msg, idx) => {
          // Show context boundary divider
          const prevMsg = idx > 0 ? displayMessages[idx - 1] : null;
          const showBoundary = prevMsg && !prevMsg.in_context && msg.in_context;
          return (
          <div key={msg.id}>
            {showBoundary && (
              <div className="flex items-center gap-2 my-2">
                <div className="flex-1 h-px" style={{ background: 'rgba(127, 0, 255, 0.3)' }} />
                <span className="text-[8px] shrink-0" style={{ color: 'var(--accent)' }}>Context starts here</span>
                <div className="flex-1 h-px" style={{ background: 'rgba(127, 0, 255, 0.3)' }} />
              </div>
            )}
          <div className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            style={msg.in_context === false ? { opacity: 0.4 } : {}}>
            <div className="relative max-w-[85%]">
              <div className="text-[9px] mb-0.5 px-1" style={{ color: 'var(--text-tertiary)' }}>
                {msg.role === 'user' ? 'You' : 'AI'}
              </div>

              {/* Edit mode */}
              {editingMsgId === msg.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="glass-input px-3 py-2 rounded-lg text-xs"
                    style={{ resize: 'none', minHeight: '50px', maxHeight: '150px', overflowY: 'auto' }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" className="btn-glass px-2 py-1 rounded text-[10px]" onClick={handleEditSend}>Send</button>
                    <button type="button" className="btn-glass px-2 py-1 rounded text-[10px]" onClick={() => setEditingMsgId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Message bubble */}
                  <div
                    className="px-3 py-2 rounded-lg text-xs"
                    style={{
                      background: msg.role === 'user' ? 'rgba(127, 0, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                      border: `1px solid ${msg.role === 'user' ? 'rgba(127, 0, 255, 0.25)' : 'var(--glass-border)'}`,
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      lineHeight: 1.5,
                    }}
                  >
                    {msg.content}
                  </div>
                  {/* Action buttons */}
                  <div
                    className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 mt-0.5"
                    style={{ justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
                  >
                    <button type="button" className="btn-glass p-1 rounded" onClick={() => copyToClipboard(msg.content)} title="Copy">
                      <CopyIcon />
                    </button>
                    {msg.role === 'user' && (
                      <button type="button" className="btn-glass p-1 rounded" onClick={() => { setEditingMsgId(msg.id); setEditText(msg.content); }} title="Edit & resend">
                        <EditIcon />
                      </button>
                    )}
                    {msg.role === 'assistant' && msg.id === messages[messages.length - 1]?.id && (
                      <button type="button" className="btn-glass p-1 rounded" onClick={handleRetry} title="Retry">
                        <RetryIcon />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          </div>
          );
        })}
        {streaming && streamContent && (
          <div className="flex justify-start">
            <div className="max-w-[85%]">
              <div className="text-[9px] mb-0.5 px-1" style={{ color: 'var(--text-tertiary)' }}>AI</div>
              <div
                className="px-3 py-2 rounded-lg text-xs"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)', border: '1px solid var(--glass-border)',
                  color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
                }}
              >
                {streamContent}<span className="animate-pulse">▊</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 px-3 py-2" style={{ borderTop: '1px solid var(--glass-border)' }}>
        {/* Hidden file input */}
        <input type="file" accept="image/*" hidden ref={fileInputRef}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) setAttachedImage({ file, preview: URL.createObjectURL(file) });
            e.target.value = '';
          }}
        />

        {/* Image preview */}
        {attachedImage && (
          <div className="mb-1.5 relative inline-block">
            <img src={attachedImage.preview} alt="Attached" style={{
              maxHeight: 60, maxWidth: 120, borderRadius: 6,
              border: '1px solid var(--glass-border)', objectFit: 'cover',
            }} />
            <button type="button" className="absolute -top-1.5 -right-1.5 btn-glass rounded-full p-0.5"
              onClick={() => { URL.revokeObjectURL(attachedImage.preview); setAttachedImage(null); }} title="Remove image">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
        {analyzingImage && (
          <div className="text-[9px] mb-1 px-1 animate-pulse" style={{ color: 'var(--accent)' }}>
            🖼️ Analyzing image with vision model...
          </div>
        )}

        {/* Tools row */}
        <div className="flex items-center gap-1 mb-1.5">
          <button type="button" className={`btn-glass p-1.5 rounded${voiceActive ? ' active' : ''}`}
            onClick={toggleVoice} title="Voice input"
            style={voiceActive ? { background: 'rgba(255,50,50,0.2)', border: '1px solid rgba(255,50,50,0.4)', color: '#f55' } : {}}>
            <MicIcon />
          </button>
          <button type="button" className="btn-glass p-1.5 rounded" onClick={() => fileInputRef.current?.click()}
            title="Attach image">
            <AttachIcon />
          </button>
          <button type="button" className="btn-glass p-1.5 rounded" onClick={() => handleTransform('enhance')}
            disabled={processing || !input.trim()} title="Enhance prompt" style={{ opacity: processing || !input.trim() ? 0.3 : 1 }}>
            <EnhanceIcon />
          </button>
          <button type="button" className="btn-glass p-1.5 rounded" onClick={() => handleTransform('punctuate')}
            disabled={processing || !input.trim()} title="Add punctuation" style={{ opacity: processing || !input.trim() ? 0.3 : 1 }}>
            <PunctuateIcon />
          </button>
          <div className="flex-1" />
          <button type="button" className={`btn-glass p-1.5 rounded${webSearch ? ' active' : ''}`}
            onClick={() => setWebSearch((v) => !v)} title="Web search mode"
            style={webSearch ? { background: 'rgba(0,180,100,0.15)', border: '1px solid rgba(0,180,100,0.35)', color: '#0b6' } : {}}>
            <GlobeIcon />
          </button>
          {processing && <span className="text-[9px] animate-pulse" style={{ color: 'var(--accent)' }}>Processing...</span>}
        </div>
        {webSearch && (
          <div className="text-[9px] mb-1 px-1" style={{ color: 'rgba(0,180,100,0.8)' }}>
            🌐 Web search enabled — AI will try to search the internet
          </div>
        )}
        {/* Input + send/stop */}
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => { if (e.target.value.length <= MAX_INPUT_CHARS) setInput(e.target.value); }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.type.startsWith('image/')) {
                  e.preventDefault();
                  const file = item.getAsFile();
                  if (file) setAttachedImage({ file, preview: URL.createObjectURL(file) });
                  return;
                }
              }
            }}
            placeholder={voiceActive ? 'Listening...' : attachedImage ? 'Describe what you want to know about the image...' : 'Type a message...'}
            className="glass-input flex-1 px-3 py-2 rounded-lg text-xs"
            style={{ resize: 'none', minHeight: '36px', maxHeight: '120px', overflowY: 'auto', lineHeight: 1.5 }}
            rows={1}
            disabled={streaming}
          />
          {streaming ? (
            <button type="button" className="btn-glass px-3 py-2 rounded-lg shrink-0" onClick={handleStop} title="Stop"
              style={{ background: 'rgba(255,50,50,0.15)', border: '1px solid rgba(255,50,50,0.3)', color: '#f55' }}>
              <StopIcon />
            </button>
          ) : (
            <button type="button" className="btn-glass px-3 py-2 rounded-lg shrink-0" onClick={() => handleSend()}
              disabled={!input.trim() && !attachedImage} title="Send (Enter)" style={{ opacity: !input.trim() && !attachedImage ? 0.3 : 1 }}>
              <SendIcon />
            </button>
          )}
        </div>
        {/* Character counter */}
        <div className="flex justify-end mt-0.5">
          <span className="text-[9px]" style={{
            color: input.length > MAX_INPUT_CHARS - 10000 ? '#f55' : 'var(--text-tertiary)',
          }}>
            {(MAX_INPUT_CHARS - input.length).toLocaleString()} / {MAX_INPUT_CHARS.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
