package handlers

import (
	"testing"
	"time"
)

// Регресс на «мигание после /resume»: SessionEnd НЕ должен мгновенно обнулять карту хука —
// иначе в зазоре до SessionStart новой сессии резолв падает на «новейший-на-диске» (чужую старую
// сессию) и вид мигает. Мягкий конец держит сессию грейс-период; новый старт её перезаписывает;
// по истечении грейса «мёртвая» сессия забывается.
func TestLiveSession_SoftEndGrace(t *testing.T) {
	const inst = "claude-test-soft-end"
	const sidA = "aaaaaaaa-1111-2222-3333-444444444444"
	const sidB = "bbbbbbbb-5555-6666-7777-888888888888"
	t.Cleanup(func() {
		liveSessMu.Lock()
		delete(liveSess, inst)
		liveSessMu.Unlock()
	})

	// 1) Старт сессии A → видна.
	recordLiveSession(inst, sidA, "/ws", "/p/A.jsonl", "SessionStart")
	if sid, _, _, ok := GetLiveSession(inst); !ok || sid != sidA {
		t.Fatalf("после SessionStart: ok=%v sid=%s, want ok+%s", ok, sid, sidA)
	}

	// 2) SessionEnd A → в течение грейса ВСЁ ЕЩЁ видна A (а не пусто → не падаем на диск-новейший).
	clearLiveSession(inst)
	if sid, _, _, ok := GetLiveSession(inst); !ok || sid != sidA {
		t.Fatalf("в грейсе после SessionEnd: ok=%v sid=%s, want ok+%s (держим закрытую)", ok, sid, sidA)
	}

	// 3) SessionStart B (resume на новую) → перезаписывает, видна B.
	recordLiveSession(inst, sidB, "/ws", "/p/B.jsonl", "SessionStart")
	if sid, _, _, ok := GetLiveSession(inst); !ok || sid != sidB {
		t.Fatalf("после SessionStart B: ok=%v sid=%s, want ok+%s", ok, sid, sidB)
	}

	// 4) SessionEnd B + истёкший грейс → забываем (терминал мёртв) → резолв уйдёт в фолбэк.
	orig := liveEndGrace
	liveEndGrace = -1 * time.Second // любая Ended-запись сразу «просрочена»
	defer func() { liveEndGrace = orig }()
	clearLiveSession(inst)
	if _, _, _, ok := GetLiveSession(inst); ok {
		t.Fatalf("после грейса: ok=%v, want false (мёртвый терминал забыт)", ok)
	}
}
