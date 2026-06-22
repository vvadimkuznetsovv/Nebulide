import api from './client';

// Скиллы Claude Code. «Свои» — project-скиллы в {workspace}/.claude/skills/<name>/SKILL.md
// (управляемые: загрузка/переименование/удаление/превью). «Claude» — установленные плагины/бандл
// (read-only список, вставляются в ввод как /имя). См. backend/handlers/skills.go.

export interface OwnSkill {
  name: string;
  description: string;
  updated_at: string;
}
export interface ClaudeSkill {
  name: string;
  description: string;
  source: string; // 'plugin' | 'personal'
}
export interface SkillsListResponse {
  own: OwnSkill[];
  claude: ClaudeSkill[];
}

export const listSkills = () => api.get<SkillsListResponse>('/skills');

export const uploadSkill = (name: string, file: File) => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('file', file);
  return api.post<{ name: string }>('/skills/upload', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

export const renameSkill = (oldName: string, newName: string) =>
  api.post<{ name: string }>('/skills/rename', { old_name: oldName, new_name: newName });

export const deleteSkill = (name: string) =>
  api.delete<{ ok: boolean }>('/skills', { params: { name } });

export const readSkill = (name: string) =>
  api.get<{ content: string }>('/skills/read', { params: { name } });
