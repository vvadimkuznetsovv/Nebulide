package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"nebulide/utils"
)

func AuthRequired(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			// Also check query param for WebSocket connections
			token := c.Query("token")
			if token != "" {
				authHeader = "Bearer " + token
			}
		}

		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization required"})
			c.Abort()
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := utils.ParseToken(jwtSecret, tokenString)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid token"})
			c.Abort()
			return
		}

		if claims.Partial {
			c.JSON(http.StatusForbidden, gin.H{"error": "TOTP verification required"})
			c.Abort()
			return
		}

		// Reject scoped tokens (e.g. tg-send) from accessing regular API endpoints
		if claims.Purpose != "" {
			c.JSON(http.StatusForbidden, gin.H{"error": "Scoped token cannot access this endpoint"})
			c.Abort()
			return
		}

		c.Set("user_id", claims.UserID)
		c.Set("username", claims.Username)
		c.Next()
	}
}

// PartialAuthAllowed allows partial tokens (pre-TOTP verification)
func PartialAuthAllowed(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization required"})
			c.Abort()
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := utils.ParseToken(jwtSecret, tokenString)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid token"})
			c.Abort()
			return
		}

		c.Set("user_id", claims.UserID)
		c.Set("username", claims.Username)
		c.Set("partial", claims.Partial)
		c.Next()
	}
}
