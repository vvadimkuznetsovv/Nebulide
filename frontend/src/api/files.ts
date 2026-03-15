import api from './client';

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
}

export interface FileListResponse {
  path: string;
  files: FileEntry[];
}

export interface FileReadResponse {
  path: string;
  content: string;
  size: number;
}

export const listFiles = (path?: string) =>
  api.get<FileListResponse>('/files', { params: { path } });

export const readFile = (path: string) =>
  api.get<FileReadResponse>('/files/read', { params: { path } });

export const writeFile = (path: string, content: string) =>
  api.put('/files/write', { path, content });

export const deleteFile = (path: string) =>
  api.delete('/files', { params: { path } });

export const mkdirFile = (path: string) =>
  api.post('/files/mkdir', { path });

export const renameFile = (oldPath: string, newPath: string) =>
  api.post('/files/rename', { old_path: oldPath, new_path: newPath });

// Search files by name or content
export interface SearchMatch {
  line_number: number;
  content: string;
}

export interface SearchResult {
  path: string;
  is_dir: boolean;
  matches?: SearchMatch[];
}

export interface SearchResponse {
  results: SearchResult[];
}

export const searchFiles = (params: { q: string; type?: 'content' | 'name'; include?: string; exclude?: string }) =>
  api.get<SearchResponse>('/files/search', { params });

// Extract archive (zip/rar) in place
export const extractArchive = (path: string) =>
  api.post('/files/extract', { path });

// Send file to user's Telegram via bot
export const sendToTelegram = (filePath: string) =>
  api.post('/telegram/send', { file_path: filePath });

// Copy file or directory
export const copyFile = (source: string, destination: string) =>
  api.post('/files/copy', { source, destination });

// Upload binary file (multipart/form-data)
export const uploadFile = (file: Blob, dir?: string, filename?: string) => {
  const form = new FormData();
  form.append('file', file, filename || 'upload');
  return api.post<{ path: string }>('/files/upload', form, {
    params: dir ? { dir } : undefined,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

// Build download URL (triggers browser download, auto-zips folders)
export function getDownloadUrl(path: string): string {
  const token = localStorage.getItem('access_token');
  const params = new URLSearchParams({ path });
  if (token) params.set('token', token);
  return `/api/files/download?${params.toString()}`;
}

// Build URL for raw binary file serving (PDF iframe, etc.)
export function getRawFileUrl(path: string): string {
  const token = localStorage.getItem('access_token');
  const params = new URLSearchParams({ path });
  if (token) params.set('token', token);
  return `/api/files/raw?${params.toString()}`;
}

// Fetch raw binary content as ArrayBuffer (for DOCX preview, etc.)
export const readFileRaw = (path: string) =>
  api.get<ArrayBuffer>('/files/raw', { params: { path }, responseType: 'arraybuffer' });

// Build URL for DOCX→PDF conversion via LibreOffice (server-side)
export function getConvertPdfUrl(path: string): string {
  const token = localStorage.getItem('access_token');
  const params = new URLSearchParams({ path });
  if (token) params.set('token', token);
  return `/api/files/convert-pdf?${params.toString()}`;
}
