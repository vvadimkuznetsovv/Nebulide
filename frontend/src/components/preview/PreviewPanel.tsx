import { useState } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { getRawFileUrl } from '../../api/files';
import DocxViewer from './DocxViewer';

export default function PreviewPanel() {
  const {
    previewUrl,
    setPreviewUrl,
    setPreviewFile,
    previewTabs,
    activePreviewTabId,
    closePreviewTab,
    setActivePreviewTab,
  } = useWorkspaceStore();
  const [urlInput, setUrlInput] = useState(previewUrl || '');

  const activeTab = previewTabs.find((t) => t.id === activePreviewTabId) || null;
  const showUrlMode = !activeTab;

  const handleGo = () => {
    const url = urlInput.trim();
    if (!url) return;
    const fullUrl = url.startsWith('http') ? url : `http://${url}`;
    setPreviewUrl(fullUrl);
    setActivePreviewTab(null);
  };

  const handleClear = () => {
    setPreviewUrl(null);
    setPreviewFile(null);
    setUrlInput('');
  };

  const handleUrlTabClick = () => {
    setActivePreviewTab(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar — shown when document tabs exist */}
      {previewTabs.length > 0 && (
        <div className="preview-tab-bar">
          {/* URL tab */}
          <button
            type="button"
            className={`preview-tab ${showUrlMode ? 'active' : ''}`}
            onClick={handleUrlTabClick}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span>URL</span>
          </button>

          {/* Document tabs */}
          {previewTabs.map((tab) => {
            const fileName = tab.filePath.split('/').pop() || tab.filePath;
            const isActive = tab.id === activePreviewTabId;
            return (
              <div
                key={tab.id}
                className={`preview-tab ${isActive ? 'active' : ''}`}
                onClick={() => setActivePreviewTab(tab.id)}
                title={tab.filePath}
              >
                <span
                  className={`text-[9px] font-bold font-mono shrink-0 ${tab.type === 'pdf' ? 'text-red-500' : 'text-blue-500'}`}
                >
                  {tab.type === 'pdf' ? 'PD' : 'DX'}
                </span>
                <span className="truncate">{fileName}</span>
                <span
                  className="tab-close-btn"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    closePreviewTab(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.stopPropagation(); closePreviewTab(tab.id); }
                  }}
                  title="Close"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* URL bar — shown in URL mode */}
      {showUrlMode && (
        <div className="preview-url-bar">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleGo(); }}
            placeholder="http://localhost:3000"
            className="glass-input flex-1 px-3 py-1.5 rounded-lg text-xs"
          />
          <button type="button" onClick={handleGo} className="btn-glass px-3 py-1.5 rounded-lg text-xs">
            Go
          </button>
          <button type="button" onClick={handleClear} className="btn-glass px-3 py-1.5 rounded-lg text-xs">
            Clear
          </button>
        </div>
      )}

      {/* Preview content */}
      <div className="flex-1 overflow-hidden">
        {/* URL mode content */}
        {showUrlMode && !previewUrl && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4" style={{ opacity: 0.15, color: 'var(--accent)' }}>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Enter a URL to preview
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Preview frontend sites, PDFs, and more
              </p>
            </div>
          </div>
        )}

        {showUrlMode && previewUrl && (
          <iframe
            src={previewUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="Preview"
          />
        )}

        {/* Document mode content */}
        {activeTab?.type === 'pdf' && (
          <iframe
            src={getRawFileUrl(activeTab.filePath)}
            className="w-full h-full border-0"
            title={`PDF: ${activeTab.filePath.split('/').pop()}`}
          />
        )}

        {activeTab?.type === 'docx' && (
          <DocxViewer filePath={activeTab.filePath} />
        )}
      </div>
    </div>
  );
}
