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

// Build URL for raw binary file serving (PDF iframe, etc.)
export function getRawFileUrl(path: string): string {
  const token = localStorage.getItem('access_token');
  const params = new URLSearchParams({ path });
  if (token) params.set('token', token);
  return `/api/files/raw?${params.toString()}`;
}

// Fetch raw binary content as ArrayBuffer (for mammoth DOCX processing)
export const readFileRaw = (path: string) =>
  api.get<ArrayBuffer>('/files/raw', { params: { path }, responseType: 'arraybuffer' });
