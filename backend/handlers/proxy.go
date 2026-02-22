package handlers

import (
	"bufio"
	"fmt"
	"io"
	"net"
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

// headRecorder captures status + headers for HEAD→GET conversion, discarding the body.
type headRecorder struct {
	header http.Header
	status int
}

func (r *headRecorder) Header() http.Header         { return r.header }
func (r *headRecorder) Write(b []byte) (int, error) { return len(b), nil } // discard body
func (r *headRecorder) WriteHeader(status int)      { r.status = status }

// CodeServerProxy returns a Gin handler that reverse-proxies to code-server.
// Auth is handled by CodeServerAuthMiddleware on the route group.
//
// WebSocket connections are handled via raw TCP hijacking (proxyWebSocket) because
// httputil.ReverseProxy calls rw.WriteHeader(101) AFTER Hijack(), but Gin's
// ResponseWriter blocks WriteHeader once Written()=true (set inside Hijack).
// This prevents the 101 Switching Protocols response from reaching the client,
// causing WebSocket 1006 errors in code-server's extension host.
//
// Regular HTTP requests go through httputil.ReverseProxy.
// HEAD requests are converted to GET internally (code-server returns 405 on HEAD).
func CodeServerProxy() gin.HandlerFunc {
	const targetHost = "code-server:8443"
	target, _ := url.Parse("http://" + targetHost)

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			// Do NOT override req.Host — keep the original "clauder.smartrs.tech"
			// so that code-server's Origin/Host check passes (auth: none still
			// validates Host vs Origin to prevent DNS rebinding attacks).

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
		if c.Request.Method == http.MethodHead {
			// Convert HEAD → GET for the upstream request so code-server handles it,
			// then return only the response headers (no body) to the original caller.
			c.Request.Method = http.MethodGet
			rec := &headRecorder{header: make(http.Header), status: http.StatusOK}
			proxy.ServeHTTP(rec, c.Request)
			for k, v := range rec.header {
				for _, vv := range v {
					c.Writer.Header().Add(k, vv)
				}
			}
			c.Writer.WriteHeader(rec.status)
			return
		}

		// WebSocket upgrade: bypass httputil.ReverseProxy — see proxyWebSocket.
		if strings.EqualFold(c.Request.Header.Get("Upgrade"), "websocket") {
			path := strings.TrimPrefix(c.Request.URL.Path, "/code")
			if path == "" {
				path = "/"
			}
			q := c.Request.URL.Query()
			q.Del("token")
			proxyWebSocket(c, targetHost, path, q.Encode())
			return
		}

		proxy.ServeHTTP(c.Writer, c.Request)
	}
}

// proxyWebSocket tunnels a WebSocket connection to code-server via raw TCP.
//
// Root cause of the 1006 bug:
//   httputil.ReverseProxy.handleUpgradeResponse calls hj.Hijack() then rw.WriteHeader(101).
//   Gin's Hijack() sets responseWriter.size=0 → Written()=true.
//   Gin's WriteHeader then returns early (prints a debug warning, does nothing).
//   The underlying http.ResponseWriter.WriteHeader(101) is never called.
//   brw.Flush() flushes an empty buffer. The client never receives 101.
//   The browser WebSocket sees the connection close without an upgrade response → 1006.
//
// Fix: hijack both sides manually, forward the handshake, then copy frames bidirectionally.
func proxyWebSocket(c *gin.Context, targetHost, path, rawQuery string) {
	// Hijack the client TCP connection from Gin
	hj, ok := c.Writer.(http.Hijacker)
	if !ok {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	clientConn, clientBuf, err := hj.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()

	// Dial code-server directly
	backendConn, err := net.DialTimeout("tcp", targetHost, 10*time.Second)
	if err != nil {
		fmt.Fprintf(clientBuf, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
		clientBuf.Flush() //nolint:errcheck
		return
	}
	defer backendConn.Close()

	// Rewrite and forward the WebSocket upgrade request to code-server.
	// Keep the original Host header (clauder.smartrs.tech) so that code-server's
	// DNS-rebinding check (Host vs Origin match) passes even with auth: none.
	req := c.Request.Clone(c.Request.Context())
	req.URL = &url.URL{Path: path, RawQuery: rawQuery}
	if err := req.Write(backendConn); err != nil {
		return
	}

	// Read code-server's response (expected: 101 Switching Protocols)
	backendReader := bufio.NewReader(backendConn)
	resp, err := http.ReadResponse(backendReader, req)
	if err != nil {
		return
	}
	resp.Body.Close()

	// Write the response to the client through the hijacked connection
	fmt.Fprintf(clientBuf, "HTTP/1.1 %s\r\n", resp.Status)
	resp.Header.Write(clientBuf) //nolint:errcheck
	fmt.Fprintf(clientBuf, "\r\n")
	if err := clientBuf.Flush(); err != nil {
		return
	}

	// Bidirectional copy: WebSocket frames flow both ways until one side closes
	errc := make(chan error, 2)
	go func() { _, err := io.Copy(backendConn, clientBuf); errc <- err }()
	go func() { _, err := io.Copy(clientConn, backendReader); errc <- err }()
	<-errc
}
