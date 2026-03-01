package handlers

import (
	"net/http"
	"net/url"
)

// checkWSOrigin validates the Origin header against allowed origins.
// If no Origin header is present (non-browser client), the connection is allowed.
func checkWSOrigin(allowedOrigins []string) func(r *http.Request) bool {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		if u, err := url.Parse(o); err == nil {
			allowed[u.Host] = true
		}
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser clients
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return allowed[u.Host]
	}
}
