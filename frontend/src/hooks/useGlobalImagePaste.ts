import { useEffect } from 'react';
import { uploadFile } from '../api/files';
import { sendToTerminal, sendToActiveTerminal, getLastFocusedInstanceId, focusTerminal } from '../components/terminal/Terminal';
import toast from 'react-hot-toast';
import { log } from '../utils/logger';

/**
 * Check clipboard for image via Clipboard API (async).
 * Returns the first image blob found, or null.
 */
async function getClipboardImage(): Promise<File | null> {
  try {
    log('[ImagePaste] clipboard.read() calling...');
    const clipItems = await navigator.clipboard.read();
    log('[ImagePaste] clipboard.read() got', clipItems.length, 'items, types=', clipItems.map(i => i.types));
    for (const item of clipItems) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          log('[ImagePaste] clipboard.read() found image:', type, 'size=', blob.size);
          return new File([blob], 'clipboard.png', { type });
        }
      }
    }
    log('[ImagePaste] clipboard.read() no image types found');
  } catch (err) {
    log('[ImagePaste] clipboard.read() FAILED:', err);
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
      // Restore focus to terminal (clipboard API steals focus)
      if (targetInstanceId) focusTerminal(targetInstanceId);
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
 * Two layers:
 * - Layer 1 (keydown capture): SYNCHRONOUSLY blocks Ctrl+V for xterm targets
 *   (prevents Claude CLI from receiving keystroke and trying its own clipboard read).
 *   Then async checks clipboard for image. If no image → manually pastes text.
 *   Sets keydownHandled flag to prevent Layer 2 from double-processing.
 * - Layer 2 (paste capture): For non-keyboard pastes (context menu, toolbar).
 *   Skips if keydownHandled. clipboardData is synchronous — no race.
 */
export function useGlobalImagePaste() {
  useEffect(() => {
    log('[ImagePaste] useEffect MOUNTED — attaching listeners');

    // Flag to prevent double-handling (keydown already handled → skip paste event)
    let keydownHandled = false;

    // Layer 1: keydown capture — SYNCHRONOUS handler (not async!)
    // Must block xterm's Ctrl+V BEFORE any await, otherwise xterm sends
    // keystroke to PTY and Claude CLI tries its own clipboard read.
    const keydownHandler = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М' || e.code === 'KeyV'))) return;

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

      // For xterm: SYNCHRONOUSLY block event BEFORE any async work.
      // This prevents xterm from sending Ctrl+V to PTY (which would make
      // Claude CLI try its own clipboard read and show "No image found").
      if (isXtermTextarea) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        log('[ImagePaste] keydown: xterm event BLOCKED synchronously');
      }

      // Set flag SYNCHRONOUSLY to prevent Layer 2 (paste handler) from
      // also processing this paste event.
      keydownHandled = true;

      // Capture target terminal NOW, before async work
      const targetInstanceId = getLastFocusedInstanceId();
      log('[ImagePaste] keydown: targetInstanceId=', targetInstanceId);

      // Async clipboard check + upload (in IIFE, not making handler async)
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
              if (sent && targetInstanceId) focusTerminal(targetInstanceId);
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
    // clipboardData is synchronous here — no async race.
    const pasteHandler = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      const targetTag = target.tagName + (target.className ? '.' + target.className.split(' ')[0] : '');
      const itemTypes = Array.from(e.clipboardData?.items ?? []).map(i => i.type);
      log('[ImagePaste] paste event fired, target=', targetTag, 'defaultPrevented=', e.defaultPrevented, 'itemTypes=', itemTypes, 'keydownHandled=', keydownHandled);

      if (e.defaultPrevented) return;
      if (keydownHandled) {
        log('[ImagePaste] paste: SKIP — already handled by keydown');
        keydownHandled = false;
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) { log('[ImagePaste] paste: no clipboardData.items'); return; }

      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          imageItem = items[i];
          break;
        }
      }
      if (!imageItem) { log('[ImagePaste] paste: no image item in clipboardData'); return; }

      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');
      log('[ImagePaste] paste: image found, type=', imageItem.type, 'isXterm=', isXtermTextarea);

      if (!isXtermTextarea) {
        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          || target.isContentEditable
          || target.closest('.monaco-editor');
        if (isTextInput) {
          let hasText = false;
          for (let i = 0; i < items.length; i++) {
            if (items[i].type === 'text/plain') { hasText = true; break; }
          }
          if (hasText) { log('[ImagePaste] paste: SKIP — text input with text data'); return; }
          log('[ImagePaste] paste: SKIP — text input without text data');
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
      log('[ImagePaste] paste: event blocked, blob size=', blob.size);

      const targetInstanceId = getLastFocusedInstanceId();
      log('[ImagePaste] paste: targetInstanceId=', targetInstanceId);
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
