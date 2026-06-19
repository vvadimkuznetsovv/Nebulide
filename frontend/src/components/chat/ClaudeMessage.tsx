import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import toast from 'react-hot-toast';
import type { ChatBlock, RichMessage } from '../../api/claudeSessions';

function copyText(text: string) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => toast.success('Скопировано', { duration: 1000 }),
    () => toast.error('Не удалось скопировать'),
  );
}

const ghostBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
  display: 'flex', alignItems: 'center', padding: 3, borderRadius: 5, flexShrink: 0,
};

function CopyBtn({ text, title }: { text: string; title?: string }) {
  return (
    <button type="button" title={title || 'Скопировать'}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyText(text); }}
      style={ghostBtn}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
    </button>
  );
}

// Rewind control — opens Claude Code's native rewind (Esc Esc) on the real terminal.
function RewindBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" title="Вернуться к этому сообщению (откат Claude Code)" onClick={onClick}
      style={ghostBtn}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>
    </button>
  );
}

// Shared markdown renderer (same code/inline config as MessageBubble).
function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none" style={{ fontSize: 'var(--chat-fs, 13px)', lineHeight: 1.55, maxWidth: '100%', overflowX: 'auto' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const inline = !match;
            if (inline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded text-xs font-mono"
                  style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--glass-border)' }}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <SyntaxHighlighter
                style={oneDark}
                language={match[1]}
                PreTag="div"
                className="rounded-xl !my-2 text-xs"
                customStyle={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--glass-border)', borderRadius: 12, maxWidth: '100%', overflowX: 'auto' }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function asObj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function inputSummary(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const obj = asObj(input);
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt', 'query']) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.length > 140 ? v.slice(0, 140) + '…' : v;
  }
  return '';
}

