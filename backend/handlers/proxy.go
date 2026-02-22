package handlers

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"clauder/utils"
)

// CodeServerAuthMiddleware authenticates requests for the /code/* proxy.
// On the first request (with ?token= query param) it issues a long-lived
// HttpOnly cookie so that code-server's internal requests (which don't
// carry the JWT query param) can also be authenticated.
func CodeServerAuthMiddleware(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var tokenString string
		var setCookie bool

		// 1. Authorization header
		if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			tokenString = strings.TrimPrefix(auth, "Bearer ")
		}

		// 2. ?token= query param (initial iframe / probe request)
		if tokenString == "" {
			if t := c.Query("token"); t != "" {
				tokenString = t
				setCookie = true
			}
		}

		// 3. HttpOnly cookie — used by code-server's internal requests
		if tokenString == "" {
			if cookie, err := c.Cookie("clauder-code-auth"); err == nil {
				tokenString = cookie
			}
		}

		if tokenString == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization required"})
			c.Abort()
			return
		}

		claims, err := utils.ParseToken(jwtSecret, tokenString)
		if err != nil || claims.Partial {
			// Clear stale cookie
			c.SetCookie("clauder-code-auth", "", -1, "/code", "", false, true)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid token"})
			c.Abort()
			return
		}

		// First valid ?token= request → set a long-lived cookie (7 days) so that
		// subsequent code-server internal requests (without ?token=) pass auth.
		if setCookie {
			longLived, err := utils.GenerateAccessToken(jwtSecret, claims.UserID, claims.Username, false, 7*24*time.Hour)
			if err == nil {
				c.SetCookie("clauder-code-auth", longLived, 7*24*60*60, "/code", "", false, true)
			}
		}

		c.Set("user_id", claims.UserID)
		c.Set("username", claims.Username)
		c.Next()
	}
}

// CodeServerProxy returns a Gin handler that reverse-proxies to code-server.
// Auth is handled by CodeServerAuthMiddleware on the route group.
func CodeServerProxy() gin.HandlerFunc {
	target, _ := url.Parse("http://code-server:8443")

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host

			// Strip /code prefix — code-server expects root paths
			req.URL.Path = strings.TrimPrefix(req.URL.Path, "/code")
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}

			// Remove the token query param so it doesn't leak to code-server
			q := req.URL.Query()
			q.Del("token")
			req.URL.RawQuery = q.Encode()
		},
	}

	return func(c *gin.Context) {
		proxy.ServeHTTP(c.Writer, c.Request)
	}
}
