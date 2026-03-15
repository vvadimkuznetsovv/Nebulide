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

async function handleImageUpload(file: File, targetInstanceId: string | null) {
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const name = `clipboard_${Date.now()}.${ext}`;
  log('[ImagePaste] uploading', { name, type: file.type, size: file.size, targetInstanceId });

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
 * For xterm terminals: SYNCHRONOUSLY blocks the event before async clipboard check.
 * This prevents xterm from handling Ctrl+V (which sends raw keystroke to PTY).
 * If no image found, manually pastes clipboard text into terminal.
 */
export function useGlobalImagePaste() {
  useEffect(() => {
    // Layer 1: keydown capture — catches Ctrl+V before xterm's keydown handler.
    // CRITICAL: for xterm targets, must preventDefault SYNCHRONOUSLY before any await,
    // otherwise xterm's bubble-phase handler fires first and sends keystroke to PTY.
    const keydownHandler = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key === 'v')) return;

      const target = e.target as HTMLElement;
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');
      const targetTag = target.tagName + (target.className ? '.' + target.className.split(' ')[0] : '');

      if (e.defaultPrevented) {
        log('[ImagePaste] keydown: SKIP — defaultPrevented=true, target=', targetTag);
        return;
      }

      if (!isXtermTextarea) {
        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          || target.isContentEditable
          || target.closest('.monaco-editor');
        if (isTextInput) {
          log('[ImagePaste] keydown: SKIP — text input target=', targetTag);
          return;
        }
      }

      log('[ImagePaste] keydown: Ctrl+V intercepted, target=', targetTag, 'isXterm=', isXtermTextarea);

      // For xterm: SYNCHRONOUSLY block event propagation to prevent xterm from
      // handling Ctrl+V. We'll check clipboard async and either upload image
      // or manually paste text into terminal.
      if (isXtermTextarea) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        log('[ImagePaste] keydown: xterm event BLOCKED synchronously');
      }

      // Capture target terminal NOW, before async work
      const targetInstanceId = getLastFocusedInstanceId();
      log('[ImagePaste] keydown: targetInstanceId=', targetInstanceId);

      // Async clipboard check + upload
      (async () => {
        const imageFile = await getClipboardImage();
        if (imageFile) {
          log('[ImagePaste] keydown: image found, size=', imageFile.size, 'type=', imageFile.type, 'target=', targetInstanceId);
          await handleImageUpload(imageFile, targetInstanceId);
          return;
        }

        log('[ImagePaste] keydown: no image in clipboard');

        // For xterm: we blocked the event, so xterm didn't paste text.
        // Manually read clipboard text and send to terminal.
        if (isXtermTextarea) {
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              log('[ImagePaste] keydown: pasting text to terminal, len=', text.length);
              const sent = targetInstanceId
                ? sendToTerminal(targetInstanceId, text) || sendToActiveTerminal(text)
                : sendToActiveTerminal(text);
              if (!sent) log('[ImagePaste] keydown: FAILED to send clipboard text to terminal');
            } else {
              log('[ImagePaste] keydown: clipboard text is empty');
            }
          } catch (err) {
            log('[ImagePaste] keydown: clipboard.readText() FAILED:', err);
          }
        }
      })();
    };

    // Layer 2: paste event capture — fallback for non-keyboard pastes (context menu, etc.)
    const pasteHandler = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;

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

      // Synchronously get blob before preventing default
      const blob = imageItem.getAsFile();
      if (!blob) {
        log('[ImagePaste] paste: getAsFile() returned null');
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const targetInstanceId = getLastFocusedInstanceId();
      handleImageUpload(blob, targetInstanceId);
    };

    document.addEventListener('keydown', keydownHandler, true);
    document.addEventListener('paste', pasteHandler, true);
    return () => {
      document.removeEventListener('keydown', keydownHandler, true);
      document.removeEventListener('paste', pasteHandler, true);
    };
  }, []);
}
