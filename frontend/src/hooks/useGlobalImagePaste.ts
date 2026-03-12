import { useEffect } from 'react';
import { uploadFile } from '../api/files';
import { sendToActiveTerminal } from '../components/terminal/Terminal';
import toast from 'react-hot-toast';
import { log } from '../utils/logger';

/**
 * Global image paste interceptor.
 * Captures Ctrl+V with image data anywhere on the page.
 * Uploads image to ~/uploads/, sends path to active terminal or shows toast.
 */
export function useGlobalImagePaste() {
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
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

      const target = e.target as HTMLElement;

      // xterm's hidden textarea — ALWAYS intercept (terminal has no clipboard access)
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');

      if (!isXtermTextarea) {
        // Don't intercept if the target is a real text input that handles paste itself
        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          || target.isContentEditable
          || target.closest('.monaco-editor');
        if (isTextInput) {
          // If clipboard also has text, let the input handle it (text paste)
          let hasText = false;
          for (let i = 0; i < items.length; i++) {
            if (items[i].type === 'text/plain') { hasText = true; break; }
          }
          if (hasText) return;
          // Image-only paste in a real textarea (e.g. chat) — let component handle
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) {
        log('[ImagePaste] getAsFile() returned null');
        return;
      }

      const ext = imageItem.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const name = `clipboard_${Date.now()}.${ext}`;
      log('[ImagePaste] uploading', { name, type: imageItem.type, size: blob.size, isXterm: isXtermTextarea });

      try {
        const { data } = await uploadFile(blob, undefined, name);
        log('[ImagePaste] uploaded:', data.path);
        const sent = sendToActiveTerminal(data.path);
        if (sent) {
          toast.success('Image uploaded & sent to terminal');
        } else {
          try { await navigator.clipboard.writeText(data.path); } catch { /* noop */ }
          toast.success(`Image uploaded: ${data.path}`, { duration: 4000 });
        }
      } catch (err) {
        console.error('[ImagePaste] upload failed:', err);
        toast.error('Failed to upload image');
      }
    };

    document.addEventListener('paste', handler, true);
    return () => document.removeEventListener('paste', handler, true);
  }, []);
}
