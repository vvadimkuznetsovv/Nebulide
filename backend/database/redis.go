package database

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"nebulide/config"
)

var RDB *redis.Client

func ConnectRedis(cfg *config.Config) {
	RDB = redis.NewClient(&redis.Options{
		Addr:         cfg.RedisURL,
		DB:           0,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := RDB.Ping(ctx).Err(); err != nil {
		log.Fatalf("Failed to connect to Redis at %s: %v", cfg.RedisURL, err)
	}

	fmt.Println("Redis connected")
}
