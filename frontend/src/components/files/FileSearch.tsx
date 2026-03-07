import { useState, useRef, useEffect } from 'react';
import { searchFiles, type SearchResult } from '../../api/files';

interface FileSearchProps {
  onFileSelect: (path: string, line?: number) => void;
}

export default function FileSearch({ onFileSelect }: FileSearchProps) {
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<'content' | 'name'>('content');
  const [includeGlob, setIncludeGlob] = useState('');
  const [excludeGlob, setExcludeGlob] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const searchTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus search input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const params: { q: string; type: 'content' | 'name'; include?: string; exclude?: string } = {
      q: q.trim(),
      type: searchType,
    };
    if (includeGlob.trim()) params.include = includeGlob.trim();
    if (excludeGlob.trim()) params.exclude = excludeGlob.trim();

    searchFiles(params)
      .then(({ data }) => {
        setResults(data.results || []);
        // Auto-expand all results for content search
        if (searchType === 'content') {
          setExpandedFiles(new Set((data.results || []).map((r) => r.path)));
        }
      })
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  };

  const handleInputChange = (val: string) => {
    setQuery(val);
    // Debounce search by 400ms
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => doSearch(val), 400);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      doSearch(query);
    }
  };

  const toggleExpand = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const fileName = (path: string) => path.split(/[/\\]/).pop() || path;
  const dirName = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  };

  return (
    <div className="h-full flex flex-col">
      {/* Search input */}
      <div
        className="px-2 py-2 flex flex-col gap-1.5"
        style={{ borderBottom: '1px solid var(--glass-border)' }}
      >
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            className="flex-1 text-sm px-2 py-1 bg-transparent outline-none"
            style={{
              borderRadius: '4px',
              border: '1px solid var(--glass-border)',
              color: 'var(--text-primary)',
              background: 'rgba(0,0,0,0.3)',
              minWidth: 0,
            }}
            placeholder={searchType === 'content' ? 'Search in files...' : 'Search file names...'}
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {/* Toggle content/name search */}
          <button
            type="button"
            className="shrink-0 text-[10px] font-mono px-1.5 py-1 rounded"
            style={{
              background: 'rgba(127, 0, 255, 0.15)',
              border: '1px solid var(--glass-border)',
              color: 'var(--text-secondary)',
            }}
            onClick={() => setSearchType((t) => (t === 'content' ? 'name' : 'content'))}
            title={`Mode: ${searchType}. Click to switch.`}
          >
            {searchType === 'content' ? 'Aa' : 'Fn'}
          </button>
          {/* Filter toggle */}
          <button
            type="button"
            className="shrink-0 text-[10px] font-mono px-1.5 py-1 rounded"
            style={{
              background: showFilters ? 'rgba(127, 0, 255, 0.25)' : 'rgba(127, 0, 255, 0.1)',
              border: '1px solid var(--glass-border)',
              color: 'var(--text-secondary)',
            }}
            onClick={() => setShowFilters((v) => !v)}
            title="Include/Exclude filters"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
          </button>
        </div>

        {/* Include/Exclude filters */}
        {showFilters && (
          <div className="flex flex-col gap-1">
            <input
              className="text-xs px-2 py-0.5 bg-transparent outline-none"
              style={{
                borderRadius: '3px',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                background: 'rgba(0,0,0,0.2)',
              }}
              placeholder="Include (e.g. *.ts)"
              value={includeGlob}
              onChange={(e) => setIncludeGlob(e.target.value)}
            />
            <input
              className="text-xs px-2 py-0.5 bg-transparent outline-none"
              style={{
                borderRadius: '3px',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                background: 'rgba(0,0,0,0.2)',
              }}
              placeholder="Exclude (e.g. *.min.js)"
              value={excludeGlob}
              onChange={(e) => setExcludeGlob(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto py-1 select-none" style={{ WebkitTouchCallout: 'none' }}>
        {loading ? (
          <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            <span className="glow-pulse inline-block">Searching...</span>
          </div>
        ) : results.length === 0 ? (
          query.trim() ? (
            <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              No results found
            </div>
          ) : (
            <div className="p-4 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Type to search
            </div>
          )
        ) : (
          results.map((result) => (
            <div key={result.path}>
              {/* File header */}
              <button
                type="button"
                className="file-tree-item w-full flex items-center gap-1.5 py-1 px-3 text-sm text-left"
                style={{ color: 'var(--text-primary)' }}
                onClick={() => {
                  if (result.matches && result.matches.length > 0) {
                    toggleExpand(result.path);
                  } else {
                    onFileSelect(result.path);
                  }
                }}
              >
                {result.matches && result.matches.length > 0 && (
                  <span
                    className="w-3 h-3 flex items-center justify-center shrink-0 transition-transform duration-150"
                    style={{ transform: expandedFiles.has(result.path) ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </span>
                )}
                <span className="font-medium whitespace-nowrap">{fileName(result.path)}</span>
                <span className="text-[10px] font-mono truncate" style={{ color: 'var(--text-tertiary)' }}>
                  {dirName(result.path)}
                </span>
                {result.matches && (
                  <span className="text-[10px] shrink-0 font-mono" style={{ color: 'var(--accent)' }}>
                    {result.matches.length}
                  </span>
                )}
              </button>

              {/* Match lines */}
              {result.matches && expandedFiles.has(result.path) && result.matches.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  className="w-full flex items-baseline gap-2 py-0.5 px-3 text-left hover:bg-white/5 transition-colors"
                  style={{ paddingLeft: '28px' }}
                  onClick={() => onFileSelect(result.path, m.line_number)}
                >
                  <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--accent)' }}>
                    {m.line_number}
                  </span>
                  <span
                    className="text-xs font-mono truncate"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {m.content.trim()}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
