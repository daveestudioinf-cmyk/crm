package crm_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/crm"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func withIdentity(r *http.Request, id auth.Identity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), auth.IdentityKey, id))
}

func TestValidateCPF(t *testing.T) {
	validCases := []struct {
		in   string
		want string
	}{
		{"52998224725", "52998224725"},
		{"529.982.247-25", "52998224725"},
		{"11144477735", "11144477735"},
	}
	for _, tc := range validCases {
		got, ok := crm.ValidateCPF(tc.in)
		if !ok || got != tc.want {
			t.Fatalf("ValidateCPF(%q) = (%q, %v), want (%q, true)", tc.in, got, ok, tc.want)
		}
	}

	invalidCases := []string{
		"",
		"123",
		"11111111111",
		"00000000000",
		"52998224726", // bad check digit
		"52998224735", // bad check digit
		"5299822472a",
	}
	for _, in := range invalidCases {
		if got, ok := crm.ValidateCPF(in); ok {
			t.Fatalf("ValidateCPF(%q) = (%q, true), want false", in, got)
		}
	}
}

func TestValidateE164(t *testing.T) {
	if !crm.ValidateE164("+5511999990001") || !crm.ValidateE164("+14155552671") {
		t.Fatalf("expected valid E.164 numbers to pass")
	}
	for _, bad := range []string{"", "5511999990001", "+01234567", "+55", "+5511999990001abc"} {
		if crm.ValidateE164(bad) {
			t.Fatalf("expected %q to fail E.164 validation", bad)
		}
	}
}

