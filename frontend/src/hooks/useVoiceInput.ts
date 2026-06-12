import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { transcribeAudio } from '../api/voice';
import { log } from '../utils/logger';

export type VoiceState = 'idle' | 'listening' | 'recording' | 'transcribing';
// 'listening'    — Web Speech API активен (распознавание в браузере)
// 'recording'    — fallback: MediaRecorder пишет аудио для серверного Whisper
// 'transcribing' — запись отправлена, ждём текст с сервера

// Web Speech в Chrome шлёт аудио на серверы Google — из РФ часто 'network'.
// После первой такой ошибки запоминаем и сразу идём через MediaRecorder.
const WEBSPEECH_BROKEN_KEY = 'nebulide-webspeech-broken';

const MAX_RECORDING_MS = 120_000;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

interface UseVoiceInputOptions {
  /** Получает распознанный текст (по фразе для Web Speech, целиком для Whisper) */
  onText: (text: string) => void;
  lang?: string;
}

interface UseVoiceInputResult {
  state: VoiceState;
  /** Микрофон активен (listening или recording) */
  active: boolean;
  /** Кнопка микрофона: старт/стоп. Клики во время transcribing игнорируются */
  toggle: () => Promise<void>;
  /** Остановить и выбросить всё без распознавания */
  cancel: () => void;
  /** true — используется серверная транскрипция вместо Web Speech */
  usingFallback: boolean;
}

export function useVoiceInput({ onText, lang }: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceState>('idle');
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoStopTimerRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const langValue = lang || navigator.language || 'en-US';

  const stopStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  }, []);

  const startRecorder = useCallback((stream: MediaStream) => {
    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      log('[Voice] MediaRecorder init failed:', e);
      toast.error('Audio recording not supported in this browser', { duration: 5000 });
      stopStream();
      setState('idle');
      return;
    }
    chunksRef.current = [];
    cancelledRef.current = false;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = async () => {
      clearTimeout(autoStopTimerRef.current);
      stopStream();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      chunksRef.current = [];
      if (cancelledRef.current) { setState('idle'); return; }
      if (blob.size < 1000) {
        toast.error('No audio captured', { duration: 3000 });
        setState('idle');
        return;
      }
      setState('transcribing');
      try {
        const text = (await transcribeAudio(blob, langValue)).trim();
        if (text) onTextRef.current(text);
      } catch (err) {
        const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
        const msg = axiosErr.response?.status === 503
          ? 'Server transcription not configured'
          : axiosErr.response?.data?.error || 'Transcription failed';
        log('[Voice] transcription error:', err);
        toast.error(msg, { duration: 5000 });
      } finally {
        setState('idle');
      }
    };
    recorderRef.current = recorder;
    recorder.start(1000); // timeslice — данные сохраняются даже при резком обрыве
    setState('recording');
    autoStopTimerRef.current = window.setTimeout(() => {
      if (recorderRef.current?.state === 'recording') {
        toast.error('Recording stopped after 2 minutes', { duration: 4000 });
        recorderRef.current.stop();
      }
    }, MAX_RECORDING_MS);
    log('[Voice] MediaRecorder started, mime:', recorder.mimeType);
  }, [langValue, stopStream]);

  const startWebSpeech = useCallback((SR: typeof SpeechRecognition, stream: MediaStream) => {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = langValue;
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const text = e.results[e.results.length - 1][0].transcript;
      onTextRef.current(text);
    };
    rec.onerror = (e) => {
      log('[Voice] SpeechRecognition error:', e.error);
      recognitionRef.current = null;
      if (e.error === 'network' || e.error === 'service-not-allowed') {
        // Браузерный сервис распознавания недоступен — переключаемся на
        // серверную транскрипцию на уже удерживаемом потоке (без второго
        // запроса разрешения) и запоминаем для следующих сессий.
        localStorage.setItem(WEBSPEECH_BROKEN_KEY, '1');
        toast('Speech service unreachable — switching to server transcription', { duration: 5000 });
        startRecorder(stream);
        return;
      }
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        toast.error(`Voice recognition error: ${e.error}`, { duration: 5000 });
      }
      stopStream();
      setState('idle');
    };
    rec.onend = () => {
      // onerror→startRecorder уже перевёл нас в recording — не сбрасывать
      if (recognitionRef.current !== rec) return;
      recognitionRef.current = null;
      stopStream();
      setState('idle');
    };
    recognitionRef.current = rec;
    rec.start();
    setState('listening');
    log('[Voice] Web Speech started, lang:', rec.lang);
  }, [langValue, startRecorder, stopStream]);

  const toggle = useCallback(async () => {
    if (state === 'transcribing') return;
    if (state === 'listening') {
      recognitionRef.current?.stop();
      return;
    }
    if (state === 'recording') {
      recorderRef.current?.stop();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
    } catch (err) {
      const name = err instanceof Error ? err.name : String(err);
      toast.error(`Microphone access failed (${name}). Check site permissions in browser settings.`, { duration: 5000 });
      return;
    }

    const SR = window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition: typeof SpeechRecognition }).webkitSpeechRecognition;
    const webSpeechBroken = !!localStorage.getItem(WEBSPEECH_BROKEN_KEY);
    if (SR && !webSpeechBroken) {
      startWebSpeech(SR, stream);
    } else {
      startRecorder(stream);
    }
  }, [state, startWebSpeech, startRecorder]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimeout(autoStopTimerRef.current);
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      rec.stop();
    }
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop(); // onstop увидит cancelledRef и выбросит запись
    } else {
      chunksRef.current = [];
      setState('idle');
    }
    stopStream();
  }, [stopStream]);

  // Cleanup на unmount — иначе индикатор микрофона остаётся гореть
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => { cancelRef.current(); }, []);

  return {
    state,
    active: state === 'listening' || state === 'recording',
    toggle,
    cancel,
    usingFallback: state === 'recording' || state === 'transcribing',
  };
}
