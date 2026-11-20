package ai_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func withIdentity(r *http.Request, id auth.Identity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), auth.IdentityKey, id))
}

func connectHandlersTestDB(t *testing.T) *pgxpool.Pool {
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

func TestAIExtensionsRBACAndValidation(t *testing.T) {
	h := &ai.Handler{}
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("manager"))
		r.Post("/api/v1/ai/agents", h.CreateAgent)
		r.Patch("/api/v1/ai/agents/{id}", h.UpdateAgent)
		r.Delete("/api/v1/ai/agents/{id}", h.DeleteAgent)
		r.Patch("/api/v1/ai/memory/{id}", h.UpdateMemory)
		r.Patch("/api/v1/ai/knowledge/{id}", h.UpdateKnowledge)
		r.Post("/api/v1/ai/followups", h.CreateFollowup)
		r.Patch("/api/v1/ai/followups/{id}", h.UpdateFollowup)
		r.Delete("/api/v1/ai/followups/{id}", h.DeleteFollowup)
		r.Post("/api/v1/ai/routers", h.CreateRouter)
		r.Patch("/api/v1/ai/routers/{id}", h.UpdateRouter)
		r.Delete("/api/v1/ai/routers/{id}", h.DeleteRouter)
		r.Patch("/api/v1/ai/skills/{id}", h.UpdateSkill)
		r.Post("/api/v1/ai/cases/{id}/approve", h.ApproveCase)
		r.Post("/api/v1/ai/cases/{id}/reject", h.RejectCase)
		r.Post("/api/v1/ai/inbox/{id}/read", h.MarkInboxRead)
	})

	for _, role := range []string{"viewer", "agent"} {
		id := auth.Identity{UserID: "u-1", OrganizationID: "org-1", Role: role}
		cases := []struct {
			method string
			path   string
		}{
			{http.MethodDelete, "/api/v1/ai/agents/a1"},
			{http.MethodPatch, "/api/v1/ai/memory/m1"},
			{http.MethodPatch, "/api/v1/ai/knowledge/k1"},
			{http.MethodPost, "/api/v1/ai/followups"},
			{http.MethodPatch, "/api/v1/ai/followups/f1"},
			{http.MethodDelete, "/api/v1/ai/followups/f1"},
			{http.MethodPost, "/api/v1/ai/routers"},
			{http.MethodPatch, "/api/v1/ai/routers/r1"},
			{http.MethodDelete, "/api/v1/ai/routers/r1"},
			{http.MethodPatch, "/api/v1/ai/skills/s1"},
			{http.MethodPost, "/api/v1/ai/cases/c1/approve"},
			{http.MethodPost, "/api/v1/ai/cases/c1/reject"},
			{http.MethodPost, "/api/v1/ai/inbox/i1/read"},
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
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/followups", strings.NewReader(`{"name":""}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty followup name, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/routers", strings.NewReader(`{"name":"  "}`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty router name, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/ai/skills/s1", strings.NewReader(`{bad`)), mgr))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid json, got %d", rec.Code)
	}
}

