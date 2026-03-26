import api from './client';

export interface LLMSession {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface LLMMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export const listLLMSessions = () =>
  api.get<LLMSession[]>('/llm/sessions');

export const createLLMSession = (title?: string, model?: string) =>
  api.post<LLMSession>('/llm/sessions', { title, model });

export const deleteLLMSession = (id: string) =>
  api.delete(`/llm/sessions/${id}`);

export const getLLMMessages = (id: string) =>
  api.get<LLMMessage[]>(`/llm/sessions/${id}/messages`);

export const analyzeImage = (image: string) =>
  api.post<{ description: string }>('/llm/vision', { image });

export async function sendLLMMessage(
  sessionId: string,
  content: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  imageDescription?: string,
) {
  const token = localStorage.getItem('access_token');
  try {
    const resp = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ session_id: sessionId, content, image_description: imageDescription }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      onError(errBody);
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) { onError('No response body'); return; }

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      // Parse SSE lines
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) onChunk(content);
          } catch { /* skip unparseable */ }
        }
      }
    }
    onDone();
  } catch (e) {
    onError(String(e));
  }
}
