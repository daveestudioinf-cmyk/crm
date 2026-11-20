package automation_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/automation"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func withIdentity(r *http.Request, id auth.Identity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), auth.IdentityKey, id))
}

func connectTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable"
	}
	pool, err := db.Connect(context.Background(), dbURL)
	if err != nil {
		t.Skipf("postgres not reachable: %v", err)
	}
	if err := db.RunMigrations(context.Background(), pool, "../../migrations"); err != nil {
		pool.Close()
		t.Fatalf("migrations: %v", err)
	}
	return pool
}

func TestAutomationRBACAndValidation(t *testing.T) {
	h := &automation.Handler{}
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("manager"))
		r.Post("/api/v1/webhooks/sources", h.CreateWebhookSource)
		r.Patch("/api/v1/webhooks/sources/{id}", h.UpdateWebhookSource)
		r.Delete("/api/v1/webhooks/sources/{id}", h.DeleteWebhookSource)
		r.Post("/api/v1/webhooks/sources/{id}/test", h.TestWebhookSource)
		r.Post("/api/v1/automation-rules", h.CreateRule)
		r.Patch("/api/v1/automation-rules/{id}", h.UpdateRule)
		r.Delete("/api/v1/automation-rules/{id}", h.DeleteRule)
		r.Post("/api/v1/automation-runs/{id}/retry", h.RetryAutomationRun)
	})

	for _, role := range []string{"viewer", "agent"} {
		id := auth.Identity{UserID: "u-1", OrganizationID: "org-1", Role: role}
		cases := []struct {
			method string
			path   string
		}{
			{http.MethodPost, "/api/v1/webhooks/sources"},
			{http.MethodPatch, "/api/v1/webhooks/sources/ws1"},
			{http.MethodDelete, "/api/v1/webhooks/sources/ws1"},
			{http.MethodPost, "/api/v1/webhooks/sources/ws1/test"},
			{http.MethodPost, "/api/v1/automation-rules"},
			{http.MethodPatch, "/api/v1/automation-rules/r1"},
			{http.MethodDelete, "/api/v1/automation-rules/r1"},
			{http.MethodPost, "/api/v1/automation-runs/run1/retry"},
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

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/sources", strings.NewReader(`{"name":""}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty webhook source name, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/automation-rules", strings.NewReader(`{"name":"Rule 1"}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing trigger_event, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/automation-rules/r1", strings.NewReader(`{invalid`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid json, got %d", rec.Code)
	}
}

func TestBuildAuditQuery(t *testing.T) {
	sql, args := automation.BuildAuditQuery("org-1", automation.AuditFilter{
		Actor:        "user-1",
		Action:       "lead.create",
		ResourceType: "lead",
		From:         "2026-01-01T00:00:00Z",
		To:           "2026-12-31T23:59:59Z",
		Query:        "vip",
		Limit:        9999, // clamped to 500
		Offset:       -10,  // clamped to 0
	})
	if !strings.Contains(sql, "organization_id = $1") {
		t.Fatalf("missing tenant filter in SQL: %s", sql)
	}
	for _, frag := range []string{
		"actor_user_id::text = $2",
		"action = $3",
		"resource_type = $4",
		"created_at >= $5::timestamptz",
		"created_at <= $6::timestamptz",
		"ILIKE $7",
		"LIMIT $8 OFFSET $9",
	} {
		if !strings.Contains(sql, frag) {
			t.Fatalf("expected %q in SQL: %s", frag, sql)
		}
	}
	if len(args) != 9 {
		t.Fatalf("expected 9 args, got %d", len(args))
	}
	if args[6] != "%vip%" {
		t.Fatalf("expected %%vip%% search arg, got %v", args[6])
	}
	if args[7] != 500 || args[8] != 0 {
		t.Fatalf("expected clamped limit=500, offset=0, got %v, %v", args[7], args[8])
	}
}

func TestBuildActivitiesQuery(t *testing.T) {
	sql, args := automation.BuildActivitiesQuery("org-2", automation.ActivitiesFilter{
		Type:      "webhook_inbound",
		ContactID: "c-1",
		LeadID:    "l-1",
		From:      "2026-01-01T00:00:00Z",
		To:        "2026-02-01T00:00:00Z",
		Limit:     500, // clamped to 200
	})
	if !strings.Contains(sql, "a.organization_id = $1") {
		t.Fatalf("missing tenant filter in SQL: %s", sql)
	}
	for _, frag := range []string{
		"a.type = $2",
		"a.contact_id::text = $3",
		"a.lead_id::text = $4",
		"a.performed_at >= $5::timestamptz",
		"a.performed_at <= $6::timestamptz",
		"LIMIT $7",
	} {
		if !strings.Contains(sql, frag) {
			t.Fatalf("expected %q in SQL: %s", frag, sql)
		}
	}
	if len(args) != 7 || args[6] != 200 {
		t.Fatalf("unexpected args: %+v", args)
	}
}

func TestAutomationWebhooksAndAnalyticsIntegration(t *testing.T) {
	pool := connectTestDB(t)
	defer pool.Close()
	ctx := context.Background()

	var orgA, orgB, userA, pipeA, stageA string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Auto Org A', 'autoa-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgA)
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Auto Org B', 'autob-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgB)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1, $2)`, orgA, orgB)

	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('auto-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Manager A') RETURNING id`).Scan(&userA)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userA)
	_, _ = pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'manager')`, userA, orgA)

	_ = pool.QueryRow(ctx, `INSERT INTO crm_pipelines (organization_id, name, is_default) VALUES ($1, 'Ventas Webhook', true) RETURNING id`, orgA).Scan(&pipeA)
	_ = pool.QueryRow(ctx, `INSERT INTO crm_stages (organization_id, pipeline_id, name, position) VALUES ($1, $2, 'Nuevo', 1000) RETURNING id`, orgA, pipeA).Scan(&stageA)

	hub := realtime.NewHub("")
	h := &automation.Handler{Pool: pool, Hub: hub}

	r := chi.NewRouter()
	r.Post("/api/v1/webhooks/in/{token}", h.InboundLeadCapture)
	r.Get("/api/v1/webhooks/sources", h.ListWebhookSources)
	r.Post("/api/v1/webhooks/sources", h.CreateWebhookSource)
	r.Patch("/api/v1/webhooks/sources/{id}", h.UpdateWebhookSource)
	r.Delete("/api/v1/webhooks/sources/{id}", h.DeleteWebhookSource)
	r.Post("/api/v1/webhooks/sources/{id}/test", h.TestWebhookSource)
	r.Get("/api/v1/automation-rules", h.ListRules)
	r.Post("/api/v1/automation-rules", h.CreateRule)
	r.Patch("/api/v1/automation-rules/{id}", h.UpdateRule)
	r.Delete("/api/v1/automation-rules/{id}", h.DeleteRule)
	r.Get("/api/v1/automation-rules/{id}/runs", h.ListRuleRuns)
	r.Post("/api/v1/automation-runs/{id}/retry", h.RetryAutomationRun)
	r.Get("/api/v1/activities", h.ListActivities)
	r.Get("/api/v1/audit", h.ListAudit)
	r.Get("/api/v1/metrics", h.GetMetrics)
	r.Get("/api/v1/metrics/funnel", h.GetFunnelMetrics)
	r.Get("/api/v1/metrics/attendants", h.GetAttendantMetrics)

	mgrA := auth.Identity{UserID: userA, OrganizationID: orgA, Role: "manager"}
	mgrB := auth.Identity{UserID: userA, OrganizationID: orgB, Role: "manager"}

	// 1. Create webhook source with default_pipeline_id
	rec := httptest.NewRecorder()
	body := `{"name":"Landing Ads","default_pipeline_id":"` + pipeA + `"}`
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/sources", strings.NewReader(body)), mgrA))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create webhook source: %d %s", rec.Code, rec.Body.String())
	}
	var wsResp struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &wsResp)

	// Cross-tenant update blocked with 404
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/webhooks/sources/"+wsResp.ID, strings.NewReader(`{"is_active":false}`)), mgrB))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on cross-tenant webhook update, got %d", rec.Code)
	}

	// 2. InboundLeadCapture emits SSE lead.updated + creates contact, lead, activity, event_log
	sseCh, unsub := hub.Subscribe(orgA)
	defer unsub()

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/in/"+wsResp.Token, strings.NewReader(`{"name":"Ana Inbound","phone":"+5511999990011","email":"ana@in.com","title":"Lead Web"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("inbound capture: %d %s", rec.Code, rec.Body.String())
	}
	var capResp struct {
		ContactID        string `json:"contact_id"`
		ResolvedExisting bool   `json:"resolved_existing"`
		LeadID           string `json:"lead_id"`
		EventID          string `json:"event_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &capResp)
	if capResp.ContactID == "" || capResp.LeadID == "" || capResp.EventID == "" {
		t.Fatalf("expected contact_id, lead_id, event_id, got %+v", capResp)
	}

	select {
	case ev := <-sseCh:
		if ev.Type != "lead.updated" {
			t.Fatalf("expected SSE lead.updated, got %s", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for SSE lead.updated")
	}

	// Second inbound with same phone resolves existing contact
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/in/"+wsResp.Token, strings.NewReader(`{"name":"Ana Dup","phone":"+5511999990011"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("second inbound: %d %s", rec.Code, rec.Body.String())
	}
	var capResp2 struct {
		ContactID        string `json:"contact_id"`
		ResolvedExisting bool   `json:"resolved_existing"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &capResp2)
	if !capResp2.ResolvedExisting || capResp2.ContactID != capResp.ContactID {
		t.Fatalf("expected deterministic phone resolution to %s, got %+v", capResp.ContactID, capResp2)
	}

	// 3. TestWebhookSource
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/sources/"+wsResp.ID+"/test", nil), mgrA))
	if rec.Code != http.StatusCreated {
		t.Fatalf("test webhook source: %d %s", rec.Code, rec.Body.String())
	}

	// 4. Automation Rule CRUD + Runs + Retry
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/automation-rules", strings.NewReader(`{"name":"Tag VIP","description":"Auto tag","trigger_event":"webhook.inbound","conditions":{"field":"email"},"actions":[{"type":"add_tag","tag":"vip"}],"priority":10,"is_active":true}`)), mgrA))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create rule: %d %s", rec.Code, rec.Body.String())
	}
	var ruleResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ruleResp)

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/automation-rules/"+ruleResp.ID, strings.NewReader(`{"is_active":false,"priority":20}`)), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("update rule: %d %s", rec.Code, rec.Body.String())
	}

	var runID string
	_ = pool.QueryRow(ctx, `
		INSERT INTO automation_rule_runs (organization_id, rule_id, trigger_event, status, input_payload, error_message)
		VALUES ($1, $2, 'webhook.inbound', 'failed', '{"lead_id":"123"}', 'timeout') RETURNING id
	`, orgA, ruleResp.ID).Scan(&runID)

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodGet, "/api/v1/automation-rules/"+ruleResp.ID+"/runs", nil), mgrA))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), runID) {
		t.Fatalf("list rule runs: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/automation-runs/"+runID+"/retry", nil), mgrA))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("retry run: %d %s", rec.Code, rec.Body.String())
	}

	// 5. Analytics, Activities & Audit
	for _, path := range []string{"/api/v1/metrics", "/api/v1/metrics/funnel", "/api/v1/metrics/attendants", "/api/v1/activities?type=webhook_inbound", "/api/v1/audit?action=automation_rule.create"} {
		rec = httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodGet, path, nil), mgrA))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s failed: %d %s", path, rec.Code, rec.Body.String())
		}
	}

	// Delete rule & webhook source
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/automation-rules/"+ruleResp.ID, nil), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete rule: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/webhooks/sources/"+wsResp.ID, nil), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete webhook source: %d", rec.Code)
	}
}