func TestCreateContactInvalidCPFAndRBAC(t *testing.T) {
	h := &crm.Handler{}
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("agent"))
		r.Post("/api/v1/contacts", h.CreateContact)
		r.Post("/api/v1/contacts/merge", h.MergeContacts)
		r.Post("/api/v1/contacts/merge-queue/{id}/dismiss", h.DismissMergeQueue)
	})

	viewer := auth.Identity{UserID: "u-v", OrganizationID: "org-1", Role: "viewer"}
	agent := auth.Identity{UserID: "u-a", OrganizationID: "org-1", Role: "agent"}

	// Viewer blocked (403) on CRM M2 mutations
	for _, path := range []string{"/api/v1/contacts", "/api/v1/contacts/merge", "/api/v1/contacts/merge-queue/mq1/dismiss"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"name":"Test"}`)), viewer))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for viewer on %s, got %d", path, rec.Code)
		}
	}

	// Agent sending invalid CPF on CreateContact -> 400 Bad Request
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts", strings.NewReader(`{"name":"Maria","cpf":"111.111.111-11"}`)), agent))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_cpf") {
		t.Fatalf("expected 400 invalid_cpf, got %d: %s", rec.Code, rec.Body.String())
	}
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
	return pool
}

func TestCustomer360_CPF_Phones_MergeDismiss_AtomicMerge(t *testing.T) {
	pool := connectTestDB(t)
	defer pool.Close()
	ctx := context.Background()

	var orgA, orgB, userA string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('CRM Org A', 'crma-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgA)
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('CRM Org B', 'crmb-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgB)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1, $2)`, orgA, orgB)

	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('crm-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Agent') RETURNING id`).Scan(&userA)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userA)

	var cPrimary, cDup, cOther string
	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Primary', '+5511999990001') RETURNING id`, orgA).Scan(&cPrimary)
	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Duplicate', '+5511999990002') RETURNING id`, orgA).Scan(&cDup)
	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Other', '+5511999990003') RETURNING id`, orgA).Scan(&cOther)

	var mqDismissID, mqMergeID string
	_ = pool.QueryRow(ctx, `INSERT INTO merge_queue (organization_id, primary_contact_id, duplicate_contact_id, reason) VALUES ($1, $2, $3, 'phone_email_conflict') RETURNING id`, orgA, cPrimary, cOther).Scan(&mqDismissID)
	_ = pool.QueryRow(ctx, `INSERT INTO merge_queue (organization_id, primary_contact_id, duplicate_contact_id, reason) VALUES ($1, $2, $3, 'phone_email_conflict') RETURNING id`, orgA, cPrimary, cDup).Scan(&mqMergeID)

	// Attach lead, conversation, task, lgpd_request, phone to cDup to verify full atomic repointing
	var pipeID, stageID string
	_ = pool.QueryRow(ctx, `INSERT INTO crm_pipelines (organization_id, name) VALUES ($1, 'Sales') RETURNING id`, orgA).Scan(&pipeID)
	_ = pool.QueryRow(ctx, `INSERT INTO crm_stages (organization_id, pipeline_id, name) VALUES ($1, $2, 'New') RETURNING id`, orgA, pipeID).Scan(&stageID)
	_, _ = pool.Exec(ctx, `INSERT INTO crm_leads (organization_id, contact_id, pipeline_id, stage_id, title) VALUES ($1, $2, $3, $4, 'Dup Deal')`, orgA, cDup, pipeID, stageID)
	_, _ = pool.Exec(ctx, `INSERT INTO conversations (organization_id, contact_id, status) VALUES ($1, $2, 'open')`, orgA, cDup)
	_, _ = pool.Exec(ctx, `INSERT INTO crm_tasks (organization_id, contact_id, title) VALUES ($1, $2, 'Dup Task')`, orgA, cDup)
	_, _ = pool.Exec(ctx, `INSERT INTO lgpd_requests (organization_id, contact_id, request_type) VALUES ($1, $2, 'export')`, orgA, cDup)
	_, _ = pool.Exec(ctx, `INSERT INTO contact_phones (organization_id, contact_id, phone_e164, is_primary) VALUES ($1, $2, '+5511999990002', true)`, orgA, cDup)

	h := &crm.Handler{Pool: pool}
	r := chi.NewRouter()
	r.Get("/api/v1/contacts/{id}", h.GetContact)
	r.Patch("/api/v1/contacts/{id}", h.UpdateContact)
	r.Post("/api/v1/contacts/{id}/phones", h.AddContactPhone)
	r.Delete("/api/v1/contacts/{id}/phones/{phoneId}", h.DeleteContactPhone)
	r.Post("/api/v1/contacts/merge-queue/{id}/dismiss", h.DismissMergeQueue)
	r.Post("/api/v1/contacts/merge", h.MergeContacts)

	idA := auth.Identity{UserID: userA, OrganizationID: orgA, Role: "agent"}
	idB := auth.Identity{UserID: userA, OrganizationID: orgB, Role: "admin"}

	// 1. UpdateContact: invalid CPF -> 400
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/contacts/"+cPrimary, strings.NewReader(`{"cpf":"11111111111"}`)), idA))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid CPF, got %d", rec.Code)
	}

	// 2. UpdateContact: valid CPF + custom_fields -> 200
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/contacts/"+cPrimary, strings.NewReader(`{"cpf":"529.982.247-25","custom_fields":{"vip":true}}`)), idA))
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid CPF, got %d: %s", rec2.Code, rec2.Body.String())
	}

	// 3. UpdateContact: duplicate CPF on cOther -> 409
	rec3 := httptest.NewRecorder()
	r.ServeHTTP(rec3, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/contacts/"+cOther, strings.NewReader(`{"cpf":"52998224725"}`)), idA))
	if rec3.Code != http.StatusConflict {
		t.Fatalf("expected 409 for duplicate CPF, got %d", rec3.Code)
	}

	// 4. AddContactPhone: invalid E.164 -> 400
	recP0 := httptest.NewRecorder()
	r.ServeHTTP(recP0, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/"+cPrimary+"/phones", strings.NewReader(`{"phone_e164":"11999990001"}`)), idA))
	if recP0.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid E.164, got %d", recP0.Code)
	}

	// 5. AddContactPhone: primary + secondary, then delete primary -> promotes secondary
	recP1 := httptest.NewRecorder()
	r.ServeHTTP(recP1, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/"+cPrimary+"/phones", strings.NewReader(`{"phone_e164":"+5511999990001","is_primary":true}`)), idA))
	if recP1.Code != http.StatusCreated {
		t.Fatalf("expected 201 for primary phone, got %d: %s", recP1.Code, recP1.Body.String())
	}
	var p1Resp map[string]any
	_ = json.Unmarshal(recP1.Body.Bytes(), &p1Resp)
	p1ID, _ := p1Resp["id"].(string)

	recP2 := httptest.NewRecorder()
	r.ServeHTTP(recP2, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/"+cPrimary+"/phones", strings.NewReader(`{"phone_e164":"+5511988887777","is_primary":false}`)), idA))
	if recP2.Code != http.StatusCreated {
		t.Fatalf("expected 201 for secondary phone, got %d", recP2.Code)
	}

	recPD := httptest.NewRecorder()
	r.ServeHTTP(recPD, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/contacts/"+cPrimary+"/phones/"+p1ID, nil), idA))
	if recPD.Code != http.StatusOK {
		t.Fatalf("expected 200 deleting primary phone, got %d", recPD.Code)
	}
	var syncedPhone string
	_ = pool.QueryRow(ctx, `SELECT phone_number FROM contacts WHERE id=$1`, cPrimary).Scan(&syncedPhone)
	if syncedPhone != "+5511988887777" {
		t.Fatalf("expected promoted primary phone +5511988887777, got %q", syncedPhone)
	}

	// 6. DismissMergeQueue: cross-tenant -> 404, own tenant -> 200, second dismiss -> 409
	recMQB := httptest.NewRecorder()
	r.ServeHTTP(recMQB, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/merge-queue/"+mqDismissID+"/dismiss", nil), idB))
	if recMQB.Code != http.StatusNotFound {
		t.Fatalf("expected 404 cross-tenant dismiss, got %d", recMQB.Code)
	}
	recMQ1 := httptest.NewRecorder()
	r.ServeHTTP(recMQ1, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/merge-queue/"+mqDismissID+"/dismiss", nil), idA))
	if recMQ1.Code != http.StatusOK {
		t.Fatalf("expected 200 dismiss, got %d", recMQ1.Code)
	}
	recMQ2 := httptest.NewRecorder()
	r.ServeHTTP(recMQ2, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/merge-queue/"+mqDismissID+"/dismiss", nil), idA))
	if recMQ2.Code != http.StatusConflict {
		t.Fatalf("expected 409 second dismiss, got %d", recMQ2.Code)
	}

	// 7. MergeContacts: atomic repoint + GetContact 360
	recM := httptest.NewRecorder()
	r.ServeHTTP(recM, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/contacts/merge", strings.NewReader(`{"primary_id":"`+cPrimary+`","duplicate_id":"`+cDup+`"}`)), idA))
	if recM.Code != http.StatusOK {
		t.Fatalf("expected 200 merge, got %d: %s", recM.Code, recM.Body.String())
	}

	recGet := httptest.NewRecorder()
	r.ServeHTTP(recGet, withIdentity(httptest.NewRequest(http.MethodGet, "/api/v1/contacts/"+cPrimary, nil), idA))
	if recGet.Code != http.StatusOK {
		t.Fatalf("expected 200 get contact, got %d", recGet.Code)
	}
	var c360 map[string]any
	_ = json.Unmarshal(recGet.Body.Bytes(), &c360)
	if len(c360["leads"].([]any)) != 1 || len(c360["conversations"].([]any)) != 1 || len(c360["tasks"].([]any)) != 1 || len(c360["phones"].([]any)) != 2 {
		t.Fatalf("expected repointed leads/conversations/tasks/phones in 360 view, got %+v", c360)
	}
}
