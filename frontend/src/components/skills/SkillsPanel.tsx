import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import toast from 'react-hot-toast';
import { listSkills, uploadSkill, renameSkill, deleteSkill, readSkill, type OwnSkill } from '../../api/skills';

// ── helpers ──────────────────────────────────────────────────────────────
function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return new Date(dateStr).toLocaleDateString();
}

// Skill name from a filename: strip dir + extension, normalise to kebab.
function nameFromFile(filename: string): string {
  const base = (filename.split(/[/\\]/).pop() || filename).replace(/\.[^.]+$/, '');
  return base.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

function errMsg(e: unknown, fallback: string): string {
  const ax = e as { response?: { data?: { error?: string } }; message?: string };
  return ax?.response?.data?.error || ax?.message || fallback;
}

const ghostBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 6, flexShrink: 0,
};

function IconBtn({ title, onClick, active, danger, children }: {
  title: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ ...ghostBtn, color: active ? 'var(--accent-bright)' : 'var(--text-muted)' }}
      onMouseEnter={(e) => { e.currentTarget.style.color = danger ? 'var(--danger)' : 'var(--accent)'; e.currentTarget.style.background = 'var(--glass-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = active ? 'var(--accent-bright)' : 'var(--text-muted)'; e.currentTarget.style.background = 'none'; }}
    >
      {children}
    </button>
  );
}

// ── markdown (mirrors ClaudeMessage .prose wrapper) ─────────────────────────
function SkillMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none" style={{ fontSize: 12.5, lineHeight: 1.55, maxWidth: '100%', overflowX: 'auto' }}>
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
              <pre style={{ margin: '8px 0', padding: '8px 10px', fontSize: 11, lineHeight: 1.45, background: 'rgba(0,0,0,0.4)', border: '1px solid var(--glass-border)', borderRadius: 10, overflowX: 'auto' }}>
                <code className="font-mono">{String(children).replace(/\n$/, '')}</code>
              </pre>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// ── skill row ───────────────────────────────────────────────────────────────
