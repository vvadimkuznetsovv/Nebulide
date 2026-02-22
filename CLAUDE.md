# Clauder — Web IDE for Claude Code

Self-hosted web interface wrapping Claude Code CLI. Go backend + React frontend, deployed via Docker on VPS.

## Tech Stack

- **Backend:** Go 1.24 / Gin / GORM / PostgreSQL 16 / gorilla/websocket / go-pty
- **Frontend:** React 19 / TypeScript 5.9 / Vite 7 / Zustand / TailwindCSS 4 / Monaco Editor / xterm.js / react-resizable-panels
- **Deploy:** Docker Compose (Alpine 3.20), GitHub Actions CI/CD

## Project Structure

```
backend/
  main.go              # Entry point, routes, admin seed, workspace MkdirAll
  config/config.go     # Env-based config, OS-aware defaults (runtime.GOOS)
  database/            # PostgreSQL connection + GORM migrations
  models/              # User, ChatSession, Message, RefreshToken
  handlers/
    auth.go            # Login, TOTP, change password, refresh tokens
    chat.go            # WebSocket — streams Claude CLI subprocess
    sessions.go        # CRUD chat sessions
    files.go           # File browser (list/read/readRaw/write/delete/mkdir/rename), safePath sandbox
    terminal.go        # WebSocket PTY terminal
  middleware/          # JWT auth, CORS, rate limiting
  services/
    claude.go          # Spawns `claude -p` with --output-format stream-json
    terminal.go        # Cross-platform PTY session manager (go-pty: Unix PTY + Windows ConPTY)
    totp.go            # TOTP generation/validation
  utils/jwt.go         # Token helpers

frontend/src/
  pages/               # Landing, Login, Workspace
  api/
    client.ts          # Axios instance, JWT interceptor, 401 refresh
    auth.ts            # login, refresh, me, changePassword, totp
    sessions.ts        # CRUD sessions
    files.ts           # listFiles, readFile, readFileRaw, writeFile, deleteFile, mkdirFile, renameFile, getRawFileUrl
  store/
    authStore.ts       # User, tokens, login/logout
    workspaceStore.ts  # Sessions, editor tabs, file tree, preview. isPreviewableFile() helper
    layoutStore.ts     # Panel visibility toggles (chat, editor, terminal, preview)
  components/
    layout/            # Sidebar (with Settings panel), LayoutRenderer, PanelContent, DnD panels
    chat/              # ChatPanel, MessageList, MessageBubble, ChatInput
    editor/
      CodeEditor.tsx   # Monaco editor wrapper
      EditorPanel.tsx  # Tabs, file tree sidebar (resizable), path breadcrumb, CodeEditor
    files/
      FileTree.tsx     # Expandable tree: lazy-load children, expand/collapse folders, recursive render, context menu, inline create/rename
      FileTreeItem.tsx # Single file/folder row: depth indentation, chevron (expand/collapse), icon/color by extension, inline rename
      ContextMenu.tsx  # Reusable portal-based context menu (items, separators, danger, icons, disabled, keyboard nav, overflow scroll)
    terminal/          # Terminal (xterm.js + WebSocket PTY)
    preview/
      PreviewPanel.tsx # Tab bar for documents, URL bar, PDF iframe, DOCX viewer
      DocxViewer.tsx   # mammoth.js: fetches ArrayBuffer → convertToHtml → rendered HTML
  types/
    mammoth.d.ts       # Type declarations for mammoth (no @types available)
  hooks/               # useAuth, useChat, useWebSocket
```

## Key Patterns

