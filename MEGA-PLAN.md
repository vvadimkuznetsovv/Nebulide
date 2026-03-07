# MEGA Nebulide — Admin Panel & Multi-User Platform

## Context

Nebulide — self-hosted web IDE wrapping Claude Code CLI. Сейчас система однопользовательская: один admin аккаунт, одна общая папка `/home/nebulide/workspace`. Нужно превратить Nebulide в мультипользовательскую платформу с:
- **Admin-панелью** на поддомене `mega.nebulide.ru` (отдельное React-приложение)
- **Пользовательской изоляцией** — каждый пользователь получает свою папку, не имеет доступа к чужим файлам
- **Telegram-ботом** — взаимодействие с Claude, отправка файлов, SSH-уведомления
- **Мониторингом** — ресурсы, PTY, workspace каждого пользователя

**Разбивка: 2 фазы.**

---

## Architecture Overview

```
mega.nebulide.ru ──► nginx ──► /api/, /ws/ ──► Go backend (app:8080)
                               /           ──► admin static files (/var/www/mega/dist)

nebulide.ru ──────► nginx ──► /api/, /ws/ ──► Go backend (app:8080)
                               /           ──► main frontend (in Go binary)

Host filesystem:
/home/nebulide/
├── workspace/            ← Admin workspace (backward compat)
└── workspaces/           ← NEW: per-user workspaces
    ├── alice/
    ├── bob/
    └── ...
```

---

## Phase 1: Admin Panel + User Management + Workspace Isolation

### 1.1 Backend: Per-User Workspace Isolation

**Файлы:** `backend/config/config.go`, `backend/handlers/files.go`, `backend/handlers/terminal.go`, `backend/handlers/chat.go`, `backend/handlers/invites.go`, `backend/main.go`

- [ ] **config.go** — добавить `WorkspacesRoot` (default: `/home/nebulide/workspaces`, Windows: `<root>/workspaces`)
- [ ] **config.go** — добавить helper `GetUserWorkspaceDir(username string) string`:
  ```go
  func (c *Config) GetUserWorkspaceDir(username string) string {
      return filepath.Join(c.WorkspacesRoot, username)
  }
  ```
- [ ] **main.go** — создавать `cfg.WorkspacesRoot` при старте (`os.MkdirAll`)
- [ ] **invites.go (Register)** — после создания пользователя создавать workspace: `os.MkdirAll(cfg.GetUserWorkspaceDir(user.Username), 0755)`
- [ ] **files.go** — заменить `h.cfg.ClaudeWorkingDir` на per-user dir:
  - Вынести `getUserDir(c *gin.Context) string` — получает username из JWT context, вызывает `cfg.GetUserWorkspaceDir(username)`. Если admin → `cfg.ClaudeWorkingDir`
  - Обновить `safePath()` — принимать `base string` вместо использования `h.cfg.ClaudeWorkingDir`
  - Обновить `List`, `Read`, `ReadRaw`, `Write`, `Delete`, `Mkdir`, `Rename`, `SearchFiles` — использовать `getUserDir(c)`
- [ ] **terminal.go (HandleWebSocket)** — заменить `h.cfg.ClaudeWorkingDir` на `cfg.GetUserWorkspaceDir(username)` (username из JWT claims)
- [ ] **chat.go** — при спавне `claude -p` использовать per-user workspace как рабочую директорию
- [ ] **entrypoint.sh** — обновить для создания `/home/nebulide/workspaces` и копирования CLAUDE.md в новые workspace-ы

### 1.2 Backend: Admin Middleware & Handler

**Новый файл:** `backend/handlers/admin.go`
**Модифицируемые:** `backend/main.go`, `backend/services/terminal.go`

- [ ] **middleware (или inline check)** — `requireAdmin(c *gin.Context) bool`: проверяет `is_admin` из БД (не только JWT)
- [ ] **admin.go** — `AdminHandler` struct с `cfg`, `terminal *services.TerminalService`
- [ ] **GET /api/admin/users** — список всех пользователей:
  ```json
  [{ "id", "username", "is_admin", "created_at", "workspace_size_bytes", "active_pty_count" }]
  ```
  - Workspace size: `filepath.Walk` или кэшированный вызов
  - Active PTY count: через `terminal.ListUserSessions(userID)`
- [ ] **GET /api/admin/users/:id** — детали пользователя + stats
- [ ] **DELETE /api/admin/users/:id** — удалить аккаунт:
  - Удалить из БД (User, RefreshTokens, WorkspaceSessions, ChatSessions, Messages)
  - Убить все PTY сессии: `terminal.KillUserSessions(userID)`
  - Удалить workspace dir: `os.RemoveAll(cfg.GetUserWorkspaceDir(username))`
- [ ] **GET /api/admin/users/:id/terminals** — список PTY сессий пользователя:
  ```json
  [{ "session_key", "instance_id", "created_at", "alive" }]
  ```
