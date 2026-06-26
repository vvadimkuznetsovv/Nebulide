package handlers

import "testing"

// Реальное тело ответа monitor/usage/quota/limit (снято живым токеном).
const realQuotaBody = `{"code":200,"msg":"Operation successful","data":{"limits":[` +
	`{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":1,"nextResetTime":1782515667627},` +
	`{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":20,"nextResetTime":1783012394998},` +
	`{"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"currentValue":7,"remaining":993,"percentage":1,"nextResetTime":1784999594998}` +
	`],"level":"pro"},"success":true}`

func TestParseQuota(t *testing.T) {
	t.Run("реальное тело: доступно, pro, 5ч раньше недели", func(t *testing.T) {
		st, err := parseQuota([]byte(realQuotaBody))
		if err != nil {
			t.Fatalf("ошибка парсинга: %v", err)
		}
		if !st.Enabled || !st.Available {
			t.Errorf("ожидали enabled+available, получили %+v", st)
		}
		if st.Level != "pro" {
			t.Errorf("level = %q, ожидали pro", st.Level)
		}
		// 5-часовой цикл = самый ранний nextResetTime (1782515667627), percentage 1
		if st.CyclePercent != 1 || st.CycleResetAt != 1782515667627 {
			t.Errorf("cycle = %d%% reset=%d, ожидали 1%% reset=1782515667627", st.CyclePercent, st.CycleResetAt)
		}
		// недельный = поздний reset (1783012394998), percentage 20
		if st.WeekPercent != 20 || st.WeekResetAt != 1783012394998 {
			t.Errorf("week = %d%% reset=%d, ожидали 20%% reset=1783012394998", st.WeekPercent, st.WeekResetAt)
		}
	})

	t.Run("исчерпанный цикл (100%) → недоступно", func(t *testing.T) {
		body := `{"data":{"level":"pro","limits":[{"type":"TOKENS_LIMIT","percentage":100,"nextResetTime":111},{"type":"TOKENS_LIMIT","percentage":40,"nextResetTime":222}]}}`
		st, err := parseQuota([]byte(body))
		if err != nil {
			t.Fatalf("ошибка: %v", err)
		}
		if st.Available {
			t.Errorf("ожидали недоступно при 100%%, получили available=true")
		}
		if st.CycleResetAt != 111 {
			t.Errorf("cycle reset = %d, ожидали 111 (ранний)", st.CycleResetAt)
		}
	})

	t.Run("только TIME_LIMIT (нет TOKENS_LIMIT) → ошибка", func(t *testing.T) {
		body := `{"data":{"level":"pro","limits":[{"type":"TIME_LIMIT","percentage":1,"nextResetTime":1}]}}`
		if _, err := parseQuota([]byte(body)); err == nil {
			t.Errorf("ожидали ошибку при отсутствии TOKENS_LIMIT")
		}
	})

	t.Run("дробный процент округляется", func(t *testing.T) {
		body := `{"data":{"level":"lite","limits":[{"type":"TOKENS_LIMIT","percentage":99.6,"nextResetTime":5}]}}`
		st, err := parseQuota([]byte(body))
		if err != nil {
			t.Fatalf("ошибка: %v", err)
		}
		if st.CyclePercent != 100 {
			t.Errorf("99.6%% → %d, ожидали 100 (округление)", st.CyclePercent)
		}
		if !st.Available {
			t.Errorf("99.6%% (<100) должно быть доступно")
		}
	})
}
