package config

import (
	"os"
	"path/filepath"
	"runtime"
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

	AdminUsername string
	AdminPassword string
}

func Load() *Config {
	godotenv.Load()
	godotenv.Load("../.env")

	return &Config{
		Port: getEnv("PORT", "8080"),

		DBHost:     getEnv("DB_HOST", "localhost"),
		DBPort:     getEnv("DB_PORT", "5432"),
		DBUser:     getEnv("DB_USER", "clauder"),
		DBPassword: getEnv("DB_PASSWORD", "clauder"),
		DBName:     getEnv("DB_NAME", "clauder"),

		JWTSecret:        getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		JWTExpiry:        parseDuration(getEnv("JWT_EXPIRY", "15m")),
		JWTRefreshExpiry: parseDuration(getEnv("JWT_REFRESH_EXPIRY", "168h")),

		ClaudeAllowedTools: getEnv("CLAUDE_ALLOWED_TOOLS", "Read,Edit,Write,Bash,Glob,Grep"),
		ClaudeWorkingDir:   getEnv("CLAUDE_WORKING_DIR", defaultWorkingDir()),

		AdminUsername: getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: getEnv("ADMIN_PASSWORD", ""),
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

func defaultWorkingDir() string {
	if runtime.GOOS == "windows" {
		exe, err := os.Executable()
		if err != nil {
			return filepath.Join(os.Getenv("USERPROFILE"), "workspace")
		}
		return filepath.Join(filepath.Dir(exe), "..", "workspace")
	}
	return "/home/clauder/workspace"
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func parseDuration(s string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 15 * time.Minute
	}
	return d
}
