import { useState, useRef, useEffect, useCallback } from 'react';
import { uploadFile } from '../../api/files';
import toast from 'react-hot-toast';

interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export default function ChatInput({ onSend, onCancel, isStreaming, disabled }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [message]);

  const handleSubmit = () => {
    const trimmed = message.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setMessage('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Paste image → upload → insert path into textarea
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    let imageItem: DataTransferItem | null = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageItem = items[i];
        break;
      }
    }
    if (!imageItem) return; // no image — let default text paste work

    e.preventDefault();
    e.stopPropagation();

    const blob = imageItem.getAsFile();
    if (!blob) return;

    const ext = imageItem.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const name = `clipboard_${Date.now()}.${ext}`;

    setUploading(true);
    try {
      const { data } = await uploadFile(blob, undefined, name);
      // Insert path at cursor position
      const ta = textareaRef.current;
      const pathText = data.path;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = message.slice(0, start);
        const after = message.slice(end);
        const newMsg = before + pathText + after;
        setMessage(newMsg);
        // Restore cursor after the inserted path
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + pathText.length;
        });
      } else {
        setMessage((prev) => prev + pathText);
      }
      toast.success('Image uploaded');
    } catch {
      toast.error('Failed to upload image');
    } finally {
      setUploading(false);
    }
  }, [message]);

  return (
    <div
      className="p-3"
      style={{
        background: 'rgba(0, 0, 0, 0.15)',
        borderTop: '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Send a message..."
          rows={1}
          className="glass-input flex-1 resize-none px-4 py-3 rounded-xl text-sm outline-none"
          style={{ maxHeight: '200px' }}
          disabled={disabled || uploading}
        />
        {isStreaming ? (
          <button
            onClick={onCancel}
            className="btn-danger px-4 py-3 rounded-xl text-sm font-medium"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!message.trim() || disabled || uploading}
            className="btn-accent px-4 py-3 rounded-xl text-sm font-medium"
          >
            {uploading ? '...' : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
}