- [ ] **DELETE /api/admin/users/:id/terminals/:instanceId** — убить конкретную PTY
- [ ] **GET /api/admin/users/:id/workspace/stats** — размер workspace, кол-во файлов
- [ ] **DELETE /api/admin/users/:id/workspace** — удалить содержимое workspace (сохранить пустую папку)
- [ ] **GET /api/admin/stats** — общая статистика:
  ```json
  { "total_users", "total_workspaces_size", "active_pty_count", "invites_pending" }
  ```

### 1.3 Backend: TerminalService Extension

**Файл:** `backend/services/terminal.go`

- [ ] **ListSessions()** `map[string]*SessionInfo` — вернуть все сессии с metadata
- [ ] **ListUserSessions(userID string)** `[]*SessionInfo` — фильтр по `term:{userID}:*`
- [ ] **KillSession(key string)** — закрыть PTY, удалить из map, broadcast EOF
- [ ] **KillUserSessions(userID string)** — убить все PTY пользователя
- [ ] **SessionInfo struct** — `{ Key, UserID, InstanceID, Alive bool, CreatedAt }`

### 1.4 Backend: Route Registration

**Файл:** `backend/main.go`

- [ ] Инициализировать `adminHandler := handlers.NewAdminHandler(cfg, terminalService)`
- [ ] Добавить admin route group:
  ```go
  admin := protected.Group("/admin")
  // Invites (уже есть — перенести сюда)
  admin.POST("/invites", inviteHandler.CreateInvite)
  admin.GET("/invites", inviteHandler.ListInvites)
  admin.DELETE("/invites/:id", inviteHandler.DeleteInvite)
  // Users
  admin.GET("/users", adminHandler.ListUsers)
  admin.GET("/users/:id", adminHandler.GetUser)
  admin.DELETE("/users/:id", adminHandler.DeleteUser)
  admin.GET("/users/:id/terminals", adminHandler.ListTerminals)
  admin.DELETE("/users/:id/terminals/:instanceId", adminHandler.KillTerminal)
  admin.GET("/users/:id/workspace/stats", adminHandler.WorkspaceStats)
  admin.DELETE("/users/:id/workspace", adminHandler.DeleteWorkspace)
  admin.GET("/stats", adminHandler.Stats)
  ```
- [ ] CORS: добавить `https://mega.nebulide.ru` в `AllowedOrigins`

### 1.5 Admin Frontend Application

**Новая директория:** `admin/`

- [ ] Инициализация проекта: React 19 + TypeScript + Vite + TailwindCSS
- [ ] Зависимости: `react-router-dom`, `zustand`, `axios`
- [ ] **vite.config.ts** — proxy `/api` и `/ws` к `localhost:8080`, port 5174
- [ ] **Общие стили** — CSS переменные, Liquid Glass, lava-lamp из `frontend/src/index.css`

#### Страницы:
- [ ] **Login.tsx** — glass card, проверка `is_admin` после логина, redirect если не admin
- [ ] **Dashboard.tsx** — карточки со статистикой (пользователи, размер, PTY, инвайты)
- [ ] **Users.tsx** — таблица пользователей: username, created_at, workspace size, PTY count, actions
- [ ] **UserDetail.tsx** — workspace stats, список PTY, кнопки управления
- [ ] **Invites.tsx** — создание кода, список с delete

#### Компоненты:
- [ ] **MegaLogo.tsx** — "MEGA" (neon purple shimmer) + "Nebulide" (white shimmer):
  ```css
  .mega-prefix {
    background: linear-gradient(120deg,
      rgba(127,0,255,0.6) 0%, rgba(166,77,255,1) 15%,
      rgba(127,0,255,0.5) 30%, rgba(200,130,255,1) 50%,
      rgba(127,0,255,0.4) 70%, rgba(166,77,255,0.9) 85%,
      rgba(127,0,255,0.6) 100%);
    background-size: 250% 100%;
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 12px rgba(127,0,255,0.6));
    animation: logoShine 8s ease-in-out infinite;
  }
  ```
- [ ] **StatsCard.tsx** — glassmorphism карточка
- [ ] **UserTable.tsx** — таблица с сортировкой, glass-стиль
- [ ] **Layout.tsx** — sidebar навигация (Dashboard, Users, Invites, Bot Settings)
- [ ] **ConfirmDialog.tsx** — glass dialog для опасных действий

#### API/Store:
- [ ] **api/client.ts** — axios instance, JWT interceptor (паттерн из frontend)
- [ ] **api/admin.ts** — admin API (users, invites, stats, terminals)
- [ ] **api/auth.ts** — login, refresh, me
- [ ] **store/authStore.ts** — auth state

### 1.6 nginx & Docker Configuration

**Файлы:** `nginx/conf.d/mega.conf` (новый), `docker-compose.yml`, `Dockerfile`

