import { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useLongPress } from '../../hooks/useLongPress';

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming?: boolean;
  onContextMenu?: (x: number, y: number) => void;
}

export default function MessageBubble({ role, content, isStreaming, onContextMenu }: MessageBubbleProps) {
  const isUser = role === 'user';
  const displayContent = role === 'assistant' ? parseAssistantContent(content) : content;

  const { handlers: longPressHandlers } = useLongPress({
    onLongPress: (x, y) => onContextMenu?.(x, y),
  });

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu?.(e.clientX, e.clientY);
  }, [onContextMenu]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser ? 'rounded-br-md' : 'rounded-bl-md'
        }`}
        style={
          isUser
            ? {
                background: 'linear-gradient(135deg, rgba(110, 180, 255, 0.3), rgba(110, 180, 255, 0.15))',
                border: '1px solid rgba(110, 180, 255, 0.3)',
                color: '#fff',
                WebkitBackdropFilter: 'blur(16px)',
                backdropFilter: 'blur(16px)',
              }
            : {
                background: 'var(--glass)',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                WebkitBackdropFilter: 'blur(16px)',
                backdropFilter: 'blur(16px)',
              }
        }
        onContextMenu={handleContextMenu}
        {...longPressHandlers}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{displayContent}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const inline = !match;
                  if (inline) {
                    return (
                      <code
                        className="px-1.5 py-0.5 rounded text-xs font-mono"
                        style={{
                          background: 'rgba(0, 0, 0, 0.4)',
                          border: '1px solid var(--glass-border)',
                        }}
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  }
                  return (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={match[1]}
                      PreTag="div"
                      className="rounded-xl !my-2 text-xs"
                      customStyle={{
                        background: 'rgba(0, 0, 0, 0.4)',
                        border: '1px solid var(--glass-border)',
                        borderRadius: '12px',
                      }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  );
                },
              }}
            >
              {displayContent}
            </ReactMarkdown>
            {isStreaming && (
              <span
                className="inline-block w-2 h-5 ml-1 cursor-blink rounded-sm"
                style={{ background: 'var(--accent)' }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function parseAssistantContent(raw: string): string {
  const lines = raw.split('\n').filter(Boolean);
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') textParts.push(block.text);
          if (block.type === 'tool_use') {
            textParts.push(`\n\`\`\`\nTool: ${block.name}\nInput: ${JSON.stringify(block.input, null, 2)}\n\`\`\`\n`);
          }
        }
      } else if (event.type === 'result') {
        if (event.result) textParts.push(event.result);
      }
    } catch {
      textParts.push(line);
    }
  }

  return textParts.join('') || raw;
}
