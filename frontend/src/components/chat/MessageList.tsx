import { useEffect, useRef, useState, useCallback } from 'react';
import MessageBubble, { parseAssistantContent } from './MessageBubble';
import ContextMenu, { type ContextMenuItem } from '../files/ContextMenu';
import type { Message } from '../../api/sessions';
import toast from 'react-hot-toast';

interface MessageListProps {
  messages: Message[];
  streamContent: string;
  isStreaming: boolean;
}

// Feather-style SVG icons (14×14)
const ICONS = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  fileText: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /><path d="M10 9H8" />
    </svg>
  ),
};

export default function MessageList({ messages, streamContent, isStreaming }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; message: Message } | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamContent]);

  const handleBubbleContext = useCallback((msg: Message) => (x: number, y: number) => {
    setCtxMenu({ x, y, message: msg });
  }, []);

  const handleCtxAction = useCallback((action: string) => {
    if (!ctxMenu) return;
    const { message } = ctxMenu;
    setCtxMenu(null);

    switch (action) {
      case 'copy': {
        const text = message.role === 'assistant'
          ? parseAssistantContent(message.content)
          : message.content;
        navigator.clipboard.writeText(text)
          .then(() => toast.success('Copied'))
          .catch(() => toast.error('Failed to copy'));
        break;
      }
      case 'copy-md': {
        const raw = message.role === 'assistant'
          ? parseAssistantContent(message.content)
          : message.content;
        navigator.clipboard.writeText(raw)
          .then(() => toast.success('Copied as Markdown'))
          .catch(() => toast.error('Failed to copy'));
        break;
      }
    }
  }, [ctxMenu]);

  const getMenuItems = (msg: Message): ContextMenuItem[] => {
    if (msg.role === 'assistant') {
      return [
        { label: 'Copy', action: 'copy', icon: ICONS.copy },
        { label: 'Copy as Markdown', action: 'copy-md', icon: ICONS.fileText },
      ];
    }
    return [
      { label: 'Copy', action: 'copy', icon: ICONS.copy },
    ];
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.length === 0 && !isStreaming && (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <div
            className="text-6xl mb-6 glow-pulse"
            style={{
              background: 'linear-gradient(135deg, var(--accent), #a78bfa)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              filter: 'drop-shadow(0 0 20px var(--accent-glow))',
            }}
          >
            {'>'}_
          </div>
          <h2
            className="text-xl font-semibold mb-2"
            style={{ color: 'var(--text-primary)' }}
          >
            Claude Code
          </h2>
          <p
            className="text-sm max-w-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            Start a conversation. Claude can read and edit files, run commands, and help you code.
          </p>
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          role={msg.role}
          content={msg.content}
          onContextMenu={handleBubbleContext(msg)}
        />
      ))}

      {isStreaming && streamContent && (
        <MessageBubble role="assistant" content={streamContent} isStreaming />
      )}

      <div ref={bottomRef} />

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={getMenuItems(ctxMenu.message)}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
