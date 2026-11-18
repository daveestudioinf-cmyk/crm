package whatsapp_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/whatsapp"
	"github.com/go-chi/chi/v5"
)

func TestEvolutionWebhookAuthAndLifecycle(t *testing.T) {
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

	var orgID, sessionID string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('WA Test', 'wa-test-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)

	secret := "super-secret-webhook-token"
	sessName := "test_evo_sess_" + orgID[:8]
	_ = pool.QueryRow(ctx, `
		INSERT INTO channel_sessions (organization_id, session_name, provider, engine, status, webhook_secret)
		VALUES ($1, $2, 'evolution_go', 'WHATSMEOW', 'SCAN_QR_CODE', $3) RETURNING id
	`, orgID, sessName, secret).Scan(&sessionID)

	h := &whatsapp.Handler{Pool: pool}
	r := chi.NewRouter()
	r.Post("/webhooks/evolution/{session}", h.EvolutionWebhook)
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				ctx := context.WithValue(req.Context(), auth.IdentityKey, auth.Identity{
					UserID:         "u-1",
					OrganizationID: orgID,
					Role:           "admin",
				})
				next.ServeHTTP(w, req.WithContext(ctx))
			})
		})
		r.Patch("/channels/{id}", h.UpdateChannel)
		r.Post("/channels/{id}/disconnect", h.DisconnectChannel)
		r.Delete("/channels/{id}", h.DeleteChannel)
	})

	// 1. Unauthenticated webhook must return 401
	req := httptest.NewRequest(http.MethodPost, "/webhooks/evolution/"+sessName, bytes.NewBufferString(`{"event":"connection.update","data":{"state":"open"}}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated webhook, got %d", rec.Code)
	}

	// 2. Authenticated connection.update open -> WORKING + phone
	req = httptest.NewRequest(http.MethodPost, "/webhooks/evolution/"+sessName, bytes.NewBufferString(`{"event":"connection.update","data":{"state":"open","wuid":"5215512345678@s.whatsapp.net"}}`))
	req.Header.Set("X-Webhook-Secret", secret)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on connection.update, got %d", rec.Code)
	}
	var status, phone string
	_ = pool.QueryRow(ctx, `SELECT status, COALESCE(phone_number,'') FROM channel_sessions WHERE id=$1`, sessionID).Scan(&status, &phone)
	if status != "WORKING" || phone != "+5215512345678" {
		t.Fatalf("unexpected channel state: status=%s phone=%s", status, phone)
	}

	// 3. Group JID @g.us should be ignored
	req = httptest.NewRequest(http.MethodPost, "/webhooks/evolution/"+sessName, bytes.NewBufferString(`{"event":"messages.upsert","data":{"key":{"id":"m1","remoteJid":"120363000@g.us","fromMe":false},"message":{"conversation":"hola grupo"}}}`))
	req.Header.Set("X-Webhook-Secret", secret)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on ignored group, got %d", rec.Code)
	}
	var msgCount int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE organization_id=$1`, orgID).Scan(&msgCount)
	if msgCount != 0 {
		t.Fatalf("expected 0 messages for group JID, got %d", msgCount)
	}

	// 4. Update warmup_daily_limit, disconnect, delete
	req = httptest.NewRequest(http.MethodPatch, "/channels/"+sessionID, bytes.NewBufferString(`{"warmup_daily_limit":250}`))
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on PATCH warmup, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/channels/"+sessionID+"/disconnect", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on disconnect, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/channels/"+sessionID, nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete, got %d", rec.Code)
	}
}