// ── Thinking ──
function ThinkingBlock({ text }: { text: string }) {
  return (
    <details style={{ margin: '4px 0', borderRadius: 8, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--glass-border)' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        <span style={{ flex: 1 }}>💭 Размышления</span>
        <CopyBtn text={text} title="Скопировать размышления" />
      </summary>
      <div style={{ padding: '4px 10px 8px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)', fontStyle: 'italic', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
        {text}
      </div>
    </details>
  );
}

// ── TodoWrite checklist ──
interface Todo { content?: string; status?: string; activeForm?: string }
function TodoWriteBlock({ input }: { input: unknown }) {
  const todos = (asObj(input).todos as Todo[] | undefined) || [];
  return (
    <div style={{ margin: '4px 0', borderRadius: 8, background: 'rgba(var(--accent-rgb),0.05)', border: '1px solid rgba(var(--accent-rgb),0.2)', padding: '8px 10px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>☑ Список задач</div>
      {todos.map((t, i) => {
        const done = t.status === 'completed';
        const active = t.status === 'in_progress';
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, lineHeight: 1.5, padding: '1px 0' }}>
            <span style={{ flexShrink: 0, width: 14, color: done ? 'var(--success)' : active ? 'var(--accent)' : 'var(--text-muted)' }}>
              {done ? '✓' : active ? '●' : '○'}
            </span>
            <span style={{
              color: done ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: done ? 'line-through' : 'none',
              fontWeight: active ? 600 : 400,
            }}>
              {(active && t.activeForm) || t.content || ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Diff for Edit / Write / MultiEdit ──
type DiffRow = { t: 'ctx' | 'add' | 'del'; s: string };
function simpleDiff(oldS: string, newS: string): DiffRow[] {
  const o = oldS.split('\n');
  const n = newS.split('\n');
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let oe = o.length, ne = n.length;
  while (oe > start && ne > start && o[oe - 1] === n[ne - 1]) { oe--; ne--; }
  const rows: DiffRow[] = [];
  const ctxBefore = Math.max(0, start - 2);
  for (let i = ctxBefore; i < start; i++) rows.push({ t: 'ctx', s: o[i] });
  for (let i = start; i < oe; i++) rows.push({ t: 'del', s: o[i] });
  for (let i = start; i < ne; i++) rows.push({ t: 'add', s: n[i] });
  for (let i = oe; i < Math.min(o.length, oe + 2); i++) rows.push({ t: 'ctx', s: o[i] });
  return rows;
}

function rowsToPatch(rows: DiffRow[]): string {
  return rows.map(r => (r.t === 'add' ? '+ ' : r.t === 'del' ? '- ' : '  ') + r.s).join('\n');
}

function DiffView({ rows }: { rows: DiffRow[] }) {
  const capped = rows.slice(0, 80);
  return (
    <pre style={{ margin: 0, padding: '6px 0', fontSize: 11, lineHeight: 1.5, fontFamily: 'monospace', maxHeight: 320, overflow: 'auto' }}>
      {capped.map((r, i) => (
        <div key={i} style={{
          padding: '0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: r.t === 'add' ? 'rgba(var(--success-rgb),0.12)' : r.t === 'del' ? 'rgba(var(--danger-rgb),0.12)' : 'transparent',
          color: r.t === 'add' ? 'var(--success)' : r.t === 'del' ? 'rgba(var(--danger-rgb),0.9)' : 'var(--text-muted)',
        }}>
          {r.t === 'add' ? '+ ' : r.t === 'del' ? '− ' : '  '}{r.s}
        </div>
      ))}
      {rows.length > capped.length && <div style={{ padding: '2px 10px', color: 'var(--text-muted)' }}>… ещё {rows.length - capped.length} строк</div>}
    </pre>
  );
}

function EditBlock({ name, input }: { name: string; input: unknown }) {
  const obj = asObj(input);
  const file = (obj.file_path as string) || (obj.path as string) || '';
  let rows: DiffRow[] = [];
  if (name === 'Write') {
    rows = simpleDiff('', (obj.content as string) || '');
  } else if (name === 'MultiEdit') {
    const edits = (obj.edits as { old_string?: string; new_string?: string }[]) || [];
    for (const e of edits) rows.push(...simpleDiff(e.old_string || '', e.new_string || ''));
  } else {
    rows = simpleDiff((obj.old_string as string) || '', (obj.new_string as string) || '');
  }
  return (
    <details open style={{ margin: '4px 0', borderRadius: 8, overflow: 'hidden', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        <span style={{ color: 'var(--text-secondary)' }}>{name === 'Write' ? 'Создание' : 'Правка'}</span>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 400, color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
          {baseName(file)}
        </span>
        <CopyBtn text={rowsToPatch(rows)} title="Скопировать дифф" />
      </summary>
      <div style={{ borderTop: '1px solid var(--glass-border)' }}>
        <DiffView rows={rows} />
      </div>
    </details>
  );
}

// ── Generic tool card ──
const TOOL_ICON: Record<string, string> = {
  Bash: '$', Read: '📄', Grep: '🔎', Glob: '🔍', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖',
};
function ToolUseBlock({ block }: { block: ChatBlock }) {
  const name = block.name || 'tool';
  if (name === 'TodoWrite') return <TodoWriteBlock input={block.input} />;
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') return <EditBlock name={name} input={block.input} />;

  const summary = inputSummary(block.input);
  const json = block.input != null ? JSON.stringify(block.input, null, 2) : '';
  const cmd = asObj(block.input).command;
  const copyVal = typeof cmd === 'string' ? cmd : json;
  const icon = TOOL_ICON[name] || '🔧';
  return (
    <details style={{ margin: '4px 0', borderRadius: 8, overflow: 'hidden', background: 'rgba(var(--accent-rgb),0.06)', border: '1px solid rgba(var(--accent-rgb),0.22)' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
        <span style={{ flexShrink: 0, width: 14, textAlign: 'center' }}>{icon}</span>
        <span style={{ color: 'var(--text-primary)' }}>{name}</span>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 400, color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
          {summary}
        </span>
        {copyVal && <CopyBtn text={copyVal} title="Скопировать команду" />}
      </summary>
      {json && (
        <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11, lineHeight: 1.45, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', maxHeight: 280, overflow: 'auto', borderTop: '1px solid var(--glass-border)' }}>
          {json}
        </pre>
      )}
    </details>
  );
}

function ToolResultBlock({ block }: { block: ChatBlock }) {
  const content = block.content || '';
  const err = !!block.is_error;
  return (
    <details style={{ margin: '4px 0', borderRadius: 8, overflow: 'hidden', background: err ? 'rgba(var(--danger-rgb),0.06)' : 'rgba(255,255,255,0.03)', border: `1px solid ${err ? 'rgba(var(--danger-rgb),0.3)' : 'var(--glass-border)'}` }}>
      <summary style={{ cursor: 'pointer', padding: '8px 10px', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: err ? 'var(--danger)' : 'var(--text-muted)', fontWeight: 600 }}>
        {err ? '✗' : '↳'} <span>{err ? 'Ошибка' : 'Результат'}</span>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 400, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
          {content.split('\n')[0]}
        </span>
        {content && <CopyBtn text={content} title="Скопировать результат" />}
      </summary>
      {content && (
        <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11, lineHeight: 1.45, color: err ? 'rgba(var(--danger-rgb),0.9)' : 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', maxHeight: 320, overflow: 'auto', borderTop: `1px solid ${err ? 'rgba(var(--danger-rgb),0.2)' : 'var(--glass-border)'}` }}>
          {content}
        </pre>
      )}
    </details>
  );
}

function renderBlock(b: ChatBlock, i: number) {
  if (b.kind === 'text') return <Markdown key={i}>{b.text || ''}</Markdown>;
  if (b.kind === 'thinking') return <ThinkingBlock key={i} text={b.text || ''} />;
  if (b.kind === 'tool_use') return <ToolUseBlock key={i} block={b} />;
  if (b.kind === 'tool_result') return <ToolResultBlock key={i} block={b} />;
  return null;
}

interface Props {
  msg: RichMessage;
  /** When provided, user messages get a "return to message" control (native rewind). */
  onRewind?: (msg: RichMessage) => void;
}

export default function ClaudeMessage({ msg, onRewind }: Props) {
  const isUser = msg.role === 'user';
  const hasText = msg.blocks.some(b => b.kind === 'text');
  const userPrompt = isUser && hasText;
  const textOf = (m: RichMessage) => m.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n\n');

  if (userPrompt) {
    const text = textOf(msg);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', margin: '8px 0' }}>
        <div style={{
          maxWidth: '85%', borderRadius: 14, borderBottomRightRadius: 4, padding: '8px 12px',
          background: 'linear-gradient(135deg, rgba(var(--accent-rgb),0.28), rgba(var(--accent-rgb),0.14))',
          border: '1px solid rgba(var(--accent-rgb),0.35)', color: '#fff',
          fontSize: 'var(--chat-fs, 13px)', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowX: 'auto',
        }}>
          {text}
        </div>
        <div style={{ display: 'flex', gap: 2, marginTop: 2, paddingRight: 2 }}>
          {onRewind && <RewindBtn onClick={() => onRewind(msg)} />}
          <CopyBtn text={text} />
        </div>
      </div>
    );
  }

  const answer = textOf(msg);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', margin: '8px 0' }}>
      <div style={{
        maxWidth: '92%', minWidth: 0, borderRadius: 14, borderBottomLeftRadius: 4, padding: '8px 12px',
        background: 'var(--glass, rgba(255,255,255,0.04))',
        border: '1px solid var(--glass-border)', color: 'var(--text-primary)',
      }}>
        {msg.blocks.map(renderBlock)}
      </div>
      {answer && (
        <div style={{ display: 'flex', gap: 2, marginTop: 2, paddingLeft: 2 }}>
          <CopyBtn text={answer} title="Скопировать ответ" />
        </div>
      )}
    </div>
  );
}
