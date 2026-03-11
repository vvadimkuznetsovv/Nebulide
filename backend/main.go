package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"nebulide/config"
	"nebulide/database"
	"nebulide/handlers"
	"nebulide/middleware"
	"nebulide/models"
	"nebulide/services"
)

func main() {
	cfg := config.Load()

	// Database
	database.Connect(cfg)
	database.Migrate()

	// Redis
	database.ConnectRedis(cfg)

	// Ensure workspace directories exist
	log.Printf("Workspace: %s", cfg.ClaudeWorkingDir)
	os.MkdirAll(cfg.ClaudeWorkingDir, 0755)
	log.Printf("Workspaces root: %s", cfg.WorkspacesRoot)
	os.MkdirAll(cfg.WorkspacesRoot, 0755)
	log.Printf("Shared dir: %s", cfg.SharedDir)
	os.MkdirAll(cfg.SharedDir, 0775)

	// Seed admin user
	seedAdminUser(cfg)

	// Services
	claudeService := services.NewClaudeService(cfg.ClaudeAllowedTools)
	terminalService := services.NewTerminalService()
	presenceService := services.NewPresenceService()

	// Telegram bot (optional — only starts if TELEGRAM_BOT_TOKEN is set)
	var telegramBot *services.TelegramBot
	if cfg.TelegramBotToken != "" {
		bot, err := services.NewTelegramBot(cfg, database.DB)
		if err != nil {
			log.Printf("Telegram bot init failed: %v", err)
		} else {
			telegramBot = bot
			go telegramBot.Start()
			log.Println("Telegram bot started")
		}
	}

	// Handlers
	lockout := services.NewLoginLockout(database.RDB)
	authHandler := handlers.NewAuthHandler(cfg, lockout)
	sessionsHandler := handlers.NewSessionsHandler(cfg)
	chatHandler := handlers.NewChatHandler(cfg, claudeService)
	terminalHandler := handlers.NewTerminalHandler(cfg, terminalService)
	filesHandler := handlers.NewFilesHandler(cfg)
	inviteHandler := handlers.NewInviteHandler(cfg, lockout)
	adminHandler := handlers.NewAdminHandler(cfg, terminalService, presenceService)
	workspaceSessionsHandler := handlers.NewWorkspaceSessionsHandler(cfg)
	claudeSessionsHandler := handlers.NewClaudeSessionsHandler(cfg)
	syncHandler := handlers.NewSyncHandler(cfg, presenceService)
	hookHandler := handlers.NewHookHandler(cfg)

	// Router
	r := gin.Default()
	r.Use(middleware.SecurityHeaders())
	r.Use(middleware.CORS(cfg))

	// Rate limiter for auth endpoints
	authLimiter := middleware.NewRateLimiter(10, 1*time.Minute)

	// Public routes
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	// Auth routes
	auth := r.Group("/api/auth")
	auth.Use(authLimiter.Middleware())
	{
		auth.POST("/login", authHandler.Login)
		auth.POST("/refresh", authHandler.Refresh)
		auth.POST("/register", inviteHandler.Register)
	}

	// Auth routes requiring partial token (pre-TOTP)
	authPartial := r.Group("/api/auth")
	authPartial.Use(middleware.PartialAuthAllowed(cfg.JWTSecret))
	{
		authPartial.POST("/totp-verify", authHandler.TOTPVerify)
	}

	// Protected routes
	protected := r.Group("/api")
	protected.Use(middleware.AuthRequired(cfg.JWTSecret))
	{
		// User
		protected.GET("/auth/me", authHandler.Me)
		protected.POST("/auth/logout", authHandler.Logout)
		protected.POST("/auth/totp-setup", authHandler.TOTPSetup)
		protected.POST("/auth/totp-confirm", authHandler.TOTPConfirm)
		protected.POST("/auth/change-password", authHandler.ChangePassword)
		protected.PUT("/auth/telegram-id", authHandler.UpdateTelegramID)
		protected.GET("/auth/theme", authHandler.GetTheme)
		protected.PUT("/auth/theme", authHandler.UpdateTheme)
		protected.GET("/auth/preferences", authHandler.GetPreferences)
		protected.PUT("/auth/preferences", authHandler.UpdatePreferences)

		// Sessions
		protected.GET("/sessions", sessionsHandler.List)
		protected.POST("/sessions", sessionsHandler.Create)
		protected.PUT("/sessions/:id", sessionsHandler.Update)
		protected.DELETE("/sessions/:id", sessionsHandler.Delete)
		protected.GET("/sessions/:id/messages", sessionsHandler.Messages)

		// Workspace sessions
		protected.GET("/workspace-sessions/latest", workspaceSessionsHandler.Latest)
		protected.GET("/workspace-sessions", workspaceSessionsHandler.List)
		protected.POST("/workspace-sessions", workspaceSessionsHandler.Create)
		protected.PUT("/workspace-sessions/:id", workspaceSessionsHandler.Update)
		protected.DELETE("/workspace-sessions/:id", workspaceSessionsHandler.Delete)

		// Admin routes (admin check inside each handler)
		admin := protected.Group("/admin")
		admin.POST("/invites", inviteHandler.CreateInvite)
		admin.GET("/invites", inviteHandler.ListInvites)
		admin.DELETE("/invites/:id", inviteHandler.DeleteInvite)
		admin.GET("/users", adminHandler.ListUsers)
		admin.GET("/users/:id", adminHandler.GetUser)
		admin.DELETE("/users/:id", adminHandler.DeleteUser)
		admin.GET("/users/:id/terminals", adminHandler.ListTerminals)
		admin.DELETE("/users/:id/terminals/:instanceId", adminHandler.KillTerminal)
		admin.GET("/users/:id/sessions", adminHandler.ListUserSessions)
		admin.DELETE("/users/:id/sessions/:sessionId", adminHandler.DeleteUserSession)
		admin.GET("/users/:id/workspace/stats", adminHandler.WorkspaceStats)
		admin.DELETE("/users/:id/workspace", adminHandler.DeleteWorkspace)
		admin.GET("/stats", adminHandler.Stats)
		admin.GET("/monitoring", adminHandler.Monitoring)

		// Files
		protected.GET("/files", filesHandler.List)
		protected.GET("/files/read", filesHandler.Read)
		protected.GET("/files/raw", filesHandler.ReadRaw)
		protected.PUT("/files/write", filesHandler.Write)
		protected.DELETE("/files", filesHandler.Delete)
		protected.POST("/files/mkdir", filesHandler.Mkdir)
		protected.POST("/files/rename", filesHandler.Rename)
		protected.POST("/files/copy", filesHandler.Copy)
		protected.POST("/files/upload", filesHandler.Upload)
		protected.GET("/files/download", filesHandler.Download)
		protected.GET("/files/search", filesHandler.SearchFiles)
		protected.POST("/files/extract", filesHandler.Extract)

		// Terminal management (user kills own sessions)
		protected.DELETE("/terminals/:instanceId", terminalHandler.KillTerminal)

		// Claude CLI sessions & plans
		protected.GET("/claude-sessions", claudeSessionsHandler.List)
		protected.GET("/claude-sessions/search", claudeSessionsHandler.SearchSessions)
		protected.GET("/claude-sessions/:project/:sessionFile", claudeSessionsHandler.ReadSession)
		protected.DELETE("/claude-sessions/:project/:sessionFile", claudeSessionsHandler.DeleteSession)
		protected.GET("/claude-plans", claudeSessionsHandler.ListPlans)
		protected.GET("/claude-plans/:slug", claudeSessionsHandler.ReadPlan)
	}

	// Telegram route (own auth — accepts both regular JWT and scoped tg-send tokens)
	if telegramBot != nil {
		telegramHandler := handlers.NewTelegramHandler(cfg, telegramBot)
		r.POST("/api/telegram/send", telegramHandler.Send)
	}

	// Claude Code hooks (own auth — scoped claude-hook tokens)
	r.POST("/api/hooks/claude", hookHandler.HandleClaudeHook)

	// WebSocket routes (auth via query param)
	r.GET("/ws/chat/:id", chatHandler.HandleWebSocket)
	r.GET("/ws/terminal", terminalHandler.HandleWebSocket)
	r.GET("/ws/sync", syncHandler.HandleWebSocket)

	// Code-server reverse proxy (auth via ?token= query param or cookie)
	codeGroup := r.Group("/code")
	codeGroup.Use(handlers.CodeServerAuthMiddleware(cfg.JWTSecret))
	codeGroup.Any("/*path", handlers.CodeServerProxy())

	// Serve frontend static files
	r.Static("/assets", "./static/assets")
	r.Static("/sprites", "./static/sprites")
	r.StaticFile("/favicon.svg", "./static/favicon.svg")

	// SPA index.html — no-cache so browsers always get fresh asset references after deploy
	serveIndex := func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.File("./static/index.html")
	}
	r.GET("/", serveIndex)
	r.NoRoute(serveIndex)

	fmt.Printf("Server starting on :%s\n", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func seedAdminUser(cfg *config.Config) {
	if cfg.AdminPassword == "" {
		return
	}

	var count int64
	database.DB.Model(&models.User{}).Count(&count)
	if count > 0 {
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(cfg.AdminPassword), bcrypt.DefaultCost)
	if err != nil {
		log.Printf("Failed to hash admin password: %v", err)
		return
	}

	user := models.User{
		Username:     cfg.AdminUsername,
		PasswordHash: string(hash),
		IsAdmin:      true,
	}

	if err := database.DB.Create(&user).Error; err != nil {
		log.Printf("Failed to create admin user: %v", err)
		return
	}

	fmt.Printf("Admin user '%s' created\n", cfg.AdminUsername)
}
