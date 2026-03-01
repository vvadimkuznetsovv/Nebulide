import { useState, useEffect } from 'react';
import { convertToHtml } from 'mammoth';
import DOMPurify from 'dompurify';
import { readFileRaw } from '../../api/files';

interface DocxViewerProps {
  filePath: string;
}

export default function DocxViewer({ filePath }: DocxViewerProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtml(null);

    readFileRaw(filePath)
      .then(({ data }) => convertToHtml({ arrayBuffer: data }))
      .then((result) => {
        if (cancelled) return;
        const clean = DOMPurify.sanitize(result.value, {
          ALLOWED_TAGS: [
            'p', 'br', 'b', 'i', 'u', 'em', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
            'a', 'img', 'span', 'div', 'blockquote', 'pre', 'code', 'sup', 'sub',
          ],
          ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style', 'colspan', 'rowspan'],
          ALLOW_DATA_ATTR: false,
        });
        setHtml(clean);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load document';
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mb-3" style={{ color: 'var(--accent)' }} />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading document...</p>
        </div>
      </div>
    );
  }

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
    <div
      className="docx-content h-full overflow-auto p-8"
      dangerouslySetInnerHTML={{ __html: html || '' }}
    />
  );
}
