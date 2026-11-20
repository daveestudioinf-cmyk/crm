package automation_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/automation"
	"github.com/go-chi/chi/v5"
)

func setupCampaignRouter(h *automation.Handler) *chi.Mux {
	r := chi.NewRouter()
	r.Get("/api/v1/campaigns", h.ListCampaigns)
	r.Get("/api/v1/campaigns/{id}", h.GetCampaign)
	r.Get("/api/v1/campaigns/{id}/recipients", h.ListCampaignRecipients)
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("manager"))
		r.Post("/api/v1/campaigns", h.CreateCampaign)
		r.Patch("/api/v1/campaigns/{id}", h.UpdateCampaign)
		r.Delete("/api/v1/campaigns/{id}", h.DeleteCampaign)
		r.Post("/api/v1/campaigns/{id}/start", h.StartCampaign)
		r.Post("/api/v1/campaigns/{id}/pause", h.PauseCampaign)
		r.Post("/api/v1/campaigns/{id}/cancel", h.CancelCampaign)
	})
	return r
}

func TestCampaignsRBACAndValidation(t *testing.T) {
	h := &automation.Handler{}
	r := setupCampaignRouter(h)

	for _, role := range []string{"viewer", "agent"} {
		id := auth.Identity{UserID: "u-1", OrganizationID: "org-1", Role: role}
		cases := []struct {
			method string
			path   string
		}{
			{http.MethodPost, "/api/v1/campaigns"},
			{http.MethodPatch, "/api/v1/campaigns/c1"},
			{http.MethodDelete, "/api/v1/campaigns/c1"},
			{http.MethodPost, "/api/v1/campaigns/c1/start"},
			{http.MethodPost, "/api/v1/campaigns/c1/pause"},
			{http.MethodPost, "/api/v1/campaigns/c1/cancel"},
		}
		for _, tc := range cases {
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, withIdentity(httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)), id))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("expected 403 for role=%s on %s %s, got %d", role, tc.method, tc.path, rec.Code)
			}
		}
	}

	mgr := auth.Identity{UserID: "u-mgr", OrganizationID: "org-1", Role: "manager"}

	// Empty name & message_template -> 400
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/campaigns", strings.NewReader(`{"name":"","message_template":""}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty campaign name/template, got %d", rec.Code)
	}

	// Non-positive throttle_per_minute -> 400
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/campaigns", strings.NewReader(`{"name":"Promo","message_template":"Hola","throttle_per_minute":-5}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative throttle_per_minute, got %d", rec.Code)
	}

	// Invalid status on PATCH -> 400
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/campaigns/c1", strings.NewReader(`{"status":"bogus"}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid status, got %d", rec.Code)
	}

	// Invalid JSON -> 400
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/campaigns", strings.NewReader(`{bad`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid json, got %d", rec.Code)
	}
}

func TestCampaignsMaterializationAndLifecycle(t *testing.T) {
	pool := connectTestDB(t)
	defer pool.Close()

	ctx := context.Background()
	var orgID string
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Camp Test Org', 'camp-test-' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id`).Scan(&orgID); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)

	var okContactID, blockedContactID string
	if err := pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number, is_blocked) VALUES ($1, 'Ana', '+5215511112222', false) RETURNING id`, orgID).Scan(&okContactID); err != nil {
		t.Fatalf("insert ok contact: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number, is_blocked) VALUES ($1, 'Luis STOP', '+5215533334444', true) RETURNING id`, orgID).Scan(&blockedContactID); err != nil {
		t.Fatalf("insert blocked contact: %v", err)
	}

	h := &automation.Handler{Pool: pool}
	r := setupCampaignRouter(h)
	mgr := auth.Identity{UserID: "", OrganizationID: orgID, Role: "manager"}

	body := `{"name":"Campaña Black Friday","message_template":"Hola {{nombre}}","throttle_per_minute":12,"contact_ids":["` + okContactID + `","` + blockedContactID + `"]}`
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/campaigns", strings.NewReader(body)), mgr))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var created automation.Campaign
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.TotalCount != 1 {
		t.Fatalf("expected 1 materialized recipient (blocked excluded), got %d", created.TotalCount)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+created.ID+"/pause", nil), mgr))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on pause, got %d", rec.Code)
	}
	var paused automation.Campaign
	_ = json.Unmarshal(rec.Body.Bytes(), &paused)
	if paused.Status != "paused" {
		t.Fatalf("expected paused status, got %s", paused.Status)
	}
}