- **Auth flow:** Login → (optional TOTP verify) → JWT access token (15min) + refresh token (7d)
- **Settings panel:** In sidebar — change password + 2FA setup/status
- **Claude integration:** Backend spawns `claude` CLI, streams NDJSON via WebSocket to frontend
- **Layout system:** Recursive tree of PanelNodes/GroupNodes. Base 5 panel types (`BasePanelId`: chat, files, editor, preview, terminal) + dynamic detached editors (`PanelId = BasePanelId | 'editor:${string}'`). DnD with @dnd-kit, resizable via react-resizable-panels. `PanelContent` uses `getPanelIcon()`/`getPanelTitle()` functions (not static Records) to support dynamic panel IDs. `DroppablePanel` handles close button differently for detached editors (reattach vs hide). DnD state: `draggedPanelId` for panels, `draggedEditorTabId` for FM tab drags
- **File sandbox:** `safePath()` ensures all file ops stay within `ClaudeWorkingDir`. `Read` endpoint: 5MB limit, returns JSON string. `ReadRaw` endpoint: 50MB limit, serves binary with proper Content-Type
- **Terminal:** Cross-platform PTY via `aymanbagabas/go-pty` (Unix PTY + Windows ConPTY). Backend: `defaultShell()` resolves absolute path via `exec.LookPath` (MUST be absolute — go-pty resolves relative to `cmd.Dir` on Windows). `TerminalSession` struct holds `Pty gopty.Pty` (implements `io.ReadWriteCloser` + `Resize(width, height)`), `Cmd *gopty.Cmd`, `Done chan`. Frontend: module-level singleton `TermSession` (xterm + WebSocket + FitAddon) survives React component remounts — `LayoutRenderer` unmounts hidden panels (`return null`), so without singleton every tab switch would kill the terminal. `getOrCreateSession()` creates once, component just attaches/detaches xterm DOM node via `el.appendChild(xtermEl)`. WebSocket binary for I/O, JSON messages for resize. ResizeObserver auto-fits terminal on panel resize
- **Cross-OS:** `config.go` auto-detects Windows/Linux via `runtime.GOOS`; `files.go` falls back to `ClaudeWorkingDir` when session path doesn't exist on current OS. `.env` must NOT set `CLAUDE_WORKING_DIR` for auto-detect to work
- **File tree:** Expandable tree with lazy-loaded children. Click folder = expand/collapse (not navigate). State: `expandedFolders` (Set), `childrenCache` (Map), `loadingFolders` (Set). Chevron icon rotates 90° on expand, spinner during load. Depth indentation: `paddingLeft: 12 + depth * 16`. "Open as Workspace" context menu item = old navigate behavior (resets tree, loads folder as new root). ".." button hidden at rootPath, resets tree on go-up. `refreshFolder()` helper updates cache after create/delete/rename. Rename/delete correctly update expanded/cache keys for nested folders
- **File operations:** Context menu (right-click desktop, long-press 500ms mobile) supports: New File, New Folder, Rename (inline input), Open in New Tab, Open as Workspace (folders only), Delete. Folder context menu has "New File Inside"/"New Folder Inside" (create inside) + "New File"/"New Folder" (create in parent dir, actions `new-file-parent`/`new-folder-parent`). Works on files, directories, and empty space. Creating inside a folder auto-expands it and shows input at correct depth
- **File tree selection:** `selectedPath` state in FileTree, `isSelected`/`isContextTarget` props on FileTreeItem. CSS `.file-tree-item` class with `.selected` (persistent glow) and `.context-target` (while context menu open) — both use `glassShimmer` animation matching close button style. Hover: bright purple border+shadow. Touch: `longPressedRef` guard prevents click after long-press, `e.stopPropagation()` in `handleTouchStart` (prevents container long-press timer) and `handleTouchEnd`
- **Path display:** Uses `split(/[/\\]/)` for cross-OS filename extraction. Long paths show end via `scrollLeft = scrollWidth`, horizontally scrollable, hidden scrollbar
- **Preview:** PDF via iframe (`/api/files/raw` with `Content-Type: application/pdf`), DOCX via mammoth.js (~250KB gzipped, lazy-loaded by Vite, converts ArrayBuffer → HTML client-side). `.doc` (old OLE2) NOT supported — only `.docx` (OOXML). Own tab system (`PreviewTab` in workspaceStore), separate from editor tabs. `isPreviewableFile()` checks `.pdf`/`.docx` — routes clicks from EditorPanel. Auto-shows preview panel when hidden. mammoth.js has no @types — custom declaration in `src/types/mammoth.d.ts`
- **UI design:** "Liquid Glass" — dark purple (#030108) bg, animated lava lamp SVG blobs, frosted glass panels, accent #7F00FF
- **Tab close buttons:** Active tab shows close (X) button always; inactive tabs have close button with class `.panel-tab-close-compact` (hidden by default via `display: none`). Close buttons are Liquid Glass styled: purple-tinted background, `backdrop-filter: blur(10px)`, `glassShimmer` animation (purple↔white border/glow cycle, 3s). Sizes: panel tabs 20×20 (24 on touch), editor tabs 22×22 (26 on touch). SVG icon 12×12. Middle-click close only works on active editor tab. CSS classes: `.panel-tab-close`, `.panel-tab-close-compact`, `.tab-close-btn`. Animation stops on hover (replaced with brighter static glow)
- **Compact panel tabs:** When panel width < 100px, CSS container query (`@container (max-width: 100px)`) hides icon + title, shows only close buttons on all tabs. `.droppable-panel` has `container-type: inline-size`. Applies to both multi-tab (`TabBar`/`DraggableTab`) and single-tab (`DragHeader`). Allows users to close panels even when extremely narrow
- **CodeEditor save:** Monaco `editor.addAction()` adds "Save File" to built-in context menu with Ctrl+S keybinding. Uses `handleSaveRef` (useRef) pattern to avoid stale closures — `handleSave` declared above `handleSaveRef`, `run: () => handleSaveRef.current()`. IMPORTANT: `handleSave` MUST be declared before `handleSaveRef` to avoid TDZ with Vite HMR
- **CodeEditor tab cache:** `tabStatesRef` (Map<tabId, TabState>) caches content/originalContent/viewState between tab switches. CRITICAL: `openFile` in workspaceStore reuses same `tabId` when replacing unmodified tab's filePath — must invalidate cache when `previousTabIdRef === tabId` (same tab, different file), otherwise stale content displayed. `saveCurrentTabState()` saves before switch, cache checked on load
- **Detached editors:** Users can drag editor tabs out of File Manager (or right-click → "Open in Separate Panel") to create standalone code editor panels in the layout. `PanelId` format: `editor:${tabId}`. State: `workspaceStore.detachedEditors` (Record<tabId, {filePath, modified}>). Layout actions in `layoutStore`: `detachEditorTab` (context menu, places right of FM), `detachEditorTabToSplit/ToEdge/ToMerge` (DnD drop handlers). `reattachEditor(panelId)` returns file to FM tabs. Close (X) on detached panel = reattach. `toggleVisibility` for detached editors = reattach + remove from tree. EditorTabButton uses `useDraggable({ id: 'editor-tab:${tabId}' })` with `attributes` excluded (see overflow gotcha). Workspace.tsx `handleDragEnd` parses `editor-tab:*` prefix to route to detach actions. `layoutUtils.ts` helpers: `isDetachedEditor()`, `getDetachedTabId()`, `makeDetachedPanelId()`, `insertPanelAtNode/AtEdge/IntoNode` (insert without remove). localStorage key bumped to `clauder-layout-v6`
- **Editor tabs:** Show only filename, full path in breadcrumb bar above editor and in tooltip. EditorPanel uses `ensureEditorVisible()` + `useGroupRef` to restore 50/50 layout when editor is collapsed and user clicks a file/tab
- **Resizable file tree sidebar:** EditorPanel uses nested `react-resizable-panels` (`Group`/`Panel`/`Separator`) for file tree + code editor split. File tree panel: `collapsible={true}`, `collapsedSize="0px"`, `minSize` 120px desktop / 80px mobile — dragging below minSize auto-collapses. Code editor panel: also `collapsible`, `minSize` 20% desktop / 30% mobile — dragging file tree past ~70-80% collapses editor to fullscreen file manager. `usePanelRef` for imperative `collapse()`/`expand()`, `useGroupRef` for `setLayout()`. Toggle button syncs with `fileTreeVisible` in workspaceStore via `onResize` callback. Mobile detection: `useSyncExternalStore` + `matchMedia('(max-width: 640px)')`

## API Routes

**Public:** `POST /api/auth/login`, `POST /api/auth/refresh`, `GET /api/health`
**Partial auth:** `POST /api/auth/totp-verify`
**Protected auth:** `/api/auth/me`, `/api/auth/logout`, `/api/auth/totp-setup`, `/api/auth/totp-confirm`, `/api/auth/change-password`
**Sessions:** `GET|POST /api/sessions`, `PUT|DELETE /api/sessions/:id`, `GET /api/sessions/:id/messages`
**Files:** `GET /api/files` (list), `GET /api/files/read` (text), `GET /api/files/raw` (binary), `PUT /api/files/write`, `DELETE /api/files`, `POST /api/files/mkdir`, `POST /api/files/rename`
**WebSocket:** `GET /ws/chat/:id?token=`, `GET /ws/terminal?token=`
- Auth middleware supports `?token=` query param — used by WebSocket and iframe endpoints (PDF preview)

## Development

```bash
# Frontend (dev server with proxy to backend)
cd frontend && npm install && npm run dev   # localhost:5173

# Backend
cd backend && go run .                      # localhost:8080

# Vite proxies /api → :8080, /ws → ws://:8080
```

## Build & Deploy

```bash
# Type check
cd frontend && npx tsc --noEmit
cd backend && go build ./...

# Production build
cd frontend && npm run build    # → frontend/dist/
cd backend && go build -o clauder .

# Docker
docker compose up --build
```

## Environment Variables

See `.env`. Key vars: `DB_*`, `JWT_SECRET`, `CLAUDE_ALLOWED_TOOLS`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`
- `CLAUDE_WORKING_DIR` — auto-detected per OS. Do NOT set in `.env` unless overriding (breaks cross-OS)

## Conventions

- User communication in Russian
- Glass-morphism UI: use CSS variables (--glass-border, --text-primary, --accent, --text-muted, --glass-hover, --text-secondary, --text-tertiary)
- Inline SVG icons (Feather-style), no icon library
- Backend handlers receive `*config.Config`, use `database.DB` global
- Frontend state via Zustand stores, API via typed axios wrappers
- Context menus: `.context-menu`, `.context-menu-item`, `.context-menu-item.danger` CSS classes
- Path handling: always use `split(/[/\\]/)` for cross-OS compatibility, `replace(/\\/g, '/')` for display
- FileTreeItem has `FILE_ICONS` / `FILE_COLORS` maps for extensions — add new file types there
- All backend changes require `go build ./...` check; frontend requires `npx tsc --noEmit`
- `writeFileRequest.Content` has no `binding:"required"` — empty files are valid

## Gotchas

- **TDZ with Vite HMR:** `const` + `useCallback`/`useRef` can trigger TDZ during HMR even if runtime order seems fine. Always declare `useCallback` BEFORE any `useRef` that references it. Symptom: `Cannot access 'X' before initialization` only on HMR reload
- **Tab reuse cache:** `openFile` replaces unmodified tab's `filePath` keeping same `tabId` — any cache keyed by `tabId` returns stale data. Check if filePath changed for same tabId before using cache
- **Monaco stale closures:** `addAction` callbacks capture closure at mount. Use `useRef` pattern (`ref.current = handler`) to always call latest version
- **Mobile touch + click conflict:** Long-press (touchstart → setTimeout → action) + touchend triggers onClick. Guard with `longPressedRef`: set true in timer, check+reset in onClick, `e.stopPropagation()` in touchend when long-pressed
- **Mobile touch event bubbling:** `touchstart` bubbles from child to parent. If both have long-press timers (e.g., FileTreeItem + FileTree container), both fire — parent's `target: null` overwrites child's `target: file`. Fix: `e.stopPropagation()` in child's `handleTouchStart`
- **Cross-OS path comparison:** Backend returns paths with OS-native separators (`\` on Windows). Frontend `split(/[/\\]/).join('/')` normalizes to `/`. Comparing normalized path with raw backend path fails (`C:/foo` !== `C:\foo`). Fix: `refreshFolder()` uses `norm()` helper (`p.replace(/\\/g, '/')`) before comparing `folderPath` with `currentPath`
- **go-pty shell path on Windows:** `go-pty` resolves the executable path relative to `cmd.Dir` (working directory), not `PATH`. Passing just `"powershell.exe"` with `cmd.Dir = "C:\some\project"` makes it look for `C:\some\project\powershell.exe`. MUST use `exec.LookPath()` to resolve the absolute path first
- **Panel unmount kills state:** `LayoutRenderer` returns `null` for hidden panels → full unmount. Any component with persistent connections (WebSocket, PTY) must use a module-level singleton pattern to survive remounts, not useEffect cleanup
- **@dnd-kit useDraggable + overflow:auto:** `useDraggable` applies CSS `transform` to the original element during drag. If the element is inside a container with `overflow: auto/hidden/scroll`, the transform is clipped and the drag appears stuck. Fix: DON'T spread `{...attributes}` from `useDraggable` on the element — `attributes` contains the transform style. Use only `listeners` + `setNodeRef` + `isDragging`. The `DragOverlay` component (rendered in Workspace.tsx via portal) provides the visual ghost. This is why `EditorTabButton` explicitly excludes `attributes` while `DragHeader`/`DraggableTab` in DroppablePanel.tsx can use `attributes` safely (their parent has no overflow clipping)
