import { useEffect } from 'react';
import { uploadFile } from '../api/files';
import { sendToActiveTerminal } from '../components/terminal/Terminal';
import toast from 'react-hot-toast';

/**
 * Global image paste interceptor.
 * Captures Ctrl+V with image data anywhere on the page.
 * If a terminal is connected, sends the uploaded file path to it.
 * Otherwise shows a toast with the path.
 */
export function useGlobalImagePaste() {
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      // Skip if already handled (e.g. by Terminal.tsx capture handler)
      if (e.defaultPrevented) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      // Check if clipboard contains an image
      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          imageItem = items[i];
          break;
        }
      }
      if (!imageItem) return;

      // Don't intercept if the target is a text input that handles paste itself
      const target = e.target as HTMLElement;
      const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable
        || target.closest('.monaco-editor');
      if (isTextInput) {
        // Chat textarea handles image paste itself (uploads + inserts path)
        // Other text inputs: skip if clipboard also has text
        let hasText = false;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type === 'text/plain') { hasText = true; break; }
        }
        if (hasText) return;
        // Image-only paste in a textarea (e.g. chat) — let the component handle it
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      const ext = imageItem.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const name = `clipboard_${Date.now()}.${ext}`;

      try {
        const { data } = await uploadFile(blob, undefined, name);
        const sent = sendToActiveTerminal(data.path);
        if (sent) {
          toast.success('Image uploaded & sent to terminal');
        } else {
          // Copy path to clipboard for convenience
          try { await navigator.clipboard.writeText(data.path); } catch { /* noop */ }
          toast.success(`Image uploaded: ${data.path}`, { duration: 4000 });
        }
      } catch {
        toast.error('Failed to upload image');
      }
    };

    document.addEventListener('paste', handler, true);
    return () => document.removeEventListener('paste', handler, true);
  }, []);
}
