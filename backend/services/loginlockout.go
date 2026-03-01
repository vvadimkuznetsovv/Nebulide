package services

import (
	"context"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	lockoutKeyPrefix = "lockout:"
	lockoutTTL       = 25 * time.Hour // auto-cleanup
	failThreshold    = 3
	maxLockoutMinutes = 24 * 60 // 24h cap
)

type LoginLockout struct {
	rdb *redis.Client
}

func NewLoginLockout(rdb *redis.Client) *LoginLockout {
	return &LoginLockout{rdb: rdb}
}

// lockoutDuration returns the lockout duration based on cumulative fail count.
// Tier 1 (3 fails):  15 min
// Tier 2 (6 fails):  30 min
// Tier 3 (9 fails):  60 min
// Tier 4 (12 fails): 120 min
// ... doubles each tier, capped at 24h.
func lockoutDuration(failCount int) time.Duration {
	tier := failCount / failThreshold
	if tier <= 0 {
		return 0
	}
	minutes := 15 * (1 << (tier - 1))
	if minutes > maxLockoutMinutes {
		minutes = maxLockoutMinutes
	}
	return time.Duration(minutes) * time.Minute
}

// IsLocked checks if a username is currently locked out.
// Returns (locked, remaining seconds until unlock).
func (lo *LoginLockout) IsLocked(ctx context.Context, username string) (bool, int) {
	key := lockoutKeyPrefix + username
	lockedUntil, err := lo.rdb.HGet(ctx, key, "locked_until").Result()
	if err != nil {
		return false, 0
	}

	ts, err := strconv.ParseInt(lockedUntil, 10, 64)
	if err != nil {
		return false, 0
	}

	until := time.Unix(ts, 0)
	if time.Now().After(until) {
		return false, 0
	}

	remaining := int(time.Until(until).Seconds())
	return true, remaining
}

// RecordFailure increments the fail count and applies lockout if threshold reached.
func (lo *LoginLockout) RecordFailure(ctx context.Context, username string) {
	key := lockoutKeyPrefix + username

	newCount, err := lo.rdb.HIncrBy(ctx, key, "fail_count", 1).Result()
	if err != nil {
		log.Printf("[Lockout] Redis HIncrBy failed for %s: %v", username, err)
		return
	}
	if err := lo.rdb.Expire(ctx, key, lockoutTTL).Err(); err != nil {
		log.Printf("[Lockout] Redis Expire failed for %s: %v", username, err)
	}

	if newCount >= failThreshold && newCount%failThreshold == 0 {
		dur := lockoutDuration(int(newCount))
		lockedUntil := time.Now().Add(dur).Unix()
		if err := lo.rdb.HSet(ctx, key, "locked_until", strconv.FormatInt(lockedUntil, 10)).Err(); err != nil {
			log.Printf("[Lockout] Redis HSet locked_until failed for %s: %v", username, err)
		}
	}
}

// RecordSuccess resets the fail count for a username.
func (lo *LoginLockout) RecordSuccess(ctx context.Context, username string) {
	if err := lo.rdb.Del(ctx, lockoutKeyPrefix+username).Err(); err != nil {
		log.Printf("[Lockout] Redis Del failed for %s: %v", username, err)
	}
}
