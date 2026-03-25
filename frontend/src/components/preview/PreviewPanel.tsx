import { useState } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { getRawFileUrl, getConvertPdfUrl } from '../../api/files';
import DocxViewer from './DocxViewer';
import ImageViewer from './ImageViewer';

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
  const [pdfMode, setPdfMode] = useState<Record<string, boolean>>({});

  const activeTab = previewTabs.find((t) => t.id === activePreviewTabId) || null;
  const showUrlMode = !activeTab;

  const handleGo = () => {
    const url = urlInput.trim();
    if (!url) return;
    const fullUrl = url.startsWith('http') ? url : `http://${url}`;
    // Block dangerous protocols (javascript:, data:, vbscript:)
    try {
      const parsed = new URL(fullUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
    } catch {
      return;
    }
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
                  className={`text-[9px] font-bold font-mono shrink-0 ${
                    tab.type === 'pdf' ? 'text-red-500' :
                    tab.type === 'image' ? 'text-emerald-500' :
                    'text-blue-500'
                  }`}
                >
                  {tab.type === 'pdf' ? 'PD' : tab.type === 'image' ? 'IM' : 'DX'}
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
            sandbox="allow-scripts allow-forms allow-popups"
            title="Preview"
          />
        )}

        {/* Document mode content */}
        {activeTab?.type === 'pdf' && (() => {
          const rawUrl = getRawFileUrl(activeTab.filePath);
          const isMobile = window.innerWidth <= 640;
          const pdfSrc = isMobile
            ? `https://mozilla.github.io/pdf.js/web/viewer.html?file=${encodeURIComponent(window.location.origin + rawUrl)}`
            : rawUrl;
          return (
            <iframe
              src={pdfSrc}
              className="w-full h-full border-0"
              title={`PDF: ${activeTab.filePath.split('/').pop()}`}
              sandbox={isMobile ? 'allow-scripts allow-same-origin' : undefined}
            />
          );
        })()}

        {activeTab?.type === 'docx' && (
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <button
                type="button"
                className="btn-glass px-2.5 py-1 rounded text-[11px] font-medium flex items-center gap-1.5"
                style={{
                  background: pdfMode[activeTab.id]
                    ? 'rgba(127, 0, 255, 0.25)'
                    : 'rgba(255, 255, 255, 0.05)',
                  border: pdfMode[activeTab.id]
                    ? '1px solid var(--accent)'
                    : '1px solid var(--glass-border)',
                }}
                onClick={() => setPdfMode(prev => ({ ...prev, [activeTab.id]: !prev[activeTab.id] }))}
                title={pdfMode[activeTab.id] ? 'Switch to DOCX preview' : 'Convert to PDF (LibreOffice)'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                PDF
              </button>
              <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                {pdfMode[activeTab.id] ? 'LibreOffice PDF' : 'DOCX Preview'}
              </span>
            </div>
            <div className="flex-1 overflow-hidden">
              {pdfMode[activeTab.id] ? (() => {
                const convertUrl = getConvertPdfUrl(activeTab.filePath);
                const isMob = window.innerWidth <= 640;
                const src = isMob
                  ? `https://mozilla.github.io/pdf.js/web/viewer.html?file=${encodeURIComponent(window.location.origin + convertUrl)}`
                  : convertUrl;
                return (
                  <iframe
                    src={src}
                    className="w-full h-full border-0"
                    title={`PDF: ${activeTab.filePath.split('/').pop()}`}
                    sandbox={isMob ? 'allow-scripts allow-same-origin' : undefined}
                  />
                );
              })()
              ) : (
                <DocxViewer filePath={activeTab.filePath} />
              )}
            </div>
          </div>
        )}

        {activeTab?.type === 'image' && (
          <ImageViewer filePath={activeTab.filePath} />
        )}
      </div>
    </div>
  );
}
