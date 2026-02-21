import type { PanelId } from '../../store/layoutUtils';
import { useLayoutStore } from '../../store/layoutStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import ChatPanel from '../chat/ChatPanel';
import FileTree from '../files/FileTree';
import CodeEditor from '../editor/CodeEditor';
import TerminalComponent from '../terminal/Terminal';

const panelIcons: Record<PanelId, React.ReactNode> = {
  chat: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  files: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  editor: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  terminal: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
};

export const panelTitles: Record<PanelId, string> = {
  chat: 'Chat',
  files: 'File Manager',
  editor: 'Code Editor',
  terminal: 'Terminal',
};

export { panelIcons };

export default function PanelContent({ panelId }: { panelId: PanelId }) {
  const { visibility, toggleVisibility } = useLayoutStore();
  const { activeSession, editingFile, sidebarOpen, toolbarOpen, setSidebarOpen, setToolbarOpen, setEditingFile } = useWorkspaceStore();

  switch (panelId) {
    case 'chat':
      return (
        <div className="flex flex-col h-full">
          {/* Chat sub-header */}
          <div
            className="flex items-center gap-3 px-3 py-2"
            style={{
              borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
              background: 'rgba(0, 0, 0, 0.1)',
            }}
          >
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200"
              title={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
              style={{
                background: sidebarOpen ? 'rgba(127, 0, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)',
                border: sidebarOpen ? '1px solid rgba(127, 0, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
                color: sidebarOpen ? 'var(--accent-bright)' : 'rgba(255, 255, 255, 0.5)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {sidebarOpen ? (
                  <>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </>
                ) : (
                  <>
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </>
                )}
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setToolbarOpen(!toolbarOpen)}
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200"
              title="Panel settings"
              style={{
                background: toolbarOpen ? 'rgba(127, 0, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)',
                border: toolbarOpen ? '1px solid rgba(127, 0, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
                color: toolbarOpen ? 'var(--accent-bright)' : 'rgba(255, 255, 255, 0.5)',
                marginLeft: '-4px',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-secondary)' }}>
              {activeSession?.title || 'Claude Code'}
            </span>
          </div>
          {/* Toolbar */}
          <div
            className="workspace-toolbar"
            style={{
              maxHeight: toolbarOpen ? '52px' : '0px',
              opacity: toolbarOpen ? 1 : 0,
              padding: toolbarOpen ? '8px 12px' : '0 12px',
            }}
          >
            {(['files', 'editor', 'terminal'] as PanelId[]).map((panel) => (
              <button
                key={panel}
                type="button"
                className={`workspace-toolbar-btn ${visibility[panel] ? 'active' : ''}`}
                onClick={() => toggleVisibility(panel)}
                title={visibility[panel] ? `Hide ${panelTitles[panel]}` : `Show ${panelTitles[panel]}`}
              >
                {panelIcons[panel]}
                {panelTitles[panel]}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                  {visibility[panel] ? (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  ) : (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </>
                  )}
                </svg>
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-hidden">
            <ChatPanel sessionId={activeSession?.id || null} />
          </div>
        </div>
      );

    case 'files':
      return (
        <div className="h-full overflow-hidden">
          <FileTree
            rootPath={activeSession?.working_directory}
            onFileSelect={(path) => setEditingFile(path)}
          />
        </div>
      );

    case 'editor':
      return <CodeEditor filePath={editingFile} />;

    case 'terminal':
      return <TerminalComponent active={visibility.terminal} />;
  }
}
