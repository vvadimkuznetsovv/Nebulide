import { getPreferences, updatePreferences } from '../api/auth';
import { useLayoutStore } from '../store/layoutStore';
import { useWorkspaceStore } from '../store/workspaceStore';

const SPLIT_KEY = 'nebulide-editor-split';
const LAYOUT_KEY = 'nebulide-layout-v6';

export function getEditorSplit(): string {
  try { return localStorage.getItem(SPLIT_KEY) || '20%'; }
  catch { return '20%'; }
}

export function setEditorSplit(value: string) {
  try { localStorage.setItem(SPLIT_KEY, value); } catch { /* ignore */ }
}

/** Collect current UI preferences from stores + localStorage */
function collectPreferences(): Record<string, unknown> {
  const layoutState = useLayoutStore.getState();
  const wsState = useWorkspaceStore.getState();
  return {
    editor_split: getEditorSplit(),
    file_tree_visible: wsState.fileTreeVisible,
    layout: layoutState.layout,
    visibility: layoutState.visibility,
    mobile_panels: layoutState.mobilePanels,
  };
}

/** Apply server preferences to local stores */
function applyPreferences(prefs: Record<string, unknown>) {
  // Editor split
  if (typeof prefs.editor_split === 'string') {
    setEditorSplit(prefs.editor_split);
  }

  // File tree visibility
  if (typeof prefs.file_tree_visible === 'boolean') {
    useWorkspaceStore.getState().setFileTreeVisible(prefs.file_tree_visible);
  }

  // Layout (save to localStorage — layoutStore reads from it on init)
  if (prefs.layout && prefs.visibility) {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        layout: prefs.layout,
        visibility: prefs.visibility,
        mobilePanels: prefs.mobile_panels || ['chat'],
      }));
    } catch { /* ignore */ }
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