- [ ] **SSL сертификат** — Let's Encrypt для mega.nebulide.ru
- [ ] **nginx/conf.d/mega.conf** — server block для mega.nebulide.ru:
  - HTTPS redirect
  - `/api/` → proxy to `app:8080`
  - `/ws/` → WebSocket proxy to `app:8080`
  - `/` → admin SPA static files from `/var/www/mega/dist`
  - Security headers (STS, nosniff, DENY frame)
- [ ] **docker-compose.yml**:
  - nginx volume: `/var/www/mega/dist:/var/www/mega/dist:ro`
  - app volume: `/home/nebulide/workspaces:/home/nebulide/workspaces`
- [ ] **Dockerfile** — `RUN mkdir -p /home/nebulide/workspaces`

### 1.7 Security Hardening

- [ ] **Path traversal** — `safePath()` проверяет per-user base
- [ ] **Admin endpoints** — проверка `is_admin` из БД
- [ ] **Cascade delete** — удаление всех записей пользователя (sessions, messages, tokens)
- [ ] **PTY rate limiting** — max concurrent PTY per user (`MAX_PTY_PER_USER=3`)
- [ ] **CORS** — `mega.nebulide.ru` в AllowedOrigins

---

## Phase 2: Telegram Bot + SSH Notifications

### 2.1 Database Models

**Новый файл:** `backend/models/telegram.go`

- [ ] **TelegramLink** — связь User ↔ Telegram (UserID, TelegramID, ChatID, Username)
- [ ] **BotPermission** — права пользователя (CanAskClaude, CanSendFiles)
- [ ] Добавить в `database/migrations.go`

### 2.2 Telegram Bot Service

**Новый файл:** `backend/services/bot.go`

- [ ] Go library: `github.com/go-telegram-bot-api/telegram-bot-api/v5`
- [ ] Config: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` в `.env`
- [ ] **BotService** struct с long-polling, запуск в goroutine из main.go

#### Commands:
- [ ] `/start` — приветствие
- [ ] `/link CODE` — привязка Telegram к Nebulide аккаунту
- [ ] `/ask ВОПРОС` — Claude запрос (проверка `can_ask_claude`), стрим в Telegram
- [ ] `/files` — список файлов в workspace
- [ ] `/file ПУТЬ` — скачать файл из workspace
- [ ] File upload → сохранить в workspace (проверка `can_send_files`)
- [ ] `/help`, `/status`

#### Admin commands (chat_id = ADMIN_CHAT_ID):
- [ ] `/users`, `/kick USERNAME`, `/stats`

### 2.3 Claude Integration via Bot

- [ ] Reuse `ClaudeService.SpawnClaude()` с user workspace dir
- [ ] Stream → Telegram message editing (batched 1 edit/sec)
- [ ] Max 4096 chars → split messages
- [ ] Timeout 120s
- [ ] System prompt: "Пользователь через Telegram бота"

### 2.4 SSH Login Notifications

**Новый файл:** `scripts/ssh-notify.sh`

- [ ] Скрипт: curl → Telegram Bot API → admin chat
- [ ] Message: "🔐 SSH Login: user@host from IP at TIME"
- [ ] Hook: `/etc/ssh/sshrc` или PAM
- [ ] Docker: COPY скрипт + env vars

### 2.5 Backend: Bot Management API

- [ ] **POST /api/admin/bot/link-code/:userId** — генерация кода привязки
- [ ] **GET /api/admin/bot/permissions** — список permissions
- [ ] **PUT /api/admin/bot/permissions/:userId** — toggle permissions
- [ ] **GET /api/admin/bot/status** — статус бота

### 2.6 Admin Frontend: Bot Management UI

- [ ] **BotSettings.tsx** — статус бота, таблица permissions, link code generation

---

## Environment Variables (new)

```env
# Phase 1
WORKSPACES_ROOT=/home/nebulide/workspaces

# Phase 2
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_ADMIN_CHAT_ID=289626498
```

---

## Verification

### Phase 1:
```bash
cd backend && go build ./...
cd admin && npm install && npx tsc --noEmit && npm run build
```
- [ ] Логин admin в mega.nebulide.ru → dashboard
- [ ] Создание invite → код копируется
- [ ] Регистрация пользователя → workspace dir создан
- [ ] Пользователь видит только свои файлы
- [ ] Терминал пользователя → working dir = его workspace
- [ ] Admin видит список пользователей с stats
- [ ] Admin может убить PTY
- [ ] Admin может удалить workspace
- [ ] Admin может удалить пользователя
- [ ] Path traversal невозможен

### Phase 2:
```bash
cd backend && go build ./...
```
- [ ] Бот запускается с backend
- [ ] /start → приветствие
- [ ] /link CODE → привязка
- [ ] /ask → ответ Claude
- [ ] File upload → в workspace
- [ ] SSH login → Telegram уведомление
- [ ] Bot Settings → toggle permissions
