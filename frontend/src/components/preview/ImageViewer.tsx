import { useState, useRef, useCallback } from 'react';
import { getRawFileUrl } from '../../api/files';

interface ImageViewerProps {
  filePath: string;
}

export default function ImageViewer({ filePath }: ImageViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleLoad = useCallback(() => {
    setLoading(false);
    setError(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setError(true);
  }, []);

  const zoomIn = () => { setFit(false); setZoom(z => Math.min(z * 1.25, 10)); };
  const zoomOut = () => { setFit(false); setZoom(z => Math.max(z / 1.25, 0.1)); };
  const resetZoom = () => { setFit(false); setZoom(1); };
  const fitToView = () => { setFit(true); setZoom(1); };

  const url = getRawFileUrl(filePath);

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1" style={{
        borderBottom: '1px solid var(--glass-border)',
        background: 'rgba(0,0,0,0.2)',
      }}>
        <button type="button" onClick={fitToView} className="btn-glass px-2 py-1 rounded text-[11px]"
          style={{ opacity: fit ? 1 : 0.6 }}>
          Fit
        </button>
        <button type="button" onClick={resetZoom} className="btn-glass px-2 py-1 rounded text-[11px]"
          style={{ opacity: !fit && zoom === 1 ? 1 : 0.6 }}>
          100%
        </button>
        <button type="button" onClick={zoomOut} className="btn-glass px-1.5 py-1 rounded text-[11px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </button>
        <button type="button" onClick={zoomIn} className="btn-glass px-1.5 py-1 rounded text-[11px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </button>
        {!fit && (
          <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>
            {Math.round(zoom * 100)}%
          </span>
        )}
      </div>

      {/* Image container */}
      <div ref={containerRef} className="flex-1 overflow-auto" style={{
        background: 'repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px',
      }}>
        {loading && (
          <div className="h-full flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
          </div>
        )}

        {error && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1" className="mx-auto mb-3" style={{ opacity: 0.3 }}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Failed to load image</p>
            </div>
          </div>
        )}

        <div style={{
          display: loading || error ? 'none' : 'flex',
          justifyContent: 'center',
          alignItems: fit ? 'center' : 'flex-start',
          minHeight: '100%',
          padding: fit ? '16px' : '0',
        }}>
          <img
            src={url}
            alt={filePath.split(/[/\\]/).pop() || ''}
            onLoad={handleLoad}
            onError={handleError}
            draggable={false}
            style={{
              maxWidth: fit ? '100%' : undefined,
              maxHeight: fit ? '100%' : undefined,
              objectFit: fit ? 'contain' : undefined,
              transform: fit ? undefined : `scale(${zoom})`,
              transformOrigin: 'top left',
              imageRendering: zoom > 2 ? 'pixelated' : 'auto',
            }}
          />
        </div>
      </div>
    </div>
  );
}
