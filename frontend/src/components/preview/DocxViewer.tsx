import { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { readFileRaw } from '../../api/files';

interface DocxViewerProps {
  filePath: string;
}

export default function DocxViewer({ filePath }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Clear previous render
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }

    readFileRaw(filePath)
      .then(({ data }) => {
        if (cancelled || !containerRef.current) return;
        return renderAsync(data, containerRef.current, undefined, {
          className: 'docx-viewer-page',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          useBase64URL: true,
        });
      })
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load document';
        setError(message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3" style={{ color: '#ef4444' }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto docx-viewer-container" style={{ background: '#525659' }}>
      {loading && (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mb-3" style={{ color: 'var(--accent)' }} />
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading document...</p>
          </div>
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}
