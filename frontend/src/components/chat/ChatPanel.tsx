import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { listClaudeSessions, listClaudePlans, readClaudePlan, readClaudeSession, searchClaudeSessions, deleteClaudeSession, renameClaudeSession, listBranches } from '../../api/claudeSessions';
import type { ClaudeProject, ClaudeSession, ClaudePlan, ClaudeSessionMessage, ClaudeSearchResult, ClaudeBranch } from '../../api/claudeSessions';
import { useLayoutStore } from '../../store/layoutStore';
import { useAuthStore } from '../../store/authStore';
import { typeCommandInTerminal } from '../terminal/Terminal';
import toast from 'react-hot-toast';
import { log } from '../../utils/logger';
import LLMPanel from '../llm/LLMPanel';
import FolderPicker from './FolderPicker';
import ClaudeChatView from '../terminal/ClaudeChatView';
import { mkdirFile } from '../../api/files';
import {
  getClaudeOpenMode, setClaudeOpenMode, useClaudeOpenMode,
  setInitialTerminalViewMode, setTerminalCwdHint, setAgentLaunch,
} from '../../utils/terminalViewMode';

/** Normalize a path for cross-OS comparison: forward slashes, no trailing slash. */
const normPath = (p?: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const baseName = (p: string) => normPath(p).split('/').pop() || p;

interface ChatPanelProps {
  sessionId: string | null;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatSize(mb: number): string {
  if (mb < 1) return `${Math.round(mb * 1024)}KB`;
  return `${mb.toFixed(1)}MB`;
}

// Display name: show full slug (tree already shows hierarchy)
function projectDisplayName(slug: string): string {
  return slug;
}

function sessionDisplayName(session: { name?: string; first_message?: string; slug?: string; session_id: string }): string {
  if (session.name) return session.name;
  if (session.first_message) {
    const msg = session.first_message;
    return msg.length > 60 ? msg.slice(0, 60) + '...' : msg;
  }
  return session.slug || session.session_id.slice(0, 8);
}

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return <>
    {text.slice(0, idx)}
    <mark style={{ background: 'rgba(var(--accent-rgb), 0.3)', color: 'inherit', borderRadius: 2, padding: '0 2px' }}>
      {text.slice(idx, idx + query.length)}
    </mark>
    {text.slice(idx + query.length)}
  </>;
}

function copySessionId(sessionId: string) {
  navigator.clipboard.writeText(sessionId).then(
    () => toast.success('Session ID copied'),
    () => toast.error('Failed to copy')
  );
}

// ── Folder tree ──

interface FolderTreeNode {
  name: string;
  pathPrefix: string;
  children: FolderTreeNode[];
  projectSlug: string | null;
  directCount: number;
  totalCount: number;
}

/** Build tree using prefix-based hierarchy (same logic as backend matchesWorkspace).
 *  Project A is parent of B if B.slug.startsWith(A.slug + '-'). */
function buildFolderTree(projects: ClaudeProject[]): FolderTreeNode {
  const root: FolderTreeNode = {
    name: '', pathPrefix: '', children: [],
    projectSlug: null, directCount: 0, totalCount: 0,
  };

  // Sort by slug length so shorter (parent) slugs come first
  const sorted = [...projects].sort((a, b) => a.slug.length - b.slug.length || a.slug.localeCompare(b.slug));

  for (const proj of sorted) {
    // Find deepest existing parent node
    function findParent(node: FolderTreeNode): FolderTreeNode {
      for (const child of node.children) {
        if (proj.slug.startsWith(child.pathPrefix + '-')) {
          return findParent(child);
        }
      }
      return node;
    }

    const parent = findParent(root);
    // Display name: relative part after parent prefix
    const displayName = parent === root
      ? proj.slug
      : proj.slug.slice(parent.pathPrefix.length + 1);

    parent.children.push({
      name: displayName,
      pathPrefix: proj.slug,
      children: [],
      projectSlug: proj.slug,
      directCount: proj.sessions.length,
      totalCount: proj.sessions.length,
    });
  }

  // Compute totals bottom-up
  function computeTotals(node: FolderTreeNode): number {
    let total = node.directCount;
    for (const child of node.children) total += computeTotals(child);
    node.totalCount = total;
    return total;
  }
  computeTotals(root);

  return root;
}

/** Collect all pathPrefixes in the tree (for initial expand). */
function collectPaths(node: FolderTreeNode): string[] {
  const paths: string[] = [];
  if (node.pathPrefix) paths.push(node.pathPrefix);
  for (const child of node.children) paths.push(...collectPaths(child));
  return paths;
}

// ── SVG icons ──

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const FolderIcon = ({ open }: { open?: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
    {open ? (
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    ) : (
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    )}
  </svg>
);

// ── Component ──

export default function ChatPanel(_props: ChatPanelProps) {
  const [chatMode, setChatMode] = useState<'claude' | 'llm'>('claude');
  const [projects, setProjects] = useState<ClaudeProject[]>([]);
  const [plans, setPlans] = useState<ClaudePlan[]>([]);
  const [plansCollapsed, setPlansCollapsed] = useState(true);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [planContent, setPlanContent] = useState<string>('');
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<ClaudeSessionMessage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ClaudeSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchVersionRef = useRef(0); // Guards against stale API responses

  // Branch explorer state
  const [expandedBranches, setExpandedBranches] = useState<string | null>(null);
  const [branches, setBranches] = useState<ClaudeBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);

  // Folder explorer state
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [treeVisible, setTreeVisible] = useState(true);

  // Inline session rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // "Communication chats" view + arbitrary-folder picker
  const [viewMode, setViewMode] = useState<'normal' | 'communication'>('normal');
  const [pickedFolderPath, setPickedFolderPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const openTerminalWithId = useLayoutStore((s) => s.openTerminalWithId);
  const user = useAuthStore((s) => s.user);
  const openMode = useClaudeOpenMode();

  // Dedicated per-user folder that holds "communication" chats (talking to Claude
  // outside of any project). Hidden from the file manager by the backend.
  const commDir = useMemo(() => {
    const ws = normPath(user?.workspace_dir);
    return ws ? ws + '/.nebulide_chats' : null;
  }, [user?.workspace_dir]);

  const isCommSession = useCallback(
    (s: { cwd?: string }) => !!commDir && normPath(s.cwd) === commDir,
    [commDir]
  );

  // Open a fresh terminal, cd into the folder (creating it if needed) and run claude.
  const startNewChatInFolder = useCallback(async (absPath: string) => {
    const instanceId = `claude-${Date.now()}`;
    setTerminalCwdHint(instanceId, absPath);
    if (getClaudeOpenMode() === 'chat') {
      // Headless agent chat: ensure the dir exists, open the agent panel (no PTY command).
      try { await mkdirFile(absPath); } catch { /* already exists */ }
      setAgentLaunch(instanceId, {});
      setInitialTerminalViewMode(instanceId, 'agent');
      openTerminalWithId(instanceId);
      return;
    }
    setInitialTerminalViewMode(instanceId, 'terminal');
    openTerminalWithId(instanceId);
    const ok = await typeCommandInTerminal(instanceId, `mkdir -p "${absPath}" && cd "${absPath}" && claude`);
    if (!ok) toast.error('Failed to connect to terminal');
  }, [openTerminalWithId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [sessRes, plansRes] = await Promise.all([
        listClaudeSessions(),
        listClaudePlans(),
      ]);
      setProjects(sessRes.data.projects || []);
      setPlans(plansRes.data.plans || []);
    } catch {
      // Offline or no .claude dir
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const allSessions = useMemo(() => {
    const flat = projects.flatMap((p) =>
      p.sessions.map((s) => ({ ...s, project: s.project || p.slug }))
    );
    flat.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    // Deduplicate by session_id (Claude CLI can write same session to multiple project dirs)
    const seen = new Set<string>();
    return flat.filter((s) => {
      if (seen.has(s.session_id)) return false;
      seen.add(s.session_id);
      return true;
    });
  }, [projects]);

  // Communication chats are segregated from normal chats (frontend-only split).
  const commSessions = useMemo(() => allSessions.filter(isCommSession), [allSessions, isCommSession]);
  const normalSessions = useMemo(() => allSessions.filter((s) => !isCommSession(s)), [allSessions, isCommSession]);

  // Projects with communication sessions stripped out — drives the normal folder tree.
  const normalProjects = useMemo(() =>
    projects
      .map((p) => ({ ...p, sessions: p.sessions.filter((s) => !isCommSession(s)) }))
      .filter((p) => p.sessions.length > 0),
    [projects, isCommSession]
  );

  // Build folder tree — recount using deduped sessions so badges match "All (N)"
  const folderTree = useMemo(() => {
    const tree = buildFolderTree(normalProjects);
    const countByProject = new Map<string, number>();
    for (const s of normalSessions) {
      countByProject.set(s.project, (countByProject.get(s.project) || 0) + 1);
    }
    function patchCounts(node: FolderTreeNode): number {
      node.directCount = node.projectSlug ? (countByProject.get(node.projectSlug) || 0) : 0;
      let total = node.directCount;
      for (const child of node.children) total += patchCounts(child);
      node.totalCount = total;
      return total;
    }
    patchCounts(tree);
    return tree;
  }, [normalProjects, normalSessions]);

  // Auto-expand all nodes on first load
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && projects.length > 0) {
      initializedRef.current = true;
      setExpandedNodes(new Set(collectPaths(folderTree)));
    }
  }, [projects, folderTree]);

  // Filter sessions by mode (communication vs normal) + folder/picker + search
  const filteredSessions = useMemo(() => {
    // Communication mode: show only the dedicated-folder chats, ignore folder/picker filters.
    if (viewMode === 'communication') return commSessions;

    let list = normalSessions;

    if (pickedFolderPath) {
      // Arbitrary folder picked from the filesystem — match by cwd (self + subfolders).
      const target = normPath(pickedFolderPath);
      list = list.filter(s => {
        const c = normPath(s.cwd);
        return c === target || c.startsWith(target + '/');
      });
    } else if (selectedFolder) {
      if (includeSubfolders) {
        list = list.filter(s =>
          s.project === selectedFolder || s.project.startsWith(selectedFolder + '-')
        );
      } else {
        list = list.filter(s => s.project === selectedFolder);
      }
    }

    log('[ChatPanel] filter:', { viewMode, selectedFolder, pickedFolderPath, includeSubfolders, total: normalSessions.length, filtered: list.length, searchResults: searchResults?.length ?? null });

    if (!searchQuery) return list;
    // Active search: keep only local name/slug/project matches and exclude
    // sessions already shown in the full-text results block (rendered above)
    const q = searchQuery.toLowerCase();
    const fullTextIds = new Set((searchResults || []).map(r => r.session_id));
    return list.filter(s =>
      !fullTextIds.has(s.session_id)
      && (
        s.name?.toLowerCase().includes(q)
        || s.first_message?.toLowerCase().includes(q)
        || s.slug?.toLowerCase().includes(q)
        || projectDisplayName(s.project).toLowerCase().includes(q)
      )
    );
  }, [viewMode, commSessions, normalSessions, selectedFolder, pickedFolderPath, includeSubfolders, searchQuery, searchResults]);

  // Resolve the folder path "New chat" should target in normal mode:
  // the picked folder, or a folder derived from the selected tree node's sessions.
  const folderTargetPath = useMemo(() => {
    if (pickedFolderPath) return pickedFolderPath;
    if (selectedFolder) {
      const hit = normalSessions.find(s => s.project === selectedFolder && s.cwd);
      if (hit?.cwd) return normPath(hit.cwd);
    }
    return null;
  }, [pickedFolderPath, selectedFolder, normalSessions]);

  const handleOpenSession = useCallback(async (session: { session_id: string; cwd?: string; project?: string }) => {
    if (launching) return;
    setLaunching(session.session_id);

    const instanceId = `claude-${Date.now()}`;
    if (session.cwd) setTerminalCwdHint(instanceId, session.cwd);

    if (getClaudeOpenMode() === 'chat') {
      // Resume the session in the headless agent chat (history preloaded from JSONL).
      setAgentLaunch(instanceId, { resume: session.session_id, historyProject: session.project, historySessionFile: session.session_id });
      setInitialTerminalViewMode(instanceId, 'agent');
      openTerminalWithId(instanceId);
      setLaunching(null);
      return;
    }

    setInitialTerminalViewMode(instanceId, 'terminal');
    openTerminalWithId(instanceId);

    const resumeCmd = `claude --resume ${session.session_id}`;
    const cmd = session.cwd ? `cd "${session.cwd}" && ${resumeCmd}` : resumeCmd;
    const ok = await typeCommandInTerminal(instanceId, cmd);
    if (!ok) {
      toast.error('Failed to connect to terminal');
    }
    // Pet creation is server-driven: backend's childWatchLoop broadcasts
    // pet_event:launched (≤2s) once it sees the claude descendant.
    setLaunching(null);
  }, [launching, openTerminalWithId]);

  const handlePreviewSession = useCallback(async (session: ClaudeSession & { project: string }) => {
    const key = session.session_id;
    if (expandedSession === key) {
      setExpandedSession(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const { data } = await readClaudeSession(session.project, session.session_id);
      setSessionMessages(data.messages || []);
      setExpandedSession(key);
    } catch {
      toast.error('Failed to load session preview');
    } finally {
      setPreviewLoading(false);
    }
  }, [expandedSession]);

  const handleDeleteSession = useCallback(async (session: ClaudeSession & { project: string }) => {
    if (!confirm('Delete this session?')) return;
    try {
      await deleteClaudeSession(session.project, session.session_id);
      if (expandedSession === session.session_id) setExpandedSession(null);
      refresh();
      toast.success('Session deleted');
    } catch {
      toast.error('Failed to delete session');
    }
  }, [expandedSession, refresh]);

  const beginRename = useCallback((session: ClaudeSession & { project: string }) => {
    setRenamingId(session.session_id);
    setRenameValue(session.name || sessionDisplayName(session));
  }, []);

  const commitRename = useCallback(async (session: ClaudeSession & { project: string }, raw: string) => {
    const name = raw.trim();
    setRenamingId(null);
    if (!name || name === (session.name || '')) return;
    // Optimistic update across all project entries holding this session_id
    setProjects(prev => prev.map(p => ({
      ...p,
      sessions: p.sessions.map(s => s.session_id === session.session_id ? { ...s, name } : s),
    })));
    try {
      await renameClaudeSession(session.project, session.session_id, name);
      toast.success('Сессия переименована');
    } catch {
      toast.error('Не удалось переименовать');
      refresh();
    }
  }, [refresh]);

  const handlePlanClick = useCallback(async (slug: string) => {
    if (expandedPlan === slug) {
      setExpandedPlan(null);
      return;
    }
    try {
      const { data } = await readClaudePlan(slug);
      setPlanContent(data.content);
      setExpandedPlan(slug);
    } catch {
      toast.error('Failed to load plan');
    }
  }, [expandedPlan]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!value.trim() || value.trim().length < 2) {
      searchVersionRef.current++; // Invalidate any in-flight request
      setSearchResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    const version = ++searchVersionRef.current;
    searchTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchClaudeSessions(value.trim());
        // Only apply if this is still the latest search
        if (version === searchVersionRef.current) {
          setSearchResults(data.results || []);
        }
      } catch {
        if (version === searchVersionRef.current) {
          setSearchResults(null);
        }
      } finally {
        if (version === searchVersionRef.current) {
          setSearching(false);
        }
      }
    }, 400);
  }, []);

  const handleOpenSearchResult = useCallback(async (result: ClaudeSearchResult) => {
    handleOpenSession({ session_id: result.session_id, cwd: result.cwd, project: result.project });
  }, [handleOpenSession]);

  const handleToggleBranches = useCallback(async (session: ClaudeSession & { project: string }) => {
    const key = session.session_id;
    if (expandedBranches === key) {
      setExpandedBranches(null);
      return;
    }
    setBranchesLoading(true);
    try {
      const { data } = await listBranches(session.project, session.session_id);
      setBranches(data.branches || []);
      setExpandedBranches(key);
    } catch {
      toast.error('Failed to load branches');
    } finally {
      setBranchesLoading(false);
    }
  }, [expandedBranches]);

  const toggleExpanded = useCallback((pathPrefix: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(pathPrefix)) next.delete(pathPrefix);
      else next.add(pathPrefix);
      return next;
    });
  }, []);

  const handleFolderSelect = useCallback((pathPrefix: string | null) => {
    setPickedFolderPath(null);
    setSelectedFolder(prev => prev === pathPrefix ? null : pathPrefix);
  }, []);

  // ── Render helpers ──

  const renderFolderNode = (node: FolderTreeNode, depth: number): ReactNode => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedNodes.has(node.pathPrefix);
    const isSelected = selectedFolder === node.pathPrefix;
    const isLeaf = !hasChildren && node.projectSlug !== null;

    return (
      <div key={node.pathPrefix}>
        <div
          onClick={() => {
            handleFolderSelect(node.pathPrefix);
            if (hasChildren) toggleExpanded(node.pathPrefix);
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            paddingLeft: 12 + depth * 14, paddingRight: 12,
            paddingTop: 4, paddingBottom: 4,
            cursor: 'pointer',
            background: isSelected ? 'rgba(var(--accent-rgb), 0.12)' : 'transparent',
            borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
            transition: 'all 0.15s',
            fontSize: 11,
          }}
          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(var(--accent-rgb), 0.06)'; }}
          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
        >
          {/* Chevron or spacer */}
          {hasChildren ? (
            <span
              onClick={(e) => { e.stopPropagation(); toggleExpanded(node.pathPrefix); }}
              style={{ display: 'flex', cursor: 'pointer', padding: 2 }}
            >
              <ChevronIcon open={isExpanded} />
            </span>
          ) : (
            <span style={{ width: 14 }} />
          )}

          <FolderIcon open={isExpanded && hasChildren} />

          <span style={{
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
            fontWeight: isSelected ? 600 : 400,
          }}>
            {node.name}
          </span>

          <span style={{
            fontSize: 9, color: 'var(--text-muted)',
            background: 'rgba(var(--accent-rgb), 0.08)',
            padding: '1px 5px', borderRadius: 8,
            flexShrink: 0,
          }}>
            {isLeaf ? node.directCount : node.totalCount}
          </span>
        </div>

        {/* Children */}
        {hasChildren && isExpanded && node.children.map(child => renderFolderNode(child, depth + 1))}
      </div>
    );
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading...</div>
      </div>
    );
  }

  const isEmpty = allSessions.length === 0 && plans.length === 0;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', height: '100%',
      overflow: 'hidden',
    }}>
      {/* Mode tabs */}
      <div style={{
        display: 'flex', gap: 4, padding: '6px 12px',
        borderBottom: '1px solid var(--glass-border)', flexShrink: 0,
      }}>
        <button
          type="button"
          className="btn-glass"
          onClick={() => setChatMode('claude')}
          style={{
            padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500,
            background: chatMode === 'claude' ? 'rgba(var(--accent-rgb), 0.2)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${chatMode === 'claude' ? 'rgba(var(--accent-rgb), 0.4)' : 'var(--glass-border)'}`,
            color: chatMode === 'claude' ? 'var(--accent-bright)' : 'var(--text-muted)',
          }}
        >Claude</button>
        <button
          type="button"
          className="btn-glass"
          onClick={() => setChatMode('llm')}
          style={{
            padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500,
            background: chatMode === 'llm' ? 'rgba(var(--accent-rgb), 0.2)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${chatMode === 'llm' ? 'rgba(var(--accent-rgb), 0.4)' : 'var(--glass-border)'}`,
            color: chatMode === 'llm' ? 'var(--accent-bright)' : 'var(--text-muted)',
          }}
        >LLM</button>
      </div>

      {/* LLM mode */}
      {chatMode === 'llm' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <LLMPanel />
        </div>
      )}

      {/* Claude mode */}
      {chatMode === 'claude' && <>
      {/* Header */}
      <div style={{
        padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--glass-border)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Claude Sessions
        </span>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--text-muted)', display: 'flex',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* View mode: all chats vs communication chats */}
      <div style={{ display: 'flex', gap: 6, padding: '6px 12px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setViewMode('normal')}
          style={{
            flex: 1, padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: 'pointer',
            fontFamily: 'inherit',
            background: viewMode === 'normal' ? 'rgba(var(--accent-rgb), 0.18)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${viewMode === 'normal' ? 'rgba(var(--accent-rgb), 0.4)' : 'var(--glass-border)'}`,
            color: viewMode === 'normal' ? 'var(--accent-bright)' : 'var(--text-muted)',
          }}
        >Все чаты</button>
        <button
          type="button"
          onClick={() => {
            setViewMode('communication');
            setSelectedFolder(null);
            setPickedFolderPath(null);
            setSearchQuery('');
            setSearchResults(null);
          }}
          style={{
            flex: 1, padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: 'pointer',
            fontFamily: 'inherit',
            background: viewMode === 'communication' ? 'rgba(var(--accent-rgb), 0.18)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${viewMode === 'communication' ? 'rgba(var(--accent-rgb), 0.4)' : 'var(--glass-border)'}`,
            color: viewMode === 'communication' ? 'var(--accent-bright)' : 'var(--text-muted)',
          }}
        >💬 Чаты общения</button>
      </div>

      {/* Open-as preference: launch sessions directly as terminal or chat interface */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 6px', flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Открывать как:</span>
        {(['terminal', 'chat'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setClaudeOpenMode(m)}
            style={{
              padding: '2px 10px', borderRadius: 10, fontSize: 10, fontFamily: 'inherit', cursor: 'pointer',
              background: openMode === m ? 'rgba(var(--accent-rgb), 0.15)' : 'rgba(var(--accent-rgb), 0.04)',
              border: `1px solid ${openMode === m ? 'rgba(var(--accent-rgb), 0.4)' : 'var(--glass-border)'}`,
              color: openMode === m ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: openMode === m ? 600 : 400,
            }}
          >
            {m === 'terminal' ? 'Терминал' : 'Чат'}
          </button>
        ))}
      </div>

      {/* Search */}
      {!isEmpty && viewMode === 'normal' && (
        <div style={{ padding: '8px 12px', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(var(--accent-rgb), 0.06)',
            border: '1px solid var(--glass-border)',
            borderRadius: 8, padding: '6px 10px',
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search sessions (full-text)..."
              style={{
                flex: 1, background: 'none', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit',
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => { setSearchQuery(''); setSearchResults(null); setSearching(false); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', display: 'flex', padding: 0,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Folder explorer */}
      {viewMode === 'normal' && !isEmpty && !searchQuery && (
        <div style={{
          flexShrink: 0,
          borderBottom: '1px solid var(--glass-border)',
        }}>
          {/* Explorer header: title + toggle + collapse */}
          <div style={{
            padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {/* Collapse tree toggle */}
            <button
              type="button"
              onClick={() => setTreeVisible(v => !v)}
              title={treeVisible ? 'Hide folder tree' : 'Show folder tree'}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                color: 'var(--text-muted)', display: 'flex',
              }}
            >
              <ChevronIcon open={treeVisible} />
            </button>

            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.08em', color: 'var(--text-muted)', flex: 1,
            }}>
              Folders
            </span>

            {/* Browse arbitrary folder */}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              title="Открыть любую папку"
              disabled={!user?.workspace_dir}
              style={{
                padding: '2px 8px', borderRadius: 10,
                border: '1px solid var(--glass-border)', cursor: 'pointer',
                fontSize: 9, fontFamily: 'inherit',
                background: 'rgba(var(--accent-rgb), 0.04)',
                color: 'var(--text-muted)',
                display: 'flex', alignItems: 'center', gap: 3,
                opacity: user?.workspace_dir ? 1 : 0.4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Папка…
            </button>

            {/* "All" button to clear selection */}
            <button
              type="button"
              onClick={() => { setSelectedFolder(null); setPickedFolderPath(null); }}
              title="Show all sessions"
              style={{
                padding: '2px 8px', borderRadius: 10,
                border: '1px solid var(--glass-border)', cursor: 'pointer',
                fontSize: 9, fontFamily: 'inherit',
                background: (!selectedFolder && !pickedFolderPath) ? 'rgba(var(--accent-rgb), 0.15)' : 'rgba(var(--accent-rgb), 0.04)',
                color: (!selectedFolder && !pickedFolderPath) ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: (!selectedFolder && !pickedFolderPath) ? 600 : 400,
                transition: 'all 0.15s',
              }}
            >
              All ({normalSessions.length})
            </button>

            {/* Subfolder toggle */}
            <button
              type="button"
              onClick={() => setIncludeSubfolders(v => !v)}
              title={includeSubfolders ? 'Showing: folder + subfolders (click for only this folder)' : 'Showing: only this folder (click to include subfolders)'}
              style={{
                padding: '2px 6px', borderRadius: 10,
                border: '1px solid var(--glass-border)', cursor: 'pointer',
                fontSize: 9, fontFamily: 'inherit',
                background: includeSubfolders ? 'rgba(var(--accent-rgb), 0.12)' : 'rgba(var(--accent-rgb), 0.04)',
                color: includeSubfolders ? 'var(--accent)' : 'var(--text-muted)',
                transition: 'all 0.15s',
                display: 'flex', alignItems: 'center', gap: 3,
                opacity: selectedFolder ? 1 : 0.4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                {includeSubfolders ? (
                  <>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <path d="M12 11v6" /><path d="M9 14h6" />
                  </>
                ) : (
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                )}
              </svg>
              {includeSubfolders ? '+subs' : 'only'}
            </button>
          </div>

          {/* Picked-folder chip (arbitrary folder chosen via the picker) */}
          {pickedFolderPath && (
            <div style={{
              margin: '0 12px 6px', padding: '4px 8px', borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(var(--accent-rgb), 0.12)',
              border: '1px solid rgba(var(--accent-rgb), 0.3)',
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {baseName(pickedFolderPath)}
              </span>
              <button
                type="button"
                onClick={() => setPickedFolderPath(null)}
                title="Сбросить"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 0 }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {/* Tree */}
          {treeVisible && folderTree.children.length > 0 && (
            <div style={{ paddingBottom: 6, maxHeight: 200, overflow: 'auto' }}>
              {folderTree.children.map(child => renderFolderNode(child, 0))}
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {viewMode === 'normal' && isEmpty && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', gap: 12,
            color: 'var(--text-tertiary)', fontSize: 13,
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>No Claude sessions found</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Run Claude in the terminal to create sessions
            </span>
          </div>
        )}

        {/* Communication chats — dedicated-folder header + new chat button */}
        {viewMode === 'communication' && (
          <div style={{ padding: '4px 16px 8px' }}>
            <button
              type="button"
              onClick={() => commDir && startNewChatInFolder(commDir)}
              disabled={!commDir}
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                cursor: commDir ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: 'rgba(var(--accent-rgb), 0.18)',
                border: '1px solid rgba(var(--accent-rgb), 0.4)',
                color: 'var(--accent-bright)',
                opacity: commDir ? 1 : 0.5,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Новый чат общения
            </button>
            {filteredSessions.length === 0 && (
              <div style={{ marginTop: 12, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                Пока нет чатов для общения. Создайте первый.
              </div>
            )}
          </div>
        )}

        {/* Plans section — hidden when a folder is selected (plans are global, not per-folder) or during search */}
        {viewMode === 'normal' && plans.length > 0 && !selectedFolder && !pickedFolderPath && !searchQuery && (
          <div style={{ marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setPlansCollapsed(v => !v)}
              style={{
                width: '100%', padding: '6px 16px', fontSize: 10, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.08em',
                color: 'var(--text-muted)', background: 'none', border: 'none',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: plansCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.15s' }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Plans ({plans.length})
            </button>
            {!plansCollapsed && plans.map((plan) => (
              <div key={plan.slug}>
                <button
                  type="button"
                  onClick={() => handlePlanClick(plan.slug)}
                  style={{
                    width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    padding: '8px 16px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {plan.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {timeAgo(plan.updated_at)}
                    </div>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flexShrink: 0, transform: expandedPlan === plan.slug ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
                {expandedPlan === plan.slug && (
                  <div style={{
                    margin: '0 16px 8px', padding: '10px 12px',
                    borderRadius: 8,
                    background: 'rgba(var(--accent-rgb), 0.04)',
                    border: '1px solid var(--glass-border)',
                    maxHeight: 300, overflow: 'auto',
                  }}>
                    <pre style={{
                      margin: 0, fontSize: 11, lineHeight: 1.5,
                      color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word', fontFamily: 'inherit',
                    }}>
                      {planContent}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Server search results */}
        {viewMode === 'normal' && searchResults !== null && searchResults.length > 0 && (
          <div>
            <div style={{
              padding: '6px 16px', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--text-muted)',
            }}>
              Full-text results ({searchResults.length})
            </div>
            {searchResults.map((result) => {
              const isLaunchingResult = launching === result.session_id;
              const isExpandedResult = expandedSession === result.session_id;
              return (
                <div key={result.session_id}>
                  <div
                    style={{
                      padding: '10px 16px', display: 'flex', gap: 10, alignItems: 'flex-start',
                      transition: 'background 0.15s',
                      opacity: isLaunchingResult ? 0.7 : 1,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {sessionDisplayName(result)}
                      </div>
                      {/* Highlighted snippet */}
                      <div style={{
                        fontSize: 11, color: 'var(--text-secondary)', marginTop: 3,
                        lineHeight: '1.4', fontStyle: 'italic',
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      }}>
                        {highlightMatch(result.snippet, searchQuery)}
                      </div>
                      {/* Meta + actions */}
                      <div style={{
                        fontSize: 10, color: 'var(--text-muted)', marginTop: 4,
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}>
                        <span>{projectDisplayName(result.project)}</span>
                        <span>{formatSize(result.size_mb)}</span>
                        <span>{timeAgo(result.updated_at)}</span>
                        <span
                          onClick={() => copySessionId(result.session_id)}
                          title={`Copy ID: ${result.session_id}`}
                          style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, transition: 'color 0.15s' }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                        >
                          {result.session_id.slice(0, 8)}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </span>
                        <span style={{ flex: 1 }} />
                        {/* Preview */}
                        <button
                          type="button"
                          onClick={() => handlePreviewSession({ ...result, first_message: result.first_message || '', created_at: result.updated_at, cwd: result.cwd || '', size_mb: result.size_mb } as ClaudeSession & { project: string })}
                          disabled={previewLoading && expandedSession !== result.session_id}
                          title="Preview conversation"
                          style={{
                            background: isExpandedResult ? 'rgba(var(--accent-rgb), 0.15)' : 'rgba(var(--accent-rgb), 0.08)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 8px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                            color: isExpandedResult ? 'var(--accent)' : 'var(--text-secondary)',
                            fontSize: 10, fontFamily: 'inherit', transition: 'all 0.15s',
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          Preview
                        </button>
                        {/* Open */}
                        <button
                          type="button"
                          onClick={() => handleOpenSearchResult(result)}
                          disabled={!!launching}
                          title="Resume in terminal"
                          style={{
                            background: 'rgba(var(--accent-rgb), 0.12)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 8px',
                            cursor: isLaunchingResult ? 'wait' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                            color: 'var(--accent)', fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          Open
                        </button>
                        {/* Delete */}
                        <button
                          type="button"
                          onClick={() => handleDeleteSession({ ...result, first_message: result.first_message || '', created_at: result.updated_at, cwd: result.cwd || '', size_mb: result.size_mb } as ClaudeSession & { project: string })}
                          title="Delete session"
                          style={{
                            background: 'rgba(255, 60, 60, 0.08)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 6px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center',
                            color: 'var(--text-muted)', fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = '#ff3c3c'; e.currentTarget.style.background = 'rgba(255, 60, 60, 0.15)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'rgba(255, 60, 60, 0.08)'; }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded preview for search result */}
                  {isExpandedResult && (
                    <div style={{
                      margin: '0 16px 8px', padding: '10px 12px',
                      borderRadius: 8,
                      background: 'rgba(var(--accent-rgb), 0.04)',
                      border: '1px solid var(--glass-border)',
                      maxHeight: 400, overflow: 'auto',
                    }}>
                      {sessionMessages.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', padding: 12 }}>
                          No messages in this session
                        </div>
                      ) : (
                        sessionMessages.map((msg, i) => (
                          <div key={i} style={{
                            marginBottom: i < sessionMessages.length - 1 ? 10 : 0,
                            paddingBottom: i < sessionMessages.length - 1 ? 10 : 0,
                            borderBottom: i < sessionMessages.length - 1 ? '1px solid var(--glass-border)' : 'none',
                          }}>
                            <div style={{
                              fontSize: 10, fontWeight: 600,
                              color: msg.role === 'user' ? 'var(--accent)' : 'var(--text-secondary)',
                              marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                            }}>
                              {msg.role === 'user' ? 'You' : 'Claude'}
                              {msg.timestamp && (
                                <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--text-muted)' }}>
                                  {timeAgo(msg.timestamp)}
                                </span>
                              )}
                            </div>
                            <pre style={{
                              margin: 0, fontSize: 11, lineHeight: 1.5,
                              color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word', fontFamily: 'inherit',
                            }}>
                              {msg.content}
                            </pre>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Sessions section */}
        {filteredSessions.length > 0 && (
          <div>
            <div style={{
              padding: '6px 16px', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1 }}>
                {viewMode === 'communication' ? 'Чаты общения' : 'Sessions'} ({filteredSessions.length})
              </span>
              {viewMode === 'normal' && folderTargetPath && !searchQuery && (
                <button
                  type="button"
                  onClick={() => startNewChatInFolder(folderTargetPath)}
                  title={`New chat in ${baseName(folderTargetPath)}`}
                  style={{
                    padding: '2px 8px', borderRadius: 10, cursor: 'pointer',
                    fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
                    textTransform: 'none', letterSpacing: 'normal',
                    display: 'flex', alignItems: 'center', gap: 3,
                    background: 'rgba(var(--accent-rgb), 0.15)',
                    border: '1px solid rgba(var(--accent-rgb), 0.4)',
                    color: 'var(--accent-bright)',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New chat
                </button>
              )}
            </div>
            {filteredSessions.map((session) => {
              const isLaunching = launching === session.session_id;
              const isExpanded = expandedSession === session.session_id;
              return (
                <div key={session.session_id}>
                  <div
                    style={{
                      width: '100%', textAlign: 'left',
                      background: isLaunching ? 'rgba(var(--accent-rgb), 0.08)' : 'none',
                      padding: '10px 16px',
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      transition: 'background 0.15s',
                      opacity: isLaunching ? 0.7 : 1,
                    }}
                    onMouseEnter={(e) => { if (!isLaunching) e.currentTarget.style.background = 'var(--glass-hover)'; }}
                    onMouseLeave={(e) => { if (!isLaunching) e.currentTarget.style.background = isLaunching ? 'rgba(var(--accent-rgb), 0.08)' : 'none'; }}
                  >
                    {/* Terminal icon */}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                      <polyline points="4 17 10 11 4 5" />
                      <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Session name — first_message as primary (inline rename when editing) */}
                      {renamingId === session.session_id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename(session, renameValue); }
                            else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                          }}
                          onBlur={() => commitRename(session, renameValue)}
                          style={{
                            width: '100%', fontSize: 12, fontWeight: 500,
                            color: 'var(--text-primary)', fontFamily: 'inherit',
                            background: 'rgba(var(--accent-rgb), 0.08)',
                            border: '1px solid rgba(var(--accent-rgb), 0.4)',
                            borderRadius: 4, padding: '2px 6px', outline: 'none',
                          }}
                        />
                      ) : (
                        <div style={{
                          fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {sessionDisplayName(session)}
                        </div>
                      )}
                      {/* 2-line preview of first_message */}
                      {session.first_message && (
                        <div style={{
                          fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          lineHeight: '1.4',
                        }}>
                          {session.first_message}
                        </div>
                      )}
                      {/* Meta line + action buttons */}
                      <div style={{
                        fontSize: 10, color: 'var(--text-muted)', marginTop: 4,
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}>
                        <span>{projectDisplayName(session.project)}</span>
                        <span>{formatSize(session.size_mb)}</span>
                        {(session.branch_count ?? 0) > 1 && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleToggleBranches(session); }}
                            style={{
                              background: expandedBranches === session.session_id
                                ? 'rgba(var(--accent-rgb), 0.25)' : 'rgba(var(--accent-rgb), 0.15)',
                              color: 'var(--accent)',
                              padding: '0 4px',
                              borderRadius: 3,
                              fontSize: 9,
                              fontWeight: 600,
                              border: 'none',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              transition: 'background 0.15s',
                            }}
                          >
                            {session.branch_count} branches
                          </button>
                        )}
                        <span>{timeAgo(session.updated_at)}</span>
                        <span
                          onClick={() => copySessionId(session.session_id)}
                          title={`Copy ID: ${session.session_id}`}
                          style={{
                            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3,
                            transition: 'color 0.15s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                        >
                          {session.session_id.slice(0, 8)}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </span>
                        <span style={{ flex: 1 }} />
                        {/* Preview button */}
                        <button
                          type="button"
                          onClick={() => handlePreviewSession(session)}
                          disabled={previewLoading && expandedSession !== session.session_id}
                          title="Preview conversation"
                          style={{
                            background: isExpanded ? 'rgba(var(--accent-rgb), 0.15)' : 'rgba(var(--accent-rgb), 0.08)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 8px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                            color: isExpanded ? 'var(--accent)' : 'var(--text-secondary)',
                            fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          Preview
                        </button>
                        {/* Open button */}
                        <button
                          type="button"
                          onClick={() => handleOpenSession(session)}
                          disabled={!!launching}
                          title="Resume in terminal"
                          style={{
                            background: 'rgba(var(--accent-rgb), 0.12)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 8px',
                            cursor: isLaunching ? 'wait' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                            color: 'var(--accent)',
                            fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          Open
                        </button>
                        {/* Rename button */}
                        <button
                          type="button"
                          onClick={() => beginRename(session)}
                          title="Переименовать сессию"
                          style={{
                            background: 'rgba(var(--accent-rgb), 0.06)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 6px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center',
                            color: 'var(--text-muted)',
                            fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'rgba(var(--accent-rgb), 0.15)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'rgba(var(--accent-rgb), 0.06)'; }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </button>
                        {/* Delete button */}
                        <button
                          type="button"
                          onClick={() => handleDeleteSession(session)}
                          title="Delete session"
                          style={{
                            background: 'rgba(255, 60, 60, 0.08)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 4, padding: '3px 6px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center',
                            color: 'var(--text-muted)',
                            fontSize: 10, fontFamily: 'inherit',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = '#ff3c3c'; e.currentTarget.style.background = 'rgba(255, 60, 60, 0.15)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'rgba(255, 60, 60, 0.08)'; }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded branches */}
                  {expandedBranches === session.session_id && (
                    <div style={{
                      margin: '4px 16px 4px 40px',
                      borderRadius: 6,
                      background: 'rgba(var(--accent-rgb), 0.04)',
                      border: '1px solid var(--glass-border)',
                      overflow: 'hidden',
                    }}>
                      {branchesLoading ? (
                        <div style={{ padding: 8, color: 'var(--text-muted)', fontSize: 11, textAlign: 'center' }}>
                          Loading branches...
                        </div>
                      ) : branches.length === 0 ? (
                        <div style={{ padding: 8, color: 'var(--text-muted)', fontSize: 11, textAlign: 'center' }}>
                          No branches found
                        </div>
                      ) : (
                        branches.map((branch, idx) => (
                          <div
                            key={branch.branch_id}
                            style={{
                              padding: '6px 10px',
                              display: 'flex', alignItems: 'center', gap: 8,
                              borderBottom: idx < branches.length - 1 ? '1px solid var(--glass-border)' : 'none',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-hover)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            {/* Branch icon */}
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"
                              strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
                              <line x1="6" y1="3" x2="6" y2="15" />
                              <circle cx="18" cy="6" r="3" />
                              <circle cx="6" cy="18" r="3" />
                              <path d="M18 9a9 9 0 0 1-9 9" />
                            </svg>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 11, color: 'var(--text-primary)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {branch.name || branch.first_message || `Branch ${idx + 1}`}
                              </div>
                              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                                {branch.message_count} msgs · {timeAgo(branch.created_at)}
                              </div>
                            </div>
                            {/* Open branch button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenSession({ session_id: session.session_id, cwd: session.cwd });
                              }}
                              disabled={!!launching}
                              style={{
                                background: 'rgba(var(--accent-rgb), 0.12)',
                                border: '1px solid var(--glass-border)',
                                borderRadius: 4, padding: '2px 6px',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3,
                                color: 'var(--accent)', fontSize: 9, fontFamily: 'inherit',
                                transition: 'all 0.15s',
                              }}
                            >
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="5 3 19 12 5 21 5 3" />
                              </svg>
                              Open
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {/* Expanded preview — rich chat renderer (history, read-only) */}
                  {isExpanded && (
                    <div style={{
                      margin: '0 16px 8px',
                      borderRadius: 8,
                      background: 'rgba(var(--accent-rgb), 0.04)',
                      border: '1px solid var(--glass-border)',
                      height: 380, overflow: 'hidden',
                    }}>
                      <ClaudeChatView project={session.project} sessionFile={session.session_id} readOnly />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Searching indicator */}
        {searching && (
          <div style={{
            padding: '12px 16px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: 11,
          }}>
            Searching...
          </div>
        )}

        {/* No results — only when neither full-text nor local name matches exist */}
        {searchQuery && !searching && searchResults !== null && searchResults.length === 0 && filteredSessions.length === 0 && (
          <div style={{
            padding: '20px 16px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: 12,
          }}>
            No sessions matching &quot;{searchQuery}&quot;
          </div>
        )}

        {/* No sessions for selected folder (tree node or picked folder) */}
        {viewMode === 'normal' && !searchQuery && filteredSessions.length === 0 && (selectedFolder || pickedFolderPath) && (
          <div style={{
            padding: '20px 16px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: 12,
          }}>
            No sessions in this folder
            {folderTargetPath && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => startNewChatInFolder(folderTargetPath)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'rgba(var(--accent-rgb), 0.15)',
                    border: '1px solid rgba(var(--accent-rgb), 0.4)',
                    borderRadius: 8, padding: '6px 14px',
                    cursor: 'pointer', color: 'var(--accent-bright)',
                    fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New chat
                </button>
              </div>
            )}
            {selectedFolder && !includeSubfolders && (
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => setIncludeSubfolders(true)}
                  style={{
                    background: 'rgba(var(--accent-rgb), 0.1)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 6, padding: '4px 12px',
                    cursor: 'pointer', color: 'var(--accent)',
                    fontSize: 11, fontFamily: 'inherit',
                  }}
                >
                  Include subfolders
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {pickerOpen && user?.workspace_dir && (
        <FolderPicker
          startPath={user.workspace_dir}
          onSelect={(p) => {
            setPickedFolderPath(p);
            setSelectedFolder(null);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      </>}
    </div>
  );
}
