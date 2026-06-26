package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"nebulide/config"
)

// GLMStatusHandler отдаёт доступность GLM (Z.ai) для индикатора на кнопке «Z».
// Источник — БЕСПЛАТНЫЙ usage-эндпоинт Z.ai (monitor/usage/quota/limit): он показывает
// % использования 5-часового и недельного циклов БЕЗ траты промпта (проверено живым токеном).
type GLMStatusHandler struct {
	cfg *config.Config
}

func NewGLMStatusHandler(cfg *config.Config) *GLMStatusHandler {
	return &GLMStatusHandler{cfg: cfg}
}

type glmStatus struct {
	Enabled      bool   `json:"enabled"`
	Available    bool   `json:"available"`      // зелёный? (лимит не исчерпан)
	Level        string `json:"level,omitempty"` // "pro" / "lite" / "max"
	CyclePercent int    `json:"cycle_percent"`   // 5-часовой цикл: % использования
	CycleResetAt int64  `json:"cycle_reset_at"`  // epoch-ms сброса 5-часового цикла
	WeekPercent  int    `json:"week_percent"`
	WeekResetAt  int64  `json:"week_reset_at"`
}

// parseQuota разбирает тело monitor/usage/quota/limit. Берёт ТОЛЬКО записи TOKENS_LIMIT
// (TIME_LIMIT = MCP-инструменты, к промптам не относится). Самый РАННИЙ nextResetTime =
// 5-часовой цикл (он исчерпывается первым), самый поздний = недельный.
// Available = все TOKENS_LIMIT.percentage < 100.
func parseQuota(body []byte) (glmStatus, error) {
	var r struct {
		Data struct {
			Level  string `json:"level"`
			Limits []struct {
				Type          string  `json:"type"`
				Percentage    float64 `json:"percentage"`
				NextResetTime int64   `json:"nextResetTime"`
			} `json:"limits"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return glmStatus{}, err
	}
	type tl struct {
		pct   float64
		reset int64
	}
	var toks []tl
	for _, l := range r.Data.Limits {
		if l.Type == "TOKENS_LIMIT" {
			toks = append(toks, tl{l.Percentage, l.NextResetTime})
		}
	}
	if len(toks) == 0 {
		return glmStatus{}, fmt.Errorf("no TOKENS_LIMIT in usage response")
	}
	sort.Slice(toks, func(i, j int) bool { return toks[i].reset < toks[j].reset })

	available := true
	for _, t := range toks {
		if t.pct >= 100 {
			available = false
		}
	}
	st := glmStatus{
		Enabled:      true,
		Available:    available,
		Level:        r.Data.Level,
		CyclePercent: int(math.Round(toks[0].pct)),
		CycleResetAt: toks[0].reset,
	}
	if len(toks) > 1 {
		last := toks[len(toks)-1]
		st.WeekPercent = int(math.Round(last.pct))
		st.WeekResetAt = last.reset
	}
	return st, nil
}

// Пакетный кэш: usage-эндпоинт глобальный по ключу (один на всех юзеров), поэтому кэшируем
// в пакете, а не per-user. Throttle ~20с — чтобы не молотить эндпоинт при N одновременных опросах.
var (
	glmMu       sync.Mutex
	glmCache    glmStatus
	glmCacheOK  bool
	glmFetched  time.Time
	glmFetching bool
)

const glmCacheTTL = 20 * time.Second

func (h *GLMStatusHandler) Get(c *gin.Context) {
	if h.cfg.ZaiAPIKey == "" {
		c.JSON(http.StatusOK, glmStatus{Enabled: false})
		return
	}

	glmMu.Lock()
	fresh := glmCacheOK && time.Since(glmFetched) < glmCacheTTL
	if fresh || glmFetching {
		st, ok := glmCache, glmCacheOK
		glmMu.Unlock()
		if ok {
			c.JSON(http.StatusOK, st)
		} else {
			// кто-то уже тянет первый ответ — оптимистично «доступно», не моргаем в красный
			c.JSON(http.StatusOK, glmStatus{Enabled: true, Available: true})
		}
		return
	}
	glmFetching = true
	glmMu.Unlock()

	st, err := h.fetchUsage()

	glmMu.Lock()
	glmFetching = false
	if err == nil {
		glmCache, glmCacheOK, glmFetched = st, true, time.Now()
	}
	prev, prevOK := glmCache, glmCacheOK
	glmMu.Unlock()

	switch {
	case err == nil:
		c.JSON(http.StatusOK, st)
	case prevOK:
		c.JSON(http.StatusOK, prev) // сетевая ошибка — держим последний статус, не моргаем
	default:
		c.JSON(http.StatusOK, glmStatus{Enabled: true, Available: true})
	}
}

func (h *GLMStatusHandler) fetchUsage() (glmStatus, error) {
	req, err := http.NewRequest(http.MethodGet, h.cfg.ZaiUsageURL, nil)
	if err != nil {
		return glmStatus{}, err
	}
	// ВАЖНО: usage-эндпоинт принимает СЫРОЙ токен без префикса "Bearer".
	req.Header.Set("Authorization", h.cfg.ZaiAPIKey)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return glmStatus{}, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return glmStatus{}, fmt.Errorf("usage endpoint HTTP %d", resp.StatusCode)
	}
	return parseQuota(body)
}
