import api from './client';

/** Upload recorded audio to the server-side Whisper and get the transcript. */
export async function transcribeAudio(blob: Blob, lang?: string): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  form.append('file', blob, `voice.${ext}`);
  if (lang) form.append('language', lang.split('-')[0]); // 'ru-RU' → 'ru'
  const res = await api.post<{ text: string }>('/voice/transcribe', form, { timeout: 120_000 });
  return res.data.text;
}
