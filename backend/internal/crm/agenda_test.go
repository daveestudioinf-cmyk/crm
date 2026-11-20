package crm_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/crm"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
)

func setupAgendaRouter(h *crm.Handler) *chi.Mux {
	r := chi.NewRouter()
	r.Get("/api/v1/appointments", h.ListAppointments)
	r.Get("/api/v1/appointments/{id}", h.GetAppointment)
	r.Get("/api/v1/waitlist", h.ListWaitlist)
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("agent"))
		r.Post("/api/v1/appointments", h.CreateAppointment)
		r.Patch("/api/v1/appointments/{id}", h.UpdateAppointment)
		r.Delete("/api/v1/appointments/{id}", h.DeleteAppointment)
		r.Post("/api/v1/waitlist", h.CreateWaitlistEntry)
		r.Patch("/api/v1/waitlist/{id}", h.UpdateWaitlistEntry)
		r.Delete("/api/v1/waitlist/{id}", h.DeleteWaitlistEntry)
		r.Post("/api/v1/waitlist/{id}/promote", h.PromoteWaitlistEntry)
	})
	return r
}

func TestAgendaRBACAndValidation(t *testing.T) {
	h := &crm.Handler{}
	r := setupAgendaRouter(h)

	viewer := auth.Identity{UserID: "u-v", OrganizationID: "org-1", Role: "viewer"}
	viewerBlocked := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/appointments"},
		{http.MethodPatch, "/api/v1/appointments/a1"},
		{http.MethodDelete, "/api/v1/appointments/a1"},
		{http.MethodPost, "/api/v1/waitlist"},
		{http.MethodPatch, "/api/v1/waitlist/w1"},
		{http.MethodDelete, "/api/v1/waitlist/w1"},
		{http.MethodPost, "/api/v1/waitlist/w1/promote"},
	}
	for _, tc := range viewerBlocked {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)), viewer))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for viewer on %s %s, got %d", tc.method, tc.path, rec.Code)
		}
	}

	agent := auth.Identity{UserID: "u-a", OrganizationID: "org-1", Role: "agent"}

	// Empty title -> 400
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/appointments", strings.NewReader(`{"title":"","starts_at":"2026-12-01T10:00:00Z"}`)), agent))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty title, got %d", rec.Code)
	}

	// Invalid starts_at -> 400
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/appointments", strings.NewReader(`{"title":"Demo","starts_at":"no-es-fecha"}`)), agent))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid starts_at, got %d", rec.Code)
	}

	// ends_at <= starts_at -> 400
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/appointments", strings.NewReader(`{"title":"Demo","starts_at":"2026-12-01T10:00:00Z","ends_at":"2026-12-01T09:00:00Z"}`)), agent))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ends_at <= starts_at, got %d", rec.Code)
	}

	// Empty contact_name on waitlist -> 400
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/waitlist", strings.NewReader(`{"contact_name":""}`)), agent))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty contact_name, got %d", rec.Code)
	}
}

func TestComputeAppointmentWindow(t *testing.T) {
	s, e, d, err := crm.ComputeAppointmentWindow("2026-12-01T10:00:00Z", 0, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d != 30 || !e.Equal(s.Add(30*time.Minute)) {
		t.Fatalf("expected default 30m window, got dur=%d end=%v", d, e)
	}

	if _, _, _, err := crm.ComputeAppointmentWindow("2026-12-01T10:00:00Z", 30, "2026-12-01T10:00:00Z"); err == nil {
		t.Fatalf("expected error when ends_at == starts_at")
	}
}

func connectAgendaTestDB(t *testing.T) *pgxpool.Pool {
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

func TestAgendaOverlapAndWaitlistPromote(t *testing.T) {
	pool := connectAgendaTestDB(t)
	defer pool.Close()

	ctx := context.Background()
	var orgID string
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Agenda Test Org', 'agenda-test-' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id`).Scan(&orgID); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)

	h := &crm.Handler{Pool: pool}
	r := setupAgendaRouter(h)
	agent := auth.Identity{UserID: "", OrganizationID: orgID, Role: "agent"}

	// Create appointment 1
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/appointments", strings.NewReader(`{"title":"Cita 1","starts_at":"2026-12-10T15:00:00Z","duration_minutes":30}`)), agent))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	// Overlapping appointment -> 409 Conflict
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/appointments", strings.NewReader(`{"title":"Cita Solapada","starts_at":"2026-12-10T15:15:00Z","duration_minutes":30}`)), agent))
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict on overlap, got %d", rec.Code)
	}

	// Create waitlist entry & promote
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/waitlist", strings.NewReader(`{"contact_name":"Carlos","phone_e164":"+5215512345678","notes":"Prefiere tarde"}`)), agent))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for waitlist, got %d", rec.Code)
	}
	var wl crm.WaitlistEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &wl)

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/waitlist/"+wl.ID+"/promote", strings.NewReader(`{"starts_at":"2026-12-10T17:00:00Z","duration_minutes":45}`)), agent))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 on promote, got %d: %s", rec.Code, rec.Body.String())
	}
}
