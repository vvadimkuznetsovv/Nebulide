import { useState, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import type { Message } from '../api/sessions';

interface StreamEvent {
  type: string;
  data?: unknown;
  session_id?: string;
  message?: string;
}

export function useChat(sessionId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const streamContentRef = useRef('');
  // Batch stream delta updates to avoid re-rendering on every WebSocket chunk
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback(() => {
    if (pendingDeltaRef.current) {
      setStreamContent(prev => prev + pendingDeltaRef.current);
      pendingDeltaRef.current = '';
    }
    flushTimerRef.current = null;
  }, []);

  const scheduleDelta = useCallback((text: string) => {
    pendingDeltaRef.current += text;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushPending, 50);
    }
  }, [flushPending]);

  const cancelFlush = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingDeltaRef.current = '';
  }, []);

  const handleMessage = useCallback((data: unknown) => {
    const event = data as StreamEvent;

    switch (event.type) {
      case 'stream': {
        setIsStreaming(true);
        // Accumulate streamed content
        const line = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        streamContentRef.current += line + '\n';
        // Extract text content from stream-json events
        try {
          const parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (parsed?.type === 'assistant' && parsed?.message?.content) {
            const textBlocks = parsed.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join('');
            // Full content block — cancel any pending delta, set directly
            cancelFlush();
            setStreamContent(textBlocks);
          } else if (parsed?.type === 'content_block_delta' && parsed?.delta?.text) {
            scheduleDelta(parsed.delta.text);
          }
        } catch {
          // Raw text fallback
          scheduleDelta(line);
        }
        break;
      }
      case 'complete': {
        cancelFlush();
        setIsStreaming(false);
        if (streamContentRef.current) {
          const assistantMsg: Message = {
            id: crypto.randomUUID(),
            session_id: sessionId || '',
            role: 'assistant',
            content: streamContentRef.current,
            tokens_used: 0,
            created_at: new Date().toISOString(),
          };
          setMessages(prev => [...prev, assistantMsg]);
        }
        setStreamContent('');
        streamContentRef.current = '';
        break;
      }
      case 'error': {
        cancelFlush();
        setIsStreaming(false);
        setStreamContent('');
        streamContentRef.current = '';
        console.error('Chat error:', event.message);
        break;
      }
    }
  }, [sessionId, scheduleDelta, cancelFlush]);

  const { isConnected, send, connect, disconnect } = useWebSocket({
    url: sessionId ? `/ws/chat/${sessionId}` : '',
    onMessage: handleMessage,
    autoConnect: !!sessionId,
  });

  const sendMessage = useCallback((content: string) => {
    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: sessionId || '',
      role: 'user',
      content,
      tokens_used: 0,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    send({ type: 'message', content });
  }, [sessionId, send]);

  const cancelMessage = useCallback(() => {
    send({ type: 'cancel' });
  }, [send]);

  return {
    messages,
    setMessages,
    isStreaming,
    streamContent,
    isConnected,
    sendMessage,
    cancelMessage,
    connect,
    disconnect,
  };
}