func TestAIExtensionsIntegration(t *testing.T) {
	pool := connectHandlersTestDB(t)
	defer pool.Close()
	ctx := context.Background()

	var orgA, orgB, userA string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('AI Ext Org A', 'aiea-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgA)
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('AI Ext Org B', 'aieb-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgB)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1, $2)`, orgA, orgB)

	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('aie-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'AI Manager') RETURNING id`).Scan(&userA)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userA)

	hub := realtime.NewHub("")
	h := &ai.Handler{Pool: pool, Hub: hub}

	r := chi.NewRouter()
	r.Post("/api/v1/ai/agents", h.CreateAgent)
	r.Patch("/api/v1/ai/agents/{id}", h.UpdateAgent)
	r.Delete("/api/v1/ai/agents/{id}", h.DeleteAgent)
	r.Post("/api/v1/ai/memory", h.CreateMemory)
	r.Patch("/api/v1/ai/memory/{id}", h.UpdateMemory)
	r.Post("/api/v1/ai/knowledge", h.CreateKnowledge)
	r.Patch("/api/v1/ai/knowledge/{id}", h.UpdateKnowledge)
	r.Get("/api/v1/ai/followups", h.ListFollowups)
	r.Post("/api/v1/ai/followups", h.CreateFollowup)
	r.Patch("/api/v1/ai/followups/{id}", h.UpdateFollowup)
	r.Delete("/api/v1/ai/followups/{id}", h.DeleteFollowup)
	r.Get("/api/v1/ai/routers", h.ListRouters)
	r.Post("/api/v1/ai/routers", h.CreateRouter)
	r.Patch("/api/v1/ai/routers/{id}", h.UpdateRouter)
	r.Delete("/api/v1/ai/routers/{id}", h.DeleteRouter)
	r.Get("/api/v1/ai/skills", h.ListSkills)
	r.Patch("/api/v1/ai/skills/{id}", h.UpdateSkill)
	r.Get("/api/v1/ai/cases", h.ListCases)
	r.Post("/api/v1/ai/cases/{id}/approve", h.ApproveCase)
	r.Post("/api/v1/ai/cases/{id}/reject", h.RejectCase)
	r.Get("/api/v1/ai/inbox", h.ListInbox)
	r.Post("/api/v1/ai/inbox/{id}/read", h.MarkInboxRead)

	mgrA := auth.Identity{UserID: userA, OrganizationID: orgA, Role: "manager"}
	mgrB := auth.Identity{UserID: userA, OrganizationID: orgB, Role: "manager"}

	// 1. Agent with guardrails + Update + Delete
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/agents", strings.NewReader(`{"name":"Agente Guard","system_prompt":"Hola","guardrails":{"blocked_topics":["medical_advice"],"handoff_on_uncertainty":true}}`)), mgrA))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create agent: %d %s", rec.Code, rec.Body.String())
	}
	var agResp struct {
		ID         string         `json:"id"`
		Guardrails map[string]any `json:"guardrails"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &agResp)
	if agResp.ID == "" || agResp.Guardrails == nil {
		t.Fatalf("expected agent id and guardrails, got %+v", agResp)
	}

	// Cross-tenant delete blocked
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/ai/agents/"+agResp.ID, nil), mgrB))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on cross-tenant agent delete, got %d", rec.Code)
	}

	// 2. Followup CRUD
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/followups", strings.NewReader(`{"name":"Seguimiento 24h","trigger_type":"no_reply","delay_minutes":1440}`)), mgrA))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create followup: %d %s", rec.Code, rec.Body.String())
	}
	var fuResp struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &fuResp)

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/ai/followups/"+fuResp.ID, strings.NewReader(`{"is_active":false}`)), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("update followup: %d %s", rec.Code, rec.Body.String())
	}

	// 3. Router CRUD
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/routers", strings.NewReader(`{"name":"Router Ventas","intent_keywords":["precio","cotizacion"],"target_agent_id":"`+agResp.ID+`"}`)), mgrA))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create router: %d %s", rec.Code, rec.Body.String())
	}
	var rtResp struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &rtResp)

	// 4. Skills seeding + update
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodGet, "/api/v1/ai/skills", nil), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("list skills: %d %s", rec.Code, rec.Body.String())
	}
	var skills []struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &skills)
	if len(skills) == 0 {
		t.Fatalf("expected default skills to be seeded")
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/ai/skills/"+skills[0].ID, strings.NewReader(`{"is_enabled":false}`)), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("update skill: %d %s", rec.Code, rec.Body.String())
	}

	// 5. Cases approve + SSE ai.case_updated + Inbox read
	var caseID, inboxID string
	_ = pool.QueryRow(ctx, `INSERT INTO agent_cases (organization_id, agent_id, title, summary) VALUES ($1, $2, 'Caso Reembolso', 'Cliente pide reembolso') RETURNING id`, orgA, agResp.ID).Scan(&caseID)
	_ = pool.QueryRow(ctx, `INSERT INTO agent_inbox_items (organization_id, case_id, severity, category, message) VALUES ($1, $2, 'high', 'handoff', 'Requiere aprobación') RETURNING id`, orgA, caseID).Scan(&inboxID)

	sseCh, unsub := hub.Subscribe(orgA)
	defer unsub()

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/cases/"+caseID+"/approve", strings.NewReader(`{"decision_notes":"Aprobado por gerente"}`)), mgrA))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"approved"`) {
		t.Fatalf("approve case: %d %s", rec.Code, rec.Body.String())
	}

	select {
	case ev := <-sseCh:
		if ev.Type != "ai.case_updated" {
			t.Fatalf("expected SSE ai.case_updated, got %s", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for SSE ai.case_updated")
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/ai/inbox/"+inboxID+"/read", nil), mgrA))
	if rec.Code != http.StatusOK {
		t.Fatalf("mark inbox read: %d %s", rec.Code, rec.Body.String())
	}

	// 6. Cleanup DeleteAgent, DeleteFollowup, DeleteRouter
	for _, delPath := range []string{"/api/v1/ai/routers/" + rtResp.ID, "/api/v1/ai/followups/" + fuResp.ID, "/api/v1/ai/agents/" + agResp.ID} {
		rec = httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodDelete, delPath, nil), mgrA))
		if rec.Code != http.StatusOK {
			t.Fatalf("DELETE %s: %d %s", delPath, rec.Code, rec.Body.String())
		}
	}
}
