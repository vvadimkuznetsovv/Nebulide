package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Port string

	DBHost     string
	DBPort     string
	DBUser     string
	DBPassword string
	DBName     string

	JWTSecret        string
	JWTExpiry        time.Duration
	JWTRefreshExpiry time.Duration

	ClaudeAllowedTools string
	ClaudeWorkingDir   string
	WorkspacesRoot     string
	SharedDir          string

	RedisURL       string
	AllowedOrigins []string

	AdminUsername string
	AdminPassword string

	TelegramBotToken string
	TelegramAPIURL   string

	NvidiaAPIKey string
}

func Load() *Config {
	godotenv.Load()
	godotenv.Load("../.env")

	return &Config{
		Port: getEnv("PORT", "8080"),

		DBHost:     getEnv("DB_HOST", "localhost"),
		DBPort:     getEnv("DB_PORT", "5432"),
		DBUser:     getEnv("DB_USER", "nebulide"),
		DBPassword: getEnv("DB_PASSWORD", "nebulide"),
		DBName:     getEnv("DB_NAME", "nebulide"),

		JWTSecret:        getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		JWTExpiry:        parseDuration(getEnv("JWT_EXPIRY", "24h")),
		JWTRefreshExpiry: parseDuration(getEnv("JWT_REFRESH_EXPIRY", "720h")),

		ClaudeAllowedTools: getEnv("CLAUDE_ALLOWED_TOOLS", "Read,Edit,Write,Bash,Glob,Grep"),
		ClaudeWorkingDir:   getEnv("CLAUDE_WORKING_DIR", defaultWorkingDir()),
		WorkspacesRoot:     getEnv("WORKSPACES_ROOT", defaultWorkspacesRoot()),
		SharedDir:          getEnv("SHARED_DIR", defaultSharedDir()),

		RedisURL:       getEnv("REDIS_URL", "localhost:6379"),
		AllowedOrigins: parseOrigins(getEnv("ALLOWED_ORIGINS", defaultOrigins())),

		AdminUsername: getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: getEnv("ADMIN_PASSWORD", ""),

		TelegramBotToken: getEnv("TELEGRAM_BOT_TOKEN", ""),
		TelegramAPIURL:   getEnv("TELEGRAM_API_URL", ""),

		NvidiaAPIKey: getEnv("NVIDIA_API_KEY", ""),
	}
}

func (c *Config) DSN() string {
	return "host=" + c.DBHost +
		" user=" + c.DBUser +
		" password=" + c.DBPassword +
		" dbname=" + c.DBName +
		" port=" + c.DBPort +
		" sslmode=disable TimeZone=UTC"
}

// findProjectRoot walks up from the executable and current dir
// looking for the directory that contains .env (project root marker).
func findProjectRoot() string {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates, exeDir, filepath.Join(exeDir, ".."))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd, filepath.Join(wd, ".."))
	}
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(c, ".env")); err == nil {
			return filepath.Clean(c)
		}
	}
	return ""
}

func defaultSharedDir() string {
	if runtime.GOOS == "windows" {
		if root := findProjectRoot(); root != "" {
			return filepath.Join(root, "shared")
		}
		return filepath.Join(os.Getenv("USERPROFILE"), "shared")
	}
	return "/home/nebulide/shared"
}

func defaultWorkspacesRoot() string {
	if runtime.GOOS == "windows" {
		if root := findProjectRoot(); root != "" {
			return filepath.Join(root, "workspaces")
		}
		return filepath.Join(os.Getenv("USERPROFILE"), "workspaces")
	}
	return "/home/nebulide/workspaces"
}

// GetUserWorkspaceDir returns the workspace directory for a given user.
// Sanitizes username to prevent path traversal (defense-in-depth).
func (c *Config) GetUserWorkspaceDir(username string) string {
	// filepath.Base strips directory components: "../../etc" → "etc", "/foo/bar" → "bar"
	safe := filepath.Base(username)
	if safe == "." || safe == ".." || safe == "" {
		safe = "_invalid_"
	}
	return filepath.Join(c.WorkspacesRoot, safe)
}

func defaultWorkingDir() string {
	if runtime.GOOS == "windows" {
		if root := findProjectRoot(); root != "" {
			return filepath.Join(root, "workspace")
		}
		return filepath.Join(os.Getenv("USERPROFILE"), "workspace")
	}
	return "/home/nebulide/workspace"
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func parseDuration(s string) time.Duration {
	// Support "d" suffix for days (Go's time.ParseDuration only handles up to "h")
	if strings.HasSuffix(s, "d") {
		numStr := strings.TrimSuffix(s, "d")
		if days, err := time.ParseDuration(numStr + "h"); err == nil {
			return days * 24
		}
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 15 * time.Minute
	}
	return d
}

func defaultOrigins() string {
	if os.Getenv("GIN_MODE") != "release" {
		return "https://nebulide.ru,https://mega.nebulide.ru,http://localhost:5173,http://localhost:5174,http://localhost:8080"
	}
	return "https://nebulide.ru,https://mega.nebulide.ru"
}

func parseOrigins(s string) []string {
	parts := strings.Split(s, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			origins = append(origins, p)
		}
	}
	return origins
}
