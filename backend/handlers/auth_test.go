package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"nebulide/middleware"
	"nebulide/models"
	"nebulide/services"
	"nebulide/testutil"
	"nebulide/utils"
)

func setupAuthTestRouter() (*gin.Engine, *testutil.TestContext) {
	db := testutil.SetupTestDB()
	cfg := testutil.TestConfig()
	handler := NewAuthHandler(cfg, services.NewLoginLockout(nil))

	gin.SetMode(gin.TestMode)
	r := gin.New()

	// Public auth routes
	auth := r.Group("/api/auth")
	{
		auth.POST("/login", handler.Login)
		auth.POST("/refresh", handler.Refresh)
	}

	// Partial auth routes
	authPartial := r.Group("/api/auth")
	authPartial.Use(middleware.PartialAuthAllowed(cfg.JWTSecret))
	{
		authPartial.POST("/totp-verify", handler.TOTPVerify)
	}

	// Protected auth routes
	protected := r.Group("/api/auth")
	protected.Use(middleware.AuthRequired(cfg.JWTSecret))
	{
		protected.GET("/me", handler.Me)
		protected.POST("/logout", handler.Logout)
	}

	return r, &testutil.TestContext{DB: db, Cfg: cfg}
}

func TestLogin_ValidCredentials(t *testing.T) {
	router, tc := setupAuthTestRouter()
	user := testutil.CreateTestUser(tc.DB)

	body, _ := json.Marshal(map[string]string{
		"username": testutil.TestUsername,
		"password": testutil.TestPassword,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	require.NoError(t, err)

	assert.NotEmpty(t, resp["access_token"], "Should return an access token")
	assert.NotEmpty(t, resp["refresh_token"], "Should return a refresh token")

	// Verify user info is returned
	userResp, ok := resp["user"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, user.ID.String(), userResp["id"])
	assert.Equal(t, testutil.TestUsername, userResp["username"])
}

func TestLogin_InvalidPassword(t *testing.T) {
	router, tc := setupAuthTestRouter()
	testutil.CreateTestUser(tc.DB)

	body, _ := json.Marshal(map[string]string{
		"username": testutil.TestUsername,
		"password": "wrong-password",
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestLogin_InvalidUsername(t *testing.T) {
	router, tc := setupAuthTestRouter()
	testutil.CreateTestUser(tc.DB)

	body, _ := json.Marshal(map[string]string{
		"username": "nonexistent",
		"password": testutil.TestPassword,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestLogin_MissingFields(t *testing.T) {
	router, _ := setupAuthTestRouter()

	body, _ := json.Marshal(map[string]string{
		"username": "onlyuser",
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestLogin_TOTPEnabled_ReturnsPartialToken(t *testing.T) {
	router, tc := setupAuthTestRouter()

	// Generate a TOTP secret for the user
	key, err := services.GenerateTOTPSecret("totpuser")
	require.NoError(t, err)

	testutil.CreateTestUserWithTOTP(tc.DB, key.Secret())

	body, _ := json.Marshal(map[string]string{
		"username": "totpuser",
		"password": testutil.TestPassword,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	require.NoError(t, err)

	assert.Equal(t, true, resp["requires_totp"], "Should indicate TOTP is required")
	assert.NotEmpty(t, resp["partial_token"], "Should return a partial token")
	assert.Nil(t, resp["access_token"], "Should not return a full access token")
}

func TestTOTPVerify_CorrectCode(t *testing.T) {
	router, tc := setupAuthTestRouter()

	key, err := services.GenerateTOTPSecret("totpuser")
	require.NoError(t, err)

	user := testutil.CreateTestUserWithTOTP(tc.DB, key.Secret())

	// Generate a partial token for this user
	partialToken := testutil.GenerateTestToken(tc.Cfg, user.ID, "totpuser", true)

	// Generate a valid TOTP code
	code, err := totp.GenerateCode(key.Secret(), time.Now())
	require.NoError(t, err)

	body, _ := json.Marshal(map[string]string{
		"code": code,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/totp-verify", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+partialToken)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	require.NoError(t, err)

	assert.NotEmpty(t, resp["access_token"], "Should return a full access token after TOTP verify")
	assert.NotEmpty(t, resp["refresh_token"], "Should return a refresh token after TOTP verify")
}

func TestTOTPVerify_WrongCode(t *testing.T) {
	router, tc := setupAuthTestRouter()

	key, err := services.GenerateTOTPSecret("totpuser2")
	require.NoError(t, err)

	user := testutil.CreateTestUserWithTOTP(tc.DB, key.Secret())

	partialToken := testutil.GenerateTestToken(tc.Cfg, user.ID, "totpuser2", true)

	body, _ := json.Marshal(map[string]string{
		"code": "000000",
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/totp-verify", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+partialToken)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestRefresh_ValidRefreshToken(t *testing.T) {
	router, tc := setupAuthTestRouter()
	user := testutil.CreateTestUser(tc.DB)

	// Create a refresh token in the database
	rawToken, tokenHash, err := utils.GenerateRefreshToken()
	require.NoError(t, err)

	rt := models.RefreshToken{
		ID:        uuid.New(),
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(168 * time.Hour),
	}
	tc.DB.Create(&rt)

	body, _ := json.Marshal(map[string]string{
		"refresh_token": rawToken,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	require.NoError(t, err)

	assert.NotEmpty(t, resp["access_token"], "Should return a new access token")
	assert.NotEmpty(t, resp["refresh_token"], "Should return a new refresh token")

	// The old refresh token should be deleted (used)
	var count int64
	tc.DB.Model(&models.RefreshToken{}).Where("id = ?", rt.ID).Count(&count)
	assert.Equal(t, int64(0), count, "Old refresh token should be deleted after use")
}

func TestRefresh_InvalidRefreshToken(t *testing.T) {
	router, _ := setupAuthTestRouter()

	body, _ := json.Marshal(map[string]string{
		"refresh_token": "nonexistent-token",
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestRefresh_ExpiredRefreshToken(t *testing.T) {
	router, tc := setupAuthTestRouter()
	user := testutil.CreateTestUser(tc.DB)

	rawToken, tokenHash, err := utils.GenerateRefreshToken()
	require.NoError(t, err)

	rt := models.RefreshToken{
		ID:        uuid.New(),
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(-1 * time.Hour), // Already expired
	}
	tc.DB.Create(&rt)

	body, _ := json.Marshal(map[string]string{
		"refresh_token": rawToken,
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code, "Expired refresh token should be rejected")
}

func TestLogout_InvalidatesTokens(t *testing.T) {
	router, tc := setupAuthTestRouter()
	user := testutil.CreateTestUser(tc.DB)

	// Create some refresh tokens for this user
	for i := 0; i < 3; i++ {
		_, tokenHash, err := utils.GenerateRefreshToken()
		require.NoError(t, err)
		rt := models.RefreshToken{
			ID:        uuid.New(),
			UserID:    user.ID,
			TokenHash: tokenHash,
			ExpiresAt: time.Now().Add(168 * time.Hour),
		}
		tc.DB.Create(&rt)
	}

	// Verify tokens exist
	var countBefore int64
	tc.DB.Model(&models.RefreshToken{}).Where("user_id = ?", user.ID).Count(&countBefore)
	assert.Equal(t, int64(3), countBefore)

	// Logout
	token := testutil.GenerateTestToken(tc.Cfg, user.ID, user.Username, false)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	// All refresh tokens should be deleted
	var countAfter int64
	tc.DB.Model(&models.RefreshToken{}).Where("user_id = ?", user.ID).Count(&countAfter)
	assert.Equal(t, int64(0), countAfter, "All refresh tokens should be deleted after logout")
}

func TestMe_ReturnsUserInfo(t *testing.T) {
	router, tc := setupAuthTestRouter()
	user := testutil.CreateTestUser(tc.DB)

	token := testutil.GenerateTestToken(tc.Cfg, user.ID, user.Username, false)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	require.NoError(t, err)

	assert.Equal(t, user.ID.String(), resp["id"])
	assert.Equal(t, user.Username, resp["username"])
}

func TestMe_RequiresAuth(t *testing.T) {
	router, _ := setupAuthTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/auth/me", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}
