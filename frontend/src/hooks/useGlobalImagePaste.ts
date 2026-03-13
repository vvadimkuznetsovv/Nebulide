import { useEffect } from 'react';
import { uploadFile } from '../api/files';
import { sendToTerminal, sendToActiveTerminal, getLastFocusedInstanceId } from '../components/terminal/Terminal';
import toast from 'react-hot-toast';
import { log } from '../utils/logger';

/**
 * Check clipboard for image via Clipboard API (async).
 * Returns the first image blob found, or null.
 */
async function getClipboardImage(): Promise<File | null> {
  try {
    const clipItems = await navigator.clipboard.read();
    for (const item of clipItems) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          return new File([blob], 'clipboard.png', { type });
        }
      }
    }
  } catch (err) {
    log('[ImagePaste] clipboard.read() failed:', err);
  }
  return null;
}

async function handleImageUpload(file: File, isXterm: boolean, targetInstanceId: string | null) {
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const name = `clipboard_${Date.now()}.${ext}`;
  log('[ImagePaste] uploading', { name, type: file.type, size: file.size, isXterm, targetInstanceId });

  const toastId = toast.loading('Uploading image...');

  try {
    const { data } = await uploadFile(file, undefined, name);
    log('[ImagePaste] uploaded:', data.path);
    // Send to the terminal that was focused at paste time
    const sent = targetInstanceId
      ? sendToTerminal(targetInstanceId, data.path) || sendToActiveTerminal(data.path)
      : sendToActiveTerminal(data.path);
    if (sent) {
      toast.success('Image uploaded & sent to terminal', { id: toastId });
    } else {
      try { await navigator.clipboard.writeText(data.path); } catch { /* noop */ }
      toast.success(`Image uploaded: ${data.path}`, { id: toastId, duration: 4000 });
    }
  } catch (err) {
    console.error('[ImagePaste] upload failed:', err);
    toast.error('Failed to upload image', { id: toastId });
  }
}

/**
 * Global image paste interceptor.
 * Captures Ctrl+V with image data anywhere on the page.
 * Uploads image to ~/uploads/, sends path to active terminal or shows toast.
 *
 * Two-layer approach:
 * 1. keydown (capture) — intercepts Ctrl+V BEFORE xterm processes it,
 *    checks clipboard for image via async Clipboard API.
 * 2. paste (capture) — fallback for non-keyboard pastes (context menu, etc.)
 */
export function useGlobalImagePaste() {
  useEffect(() => {
    // Flag to prevent double-handling (keydown already handled → skip paste event)
    let keydownHandled = false;

    // Layer 1: keydown capture — catches Ctrl+V before xterm's keydown handler
    const keydownHandler = async (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!((e.ctrlKey || e.metaKey) && e.key === 'v')) return;

      keydownHandled = false;

      const target = e.target as HTMLElement;
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');

      if (!isXtermTextarea) {
        // Don't intercept real text inputs
        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          || target.isContentEditable
          || target.closest('.monaco-editor');
        if (isTextInput) return;
      }

      // Check clipboard for image via async API
      const imageFile = await getClipboardImage();
      if (!imageFile) {
        log('[ImagePaste] keydown: no image in clipboard');
        return;
      }

      // We have an image — prevent default paste behavior
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      keydownHandled = true;

      // Capture target terminal NOW, before async upload
      const targetInstanceId = getLastFocusedInstanceId();
      log('[ImagePaste] keydown: intercepted Ctrl+V with image, target=', targetInstanceId);
      await handleImageUpload(imageFile, isXtermTextarea, targetInstanceId);
    };

    // Layer 2: paste event capture — fallback for non-keyboard pastes
    const pasteHandler = async (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      if (keydownHandled) {
        keydownHandled = false;
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          imageItem = items[i];
          break;
        }
      }
      if (!imageItem) return;

      const target = e.target as HTMLElement;
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');

      if (!isXtermTextarea) {
        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          || target.isContentEditable
          || target.closest('.monaco-editor');
        if (isTextInput) {
          let hasText = false;
          for (let i = 0; i < items.length; i++) {
            if (items[i].type === 'text/plain') { hasText = true; break; }
          }
          if (hasText) return;
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) {
        log('[ImagePaste] paste: getAsFile() returned null');
        return;
      }

      const targetInstanceId = getLastFocusedInstanceId();
      await handleImageUpload(blob, isXtermTextarea, targetInstanceId);
    };

    document.addEventListener('keydown', keydownHandler, true);
    document.addEventListener('paste', pasteHandler, true);
    return () => {
      document.removeEventListener('keydown', keydownHandler, true);
      document.removeEventListener('paste', pasteHandler, true);
    };
  }, []);
}
