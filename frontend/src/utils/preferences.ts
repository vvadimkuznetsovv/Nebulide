import { getPreferences, updatePreferences } from '../api/auth';
import { useWorkspaceStore } from '../store/workspaceStore';

const SPLIT_KEY = 'nebulide-editor-split';

export function getEditorSplit(): string {
  try { return localStorage.getItem(SPLIT_KEY) || '20%'; }
  catch { return '20%'; }
}

export function setEditorSplit(value: string) {
  try { localStorage.setItem(SPLIT_KEY, value); } catch { /* ignore */ }
}

/** Collect current UI preferences from stores + localStorage.
 * Layout/visibility/mobilePanels are saved via workspace-sessions snapshot — not here. */
function collectPreferences(): Record<string, unknown> {
  const wsState = useWorkspaceStore.getState();
  return {
    editor_split: getEditorSplit(),
    file_tree_visible: wsState.fileTreeVisible,
  };
}

/** Apply server preferences to local stores.
 * Layout/visibility are handled by workspace-sessions — not here. */
function applyPreferences(prefs: Record<string, unknown>) {
  if (typeof prefs.editor_split === 'string') {
    setEditorSplit(prefs.editor_split);
  }
  if (typeof prefs.file_tree_visible === 'boolean') {
    useWorkspaceStore.getState().setFileTreeVisible(prefs.file_tree_visible);
  }
}

/** Load preferences from server and apply locally (call after auth restore) */
export async function syncPreferencesFromServer() {
  try {
    const { data } = await getPreferences();
    if (data && Object.keys(data).length > 0) {
      applyPreferences(data);
    }
  } catch {
    // Not authenticated or server error — use localStorage cache
  }
}

// --- Debounced save to server ---
let saveTimer: number | null = null;

export function savePreferencesToServer() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await updatePreferences(collectPreferences());
    } catch {
      // Offline — localStorage already updated
    }
  }, 2000);
}