function SkillRow({ skill, onChanged }: { skill: OwnSkill; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const renameSubmittedRef = useRef(false);

  const doRename = async (raw: string) => {
    const next = raw.trim();
    if (!next || next === skill.name) { setRenaming(false); return; }
    setBusy(true);
    try {
      await renameSkill(skill.name, next);
      toast.success(`Скилл переименован в /${next}`);
      setRenaming(false);
      onChanged();
    } catch (e) {
      toast.error(errMsg(e, 'Не удалось переименовать'));
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!window.confirm(`Удалить скилл /${skill.name}?`)) return;
    setBusy(true);
    try {
      await deleteSkill(skill.name);
      toast.success(`Скилл /${skill.name} удалён`);
      onChanged();
    } catch (e) {
      toast.error(errMsg(e, 'Не удалось удалить'));
      setBusy(false);
    }
  };

  const togglePreview = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (content === null && !loadingContent) {
      setLoadingContent(true);
      try {
        const { data } = await readSkill(skill.name);
        setContent(data.content || '');
      } catch (e) {
        toast.error(errMsg(e, 'Не удалось загрузить SKILL.md'));
        setContent('');
      } finally {
        setLoadingContent(false);
      }
    }
  };

  return (
    <div
      style={{
        borderRadius: 12,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--glass-border)',
        opacity: busy ? 0.55 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              type="text"
              defaultValue={skill.name}
              autoFocus
              placeholder="имя-скилла"
              title="Новое имя скилла"
              onKeyDown={(e) => {
                if (e.key === 'Enter') { renameSubmittedRef.current = true; doRename(e.currentTarget.value); }
                if (e.key === 'Escape') { renameSubmittedRef.current = true; setRenaming(false); }
              }}
              onBlur={(e) => {
                if (renameSubmittedRef.current) { renameSubmittedRef.current = false; return; }
                doRename(e.currentTarget.value);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%', padding: '4px 8px', fontSize: 13, fontFamily: "'SF Mono','JetBrains Mono',monospace",
                background: 'rgba(0,0,0,0.4)', border: '1px solid var(--glass-border)', borderRadius: 7,
                color: 'var(--text-primary)', outline: 'none',
              }}
            />
          ) : (
            <span
              style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-bright)', fontFamily: "'SF Mono','JetBrains Mono',monospace", wordBreak: 'break-all' }}
              title={`Команда: /${skill.name}`}
            >
              /{skill.name}
            </span>
          )}
          {skill.description && (
            <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.4, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
              {skill.description}
            </p>
          )}
          {skill.updated_at && (
            <p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
              изменён {timeAgo(skill.updated_at)}
            </p>
          )}
        </div>

        {!renaming && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            <IconBtn title="Превью SKILL.md" onClick={togglePreview} active={expanded}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
              </svg>
            </IconBtn>
            <IconBtn title="Переименовать" onClick={() => { renameSubmittedRef.current = false; setRenaming(true); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </IconBtn>
            <IconBtn title="Удалить" onClick={doDelete} danger>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </IconBtn>
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--glass-border)', padding: '8px 10px', maxHeight: 360, overflowY: 'auto' }}>
          {loadingContent ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Загрузка…</span>
          ) : content ? (
            <SkillMarkdown>{content}</SkillMarkdown>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>SKILL.md пуст.</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────
export default function SkillsPanel() {
  const [skills, setSkills] = useState<OwnSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await listSkills();
      setSkills(data.own || []);
      setError(null);
    } catch (e) {
      setError(errMsg(e, 'Не удалось загрузить скиллы'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    const name = nameFromFile(file.name);
    setUploading(true);
    try {
      await uploadSkill(name, file);
      toast.success(`Скилл /${name} загружен`);
      await refresh();
    } catch (err) {
      toast.error(errMsg(err, 'Не удалось загрузить скилл'));
    } finally {
      setUploading(false);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? skills.filter((s) => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
    : skills;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--text-primary)' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,text/markdown"
        style={{ display: 'none' }}
        onChange={handleFilePicked}
      />

      {/* Toolbar: search + upload */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 12px', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px', borderRadius: 10, background: 'rgba(0,0,0,0.35)', border: '1px solid var(--glass-border)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по скиллам…"
            style={{ flex: 1, minWidth: 0, padding: '8px 0', fontSize: 13, background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
          />
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="btn-accent"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10,
            fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0,
            opacity: uploading ? 0.5 : 1, cursor: uploading ? 'default' : 'pointer',
          }}
          title="Загрузить .md-файл скилла"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          {uploading ? 'Загрузка…' : 'Загрузить .md'}
        </button>
      </div>

      <p style={{ margin: 0, padding: '0 12px 8px', fontSize: 11, lineHeight: 1.4, color: 'var(--text-muted)', flexShrink: 0 }}>
        Скилл доступен в claude как <code style={{ fontFamily: "'SF Mono','JetBrains Mono',monospace", color: 'var(--accent-bright)' }}>/имя</code>. Переименование меняет команду.
      </p>

      {/* List */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <span style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>Загрузка…</span>
        ) : error ? (
          <div style={{ padding: '14px', borderRadius: 12, background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.3)' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--danger)' }}>{error}</p>
            <button
              type="button"
              onClick={() => { setLoading(true); void refresh(); }}
              style={{ marginTop: 8, padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--glass-hover)', border: '1px solid var(--glass-border)', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
              Повторить
            </button>
          </div>
        ) : skills.length === 0 ? (
          <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Своих скиллов пока нет.<br />Загрузите .md-файл скилла.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ margin: 0, fontSize: 13 }}>Ничего не найдено по «{query.trim()}».</p>
          </div>
        ) : (
          filtered.map((s) => <SkillRow key={s.name} skill={s} onChanged={refresh} />)
        )}
      </div>
    </div>
  );
}
