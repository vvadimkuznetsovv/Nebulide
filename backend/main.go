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

	// Ensure workspace directory exists
	log.Printf("Workspace: %s", cfg.ClaudeWorkingDir)
	os.MkdirAll(cfg.ClaudeWorkingDir, 0755)

	// Seed admin user
	seedAdminUser(cfg)

	// Services
	claudeService := services.NewClaudeService(cfg.ClaudeAllowedTools)
	terminalService := services.NewTerminalService()

	// Handlers
	lockout := services.NewLoginLockout(database.RDB)
	authHandler := handlers.NewAuthHandler(cfg, lockout)
	sessionsHandler := handlers.NewSessionsHandler(cfg)
	chatHandler := handlers.NewChatHandler(cfg, claudeService)
	terminalHandler := handlers.NewTerminalHandler(cfg, terminalService)
	filesHandler := handlers.NewFilesHandler(cfg)
	inviteHandler := handlers.NewInviteHandler(cfg, lockout)
	workspaceSessionsHandler := handlers.NewWorkspaceSessionsHandler(cfg)
	syncHandler := handlers.NewSyncHandler(cfg)

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

		// Invites (admin only — checked inside handler)
		protected.POST("/admin/invites", inviteHandler.CreateInvite)
		protected.GET("/admin/invites", inviteHandler.ListInvites)
		protected.DELETE("/admin/invites/:id", inviteHandler.DeleteInvite)

		// Files
		protected.GET("/files", filesHandler.List)
		protected.GET("/files/read", filesHandler.Read)
		protected.GET("/files/raw", filesHandler.ReadRaw)
		protected.PUT("/files/write", filesHandler.Write)
		protected.DELETE("/files", filesHandler.Delete)
		protected.POST("/files/mkdir", filesHandler.Mkdir)
		protected.POST("/files/rename", filesHandler.Rename)
	}

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
	r.StaticFile("/favicon.svg", "./static/favicon.svg")
	r.StaticFile("/", "./static/index.html")
	r.NoRoute(func(c *gin.Context) {
		c.File("./static/index.html")
	})

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
