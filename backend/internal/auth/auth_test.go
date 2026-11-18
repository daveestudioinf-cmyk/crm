package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/admin"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/mcpserver"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func connectTestDB(t *testing.T) (*auth.Middleware, *admin.Handler, func()) {
	t.Helper()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable"
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dbURL)
	if err != nil {
		t.Skipf("postgres not reachable: %v", err)
	}
	mw := &auth.Middleware{
		Pool:      pool,
		JWTSecret: "test-secret-key-32-bytes-minimum!",
	}
	adm := &admin.Handler{Pool: pool}
	return mw, adm, func() { pool.Close() }
}

func TestSuperAdminSuspensionAndSupportSessions(t *testing.T) {
	mw, adm, cleanup := connectTestDB(t)
	defer cleanup()

	ctx := context.Background()
	pool := mw.Pool

	// Create two organizations: adminOrg (admin's own org) and targetOrg
	var adminOrgID, targetOrgID string
	err := pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Admin Org', 'admin-org-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&adminOrgID)
	if err != nil {
		t.Fatalf("insert adminOrg: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, adminOrgID)

	err = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Target Org', 'target-org-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&targetOrgID)
	if err != nil {
		t.Fatalf("insert targetOrg: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, targetOrgID)

	// Create platform admin user and regular user
	var adminUserID, regularUserID string
	err = pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, full_name, is_platform_admin)
		VALUES ('pa-' || substr(md5(random()::text),1,6) || '@koracrm.dev', 'hash', 'Platform Admin', true)
		RETURNING id
	`).Scan(&adminUserID)
	if err != nil {
		t.Fatalf("insert admin user: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, adminUserID)

	err = pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, full_name, is_platform_admin)
		VALUES ('reg-' || substr(md5(random()::text),1,6) || '@koracrm.dev', 'hash', 'Regular User', false)
		RETURNING id
	`).Scan(&regularUserID)
	if err != nil {
		t.Fatalf("insert regular user: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, regularUserID)

	_, _ = pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`, adminUserID, adminOrgID)
	_, _ = pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`, regularUserID, targetOrgID)

	// Create API token for targetOrg
	rawToken := "crm_test_" + time.Now().Format("150405.000000")
	_, err = pool.Exec(ctx, `
		INSERT INTO api_tokens (organization_id, user_id, name, token_hash)
		VALUES ($1, $2, 'test-token', $3)
	`, targetOrgID, regularUserID, auth.HashToken(rawToken))
	if err != nil {
		t.Fatalf("insert api token: %v", err)
	}

	adminJWT, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{
		UserID: adminUserID, OrganizationID: adminOrgID, Role: "admin", IsPlatformAdmin: true,
	}, time.Hour, false)
	regularJWT, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{
		UserID: regularUserID, OrganizationID: targetOrgID, Role: "admin", IsPlatformAdmin: false,
	}, time.Hour, false)

	// Build test router matching cmd/api/main.go separation of planes
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Route("/api/v1", func(r chi.Router) {
		r.Route("/admin", func(r chi.Router) {
			r.Use(mw.Authenticate)
			r.Use(mw.RequirePlatformAdmin)
			r.Get("/tenants", adm.ListTenants)
			r.Patch("/tenants/{id}", adm.UpdateTenantStatus)
			r.Post("/support-sessions", adm.StartSupportSession)
			r.Post("/support-sessions/{id}/end", adm.EndSupportSession)
			r.Get("/metrics", adm.GetMetrics)
		})
		r.Group(func(r chi.Router) {
			r.Use(mw.Authenticate)
			r.Use(mw.RequireTenantAccess)
			r.Get("/tenant/ping", func(w http.ResponseWriter, r *http.Request) {
				id, _ := auth.FromContext(r.Context())
				httpx.JSON(w, http.StatusOK, map[string]any{
					"org_id":          id.OrganizationID,
					"role":            id.Role,
					"support_sess_id": id.SupportSessID,
					"remote_ip":       id.RemoteIP,
				})
			})
			r.Post("/tenant/mutate", func(w http.ResponseWriter, r *http.Request) {
				httpx.JSON(w, http.StatusOK, map[string]string{"status": "mutated"})
			})
		})
	})

	doReq := func(method, path, token, supportSessID, orgHdr string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, path, &buf)
		req.RemoteAddr = "203.0.113.42:54321"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if supportSessID != "" {
			req.Header.Set("X-Support-Session-ID", supportSessID)
		}
		if orgHdr != "" {
			req.Header.Set("X-Organization-ID", orgHdr)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// 1. RequirePlatformAdmin rejects regular user and rejects api_token (even if owned by platform admin)
	if rec := doReq("GET", "/api/v1/admin/tenants", regularJWT, "", "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-platform-admin, got %d: %s", rec.Code, rec.Body.String())
	}
	adminAPIToken := "crm_pa_" + time.Now().Format("150405.000000")
	_, _ = pool.Exec(ctx, `
		INSERT INTO api_tokens (organization_id, user_id, name, token_hash)
		VALUES ($1, $2, 'pa-token', $3)
	`, adminOrgID, adminUserID, auth.HashToken(adminAPIToken))
	if rec := doReq("GET", "/api/v1/admin/tenants", adminAPIToken, "", "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 platform_admin_jwt_only for api_token on /admin/*, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Platform admin can suspend targetOrg
	rec := doReq("PATCH", "/api/v1/admin/tenants/"+targetOrgID, adminJWT, "", "", map[string]any{
		"is_suspended": true,
		"reason":       "Impago de factura",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 suspending tenant, got %d: %s", rec.Code, rec.Body.String())
	}

	// Verify audit log recorded suspension under targetOrgID with remote IP
	var auditAction, auditIP string
	err = pool.QueryRow(ctx, `
		SELECT action, COALESCE(ip_address, '') FROM api_audit_log
		WHERE organization_id = $1 AND action = 'tenant.suspend'
		ORDER BY created_at DESC LIMIT 1
	`, targetOrgID).Scan(&auditAction, &auditIP)
	if err != nil || auditIP != "203.0.113.42" {
		t.Fatalf("expected audit tenant.suspend with ip 203.0.113.42, got err=%v ip=%q", err, auditIP)
	}

	// 3. Suspended tenant is blocked via JWT and api_token (403 tenant_suspended)
	if rec := doReq("GET", "/api/v1/tenant/ping", regularJWT, "", "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 tenant_suspended for JWT, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec := doReq("GET", "/api/v1/tenant/ping", rawToken, "", "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 tenant_suspended for api_token, got %d: %s", rec.Code, rec.Body.String())
	}

	// 4. MCP HandleRPC also rejects suspended tenant
	mcpSrv := &mcpserver.Server{Pool: pool}
	mcpResp := mcpSrv.HandleRPC(ctx, targetOrgID, mcpserver.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "tools/list"})
	if mcpResp.Error == nil {
		t.Fatalf("expected MCP error for suspended tenant, got nil")
	}

	// 5. Validation on StartSupportSession: reason required, ttl_minutes <= 60
	if rec := doReq("POST", "/api/v1/admin/support-sessions", adminJWT, "", "", map[string]any{
		"target_organization_id": targetOrgID,
		"reason":                 "",
		"ttl_minutes":            60,
	}); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty reason, got %d", rec.Code)
	}
	if rec := doReq("POST", "/api/v1/admin/support-sessions", adminJWT, "", "", map[string]any{
		"target_organization_id": targetOrgID,
		"reason":                 "Diagnóstico",
		"ttl_minutes":            61,
	}); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ttl > 60, got %d", rec.Code)
	}

	// 6. Start support_readonly session for suspended targetOrg
	rec = doReq("POST", "/api/v1/admin/support-sessions", adminJWT, "", "", map[string]any{
		"target_organization_id": targetOrgID,
		"reason":                 "Diagnóstico de incidente",
		"mode":                   "support_readonly",
		"ttl_minutes":            60,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 starting support session, got %d: %s", rec.Code, rec.Body.String())
	}
	var sessPayload map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &sessPayload)
	sessID, _ := sessPayload["id"].(string)
	if sessID == "" {
		t.Fatalf("missing support session id")
	}

	// 7. X-Support-Session-ID rejected with api_token (403 support_session_jwt_only)
	if rec := doReq("GET", "/api/v1/tenant/ping", rawToken, sessID, "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for support session with api_token, got %d", rec.Code)
	}

	// 8. GET succeeds on suspended tenant under support_readonly, overrides X-Organization-ID, sets Role=admin
	rec = doReq("GET", "/api/v1/tenant/ping", adminJWT, sessID, adminOrgID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 reading suspended tenant in support_readonly, got %d: %s", rec.Code, rec.Body.String())
	}
	var pingRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &pingRes)
	if pingRes["org_id"] != targetOrgID || pingRes["role"] != "admin" || pingRes["support_sess_id"] != sessID {
		t.Fatalf("unexpected support identity: %+v", pingRes)
	}

	// Verify api_audit_log recorded support_session_id automatically via RequireTenantAccess
	var loggedSessID string
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(support_session_id::text, '') FROM api_audit_log
		WHERE organization_id = $1 AND action = 'support.read'
		ORDER BY created_at DESC LIMIT 1
	`, targetOrgID).Scan(&loggedSessID)
	if err != nil || loggedSessID != sessID {
		t.Fatalf("expected support_session_id=%s in api_audit_log for support.read, got err=%v val=%q", sessID, err, loggedSessID)
	}

	// 9. POST mutation is blocked in support_readonly (403 support_readonly)
	if rec := doReq("POST", "/api/v1/tenant/mutate", adminJWT, sessID, "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 support_readonly on POST, got %d: %s", rec.Code, rec.Body.String())
	}

	// 10. Suspend admin's own org too — /admin/* must still work without deadlock, even with X-Support-Session-ID header present!
	_, _ = pool.Exec(ctx, `UPDATE organizations SET is_suspended = true WHERE id = $1`, adminOrgID)
	rec = doReq("POST", "/api/v1/admin/support-sessions/"+sessID+"/end", adminJWT, sessID, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 ending support session without deadlock, got %d: %s", rec.Code, rec.Body.String())
	}

	// 11. After ending, X-Support-Session-ID is immediately rejected (403 support_session_invalid)
	if rec := doReq("GET", "/api/v1/tenant/ping", adminJWT, sessID, "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 after ending support session, got %d: %s", rec.Code, rec.Body.String())
	}
}
