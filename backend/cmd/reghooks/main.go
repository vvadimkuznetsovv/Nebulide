// Standalone-утилита: регистрирует Claude Code hooks + statusLine в ~/.claude/settings.json
// БЕЗ запуска полного бэкенда (без БД/Redis). Полезно для локальной настройки/проверки на
// Windows. Тот же код, что зовётся в main.go на старте: services.RegisterClaudeHooks().
//
//	cd backend && go run ./cmd/reghooks
package main

import "nebulide/services"

func main() {
	services.RegisterClaudeHooks()
}
