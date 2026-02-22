import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { readFile, writeFile } from '../../api/files';
import { useWorkspaceStore } from '../../store/workspaceStore';
import ContextMenu, { type ContextMenuItem } from '../files/ContextMenu';
import toast from 'react-hot-toast';

interface CodeEditorProps {
  filePath: string | null;
  tabId: string | null;
}

interface TabState {
  content: string;
  originalContent: string;
  viewState: unknown;
}

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    go: 'go',
    py: 'python',
    rs: 'rust',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    css: 'css',
    scss: 'scss',
    html: 'html',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    toml: 'toml',
    xml: 'xml',
    env: 'plaintext',
    txt: 'plaintext',
    mod: 'go',
    sum: 'plaintext',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  };
  return map[ext || ''] || 'plaintext';
}

// Feather-style SVG icons (14×14)
const EDITOR_ICONS = {
  save: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" />
    </svg>
  ),
  cut: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.12 15.88" /><path d="M14.47 14.48L20 20" /><path d="M8.12 8.12L12 12" />
    </svg>
  ),
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  clipboard: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  ),
  command: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
    </svg>
  ),
};

export default function CodeEditor({ filePath, tabId }: CodeEditorProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [modified, setModified] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const { setTabModified } = useWorkspaceStore();

  // Cache tab states to preserve content/viewState between tab switches
  const tabStatesRef = useRef<Map<string, TabState>>(new Map());
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const previousTabIdRef = useRef<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!filePath || !modified || !tabId) return;
    try {
      await writeFile(filePath, content);
      setOriginalContent(content);
      setModified(false);
      setTabModified(tabId, false);
      // Update cache
      tabStatesRef.current.set(tabId, {
        content,
        originalContent: content,
        viewState: editorRef.current?.saveViewState() ?? null,
      });
      toast.success('File saved');
    } catch {
      toast.error('Failed to save file');
    }
  }, [filePath, content, modified, tabId, setTabModified]);

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Keep Ctrl+S keybinding for save (no context menu group — we use our own menu)
    editor.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => { handleSaveRef.current(); },
    });

    // Intercept right-click to show our custom context menu
    editor.onContextMenu((e) => {
      e.event.preventDefault();
      e.event.stopPropagation();
      setCtxMenu({ x: e.event.posx, y: e.event.posy });
    });

    // Restore viewState if switching to a cached tab
    if (tabId) {
      const cached = tabStatesRef.current.get(tabId);
      if (cached?.viewState) {
        editor.restoreViewState(cached.viewState as Parameters<typeof editor.restoreViewState>[0]);
      }
    }
  };

  // Save current tab state before switching
  const saveCurrentTabState = useCallback(() => {
    const prevId = previousTabIdRef.current;
    if (prevId && editorRef.current) {
      tabStatesRef.current.set(prevId, {
        content,
        originalContent,
        viewState: editorRef.current.saveViewState(),
      });
    }
  }, [content, originalContent]);

  // Load file when filePath/tabId changes
  useEffect(() => {
    if (!filePath || !tabId) {
      previousTabIdRef.current = tabId;
      return;
    }

    // Save previous tab state
    saveCurrentTabState();

    // If same tab but filePath changed (tab reused for different file), invalidate cache
    if (previousTabIdRef.current === tabId) {
      tabStatesRef.current.delete(tabId);
    }

    // Check cache for this tab
    const cached = tabStatesRef.current.get(tabId);
    if (cached) {
      setContent(cached.content);
      setOriginalContent(cached.originalContent);
      const isModified = cached.content !== cached.originalContent;
      setModified(isModified);

      // Restore viewState after a tick
      if (editorRef.current && cached.viewState) {
        setTimeout(() => {
          editorRef.current?.restoreViewState(
            cached.viewState as Parameters<NonNullable<typeof editorRef.current>['restoreViewState']>[0],
          );
        }, 0);
      }
    } else {
      // Fetch from server
      setLoading(true);
      readFile(filePath)
        .then(({ data }) => {
          setContent(data.content);
          setOriginalContent(data.content);
          setModified(false);
        })
        .catch(() => toast.error('Failed to read file'))
        .finally(() => setLoading(false));
    }

    previousTabIdRef.current = tabId;
  }, [filePath, tabId]);

  const handleCtxAction = useCallback((action: string) => {
    setCtxMenu(null);
    const editor = editorRef.current;
    if (!editor) return;

    switch (action) {
      case 'save':
        handleSaveRef.current();
        break;
      case 'cut':
        editor.focus();
        editor.trigger('contextMenu', 'editor.action.clipboardCutAction', null);
        break;
      case 'copy':
        editor.focus();
        editor.trigger('contextMenu', 'editor.action.clipboardCopyAction', null);
        break;
      case 'paste':
        editor.focus();
        navigator.clipboard.readText()
          .then((text) => {
            editor.executeEdits('paste', [{
              range: editor.getSelection()!,
              text,
              forceMoveMarkers: true,
            }]);
          })
          .catch(() => toast.error('Failed to paste'));
        break;
      case 'command-palette':
        editor.focus();
        editor.trigger('contextMenu', 'editor.action.quickCommand', null);
        break;
    }
  }, []);

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4" style={{ opacity: 0.1, color: 'var(--accent)' }}>
            {'</>'}
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Select a file to edit
          </p>
        </div>
      </div>
    );
  }

  const hasSelection = editorRef.current?.getSelection()?.isEmpty() === false;

  const ctxMenuItems: ContextMenuItem[] = [
    { label: 'Save File', action: 'save', icon: EDITOR_ICONS.save, disabled: !modified },
    { type: 'separator' },
    { label: 'Cut', action: 'cut', icon: EDITOR_ICONS.cut, disabled: !hasSelection },
    { label: 'Copy', action: 'copy', icon: EDITOR_ICONS.copy, disabled: !hasSelection },
    { label: 'Paste', action: 'paste', icon: EDITOR_ICONS.clipboard },
    { type: 'separator' },
    { label: 'Command Palette', action: 'command-palette', icon: EDITOR_ICONS.command },
  ];

  return (
    <div className="h-full">
      {loading ? (
        <div className="flex items-center justify-center h-full">
          <span className="text-sm glow-pulse" style={{ color: 'var(--text-secondary)' }}>
            Loading...
          </span>
        </div>
      ) : (
        <Editor
          height="100%"
          language={getLanguage(filePath)}
          value={content}
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={(value) => {
            const newContent = value || '';
            setContent(newContent);
            const isModified = newContent !== originalContent;
            setModified(isModified);
            if (tabId) setTabModified(tabId, isModified);
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 8 },
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            contextmenu: false,
          }}
        />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
