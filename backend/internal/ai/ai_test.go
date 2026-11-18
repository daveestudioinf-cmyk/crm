package ai_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
)

type spySender struct {
	mu    sync.Mutex
	calls []string
}

func (s *spySender) SendText(ctx context.Context, instanceName, phoneNumber, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, instanceName+"|"+phoneNumber+"|"+text)
	return nil
}

type allowAllThrottle struct{}

func (allowAllThrottle) AllowOutbound(ctx context.Context, sessionID string, dailyLimit int) bool {
	return true
}

func TestCryptoAndMask(t *testing.T) {
	seed := "test-encryption-seed-32-bytes!!"
	plain := "sk-proj-1234567890abcdef"
	enc, err := ai.EncryptAPIKey(seed, plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if enc == plain {
		t.Fatalf("ciphertext must not equal plaintext")
	}
	dec, err := ai.DecryptAPIKey(seed, enc)
	if err != nil || dec != plain {
		t.Fatalf("decrypt mismatch: %v / %q", err, dec)
	}
	if got := ai.MaskAPIKey(plain); got != "sk-••••cdef" {
		t.Fatalf("unexpected mask: %q", got)
	}
	if got := ai.MaskAPIKey("short"); got != "••••" {
		t.Fatalf("unexpected short mask: %q", got)
	}
}

func TestGeminiErrorRedaction(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"bad key AIzaSecretKey12345"}`))
	}))
	defer srv.Close()

	_, err := ai.CallLLM(context.Background(), ai.LLMRequest{
		Provider: "gemini",
		BaseURL:  srv.URL,
		APIKey:   "AIzaSecretKey12345",
		Model:    "gemini-2.0-flash",
		Messages: []ai.ChatMessage{{Role: "user", Content: "hola"}},
	})
	if err == nil {
		t.Fatalf("expected error")
	}
	if contains := string(err.Error()); len(contains) == 0 || (contains != "" && (findSub(contains, "AIzaSecretKey12345"))) {
		t.Fatalf("error leaked plaintext api key: %s", err.Error())
	}
}

func findSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestRunnerIntegration_RealLLM_BudgetHardStop_Handoff(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable"
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dbURL)
	if err != nil {
		t.Skipf("postgres not reachable: %v", err)
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("migrations: %v", err)
	}

	var orgID, contactID, sessionID, convID string
	err = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('AI Test Org', 'ai-test-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	if err != nil {
		t.Fatalf("insert org: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)

	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Cliente IA', '+5215511112222') RETURNING id`, orgID).Scan(&contactID)
	_ = pool.QueryRow(ctx, `INSERT INTO channel_sessions (organization_id, session_name, provider, engine, status, webhook_secret) VALUES ($1, 'org_wa', 'evolution_go', 'WHATSMEOW', 'WORKING', 'sec') RETURNING id`, orgID).Scan(&sessionID)
	_ = pool.QueryRow(ctx, `INSERT INTO conversations (organization_id, contact_id, channel_session_id, status) VALUES ($1, $2, $3, 'ai_handling') RETURNING id`, orgID, contactID, sessionID).Scan(&convID)
	_, _ = pool.Exec(ctx, `INSERT INTO ai_agents (organization_id, name, system_prompt, provider, model) VALUES ($1, 'Agente Ventas', 'Responde breve.', 'openai', 'gpt-4o-mini')`, orgID)
	_, _ = pool.Exec(ctx, `INSERT INTO org_memory_entries (organization_id, category, content) VALUES ($1, 'horario', 'Atendemos de lunes a viernes')`, orgID)

	llmServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"content": "Hola, atendemos de lunes a viernes. ¿En qué te ayudo?"}},
			},
			"usage": map[string]any{"prompt_tokens": 120, "completion_tokens": 25},
		})
	}))
	defer llmServer.Close()

	seed := "test-seed-32-bytes-minimum-key!!"
	enc, _ := ai.EncryptAPIKey(seed, "sk-test-1234567890")
	_, _ = pool.Exec(ctx, `
		INSERT INTO ai_provider_credentials (organization_id, provider, base_url, default_model, api_key_encrypted, api_key_mask, is_active)
		VALUES ($1, 'openai', $2, 'gpt-4o-mini', $3, 'sk-••••7890', true)
	`, orgID, llmServer.URL, enc)

	_, _ = pool.Exec(ctx, `INSERT INTO ai_budgets (organization_id, monthly_cap_cents, monthly_limit_cents, spent_cents, warn_at_percent, hard_stop) VALUES ($1, 1, 1, 0, 80, true)`, orgID)

	spy := &spySender{}
	runner := &ai.Runner{
		Pool:          pool,
		EncryptionKey: seed,
		Outbound:      spy,
		Throttle:      allowAllThrottle{},
	}

	// Turn 1: should succeed via mock OpenAI, record run, spend 1 cent, and send WhatsApp text
	if err := runner.RunAgentTurn(ctx, orgID, convID, "Cuál es su horario?"); err != nil {
		t.Fatalf("turn 1: %v", err)
	}
	if len(spy.calls) != 1 {
		t.Fatalf("expected 1 outbound whatsapp call, got %d", len(spy.calls))
	}

	var spent int64
	_ = pool.QueryRow(ctx, `SELECT spent_cents FROM ai_budgets WHERE organization_id=$1`, orgID).Scan(&spent)
	if spent < 1 {
		t.Fatalf("expected spent_cents >= 1, got %d", spent)
	}

	// Turn 2: budget is 1/1 with hard_stop=true -> must block and trigger handoff to pending
	if err := runner.RunAgentTurn(ctx, orgID, convID, "Otra pregunta"); err != nil {
		t.Fatalf("turn 2: %v", err)
	}
	var convStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM conversations WHERE id=$1`, convID).Scan(&convStatus)
	if convStatus != "pending" {
		t.Fatalf("expected conversation pending after budget_exceeded, got %s", convStatus)
	}

	var runCount int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM ai_agent_runs WHERE organization_id=$1`, orgID).Scan(&runCount)
	if runCount != 2 {
		t.Fatalf("expected 2 ai_agent_runs, got %d", runCount)
	}
}
