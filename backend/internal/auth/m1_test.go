package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/automation"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/pquerna/otp/totp"
)

func TestPasswordResetTokenAndRecoveryCodes(t *testing.T) {
	secret := "test-secret-key-32-bytes-minimum!"
	pwHash, err := auth.HashPassword("InitialPass123!")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}

	resetTok, err := auth.IssuePasswordResetToken(secret, "user-123", pwHash, time.Hour)
	if err != nil {
		t.Fatalf("issue reset token: %v", err)
	}

	claims, err := auth.ParsePasswordResetToken(secret, resetTok)
	if err != nil {
		t.Fatalf("parse reset token: %v", err)
	}
	if claims.UserID != "user-123" || claims.Purpose != "password_reset" || claims.PWHashPrefix == "" {
		t.Fatalf("unexpected reset claims: %+v", claims)
	}

	// Reset token must not be accepted as an access token, and vice versa.
	if _, err := auth.ParseToken(secret, resetTok); err == nil {
		t.Fatalf("expected ParseToken to reject password reset token")
	}
	accessTok, _ := auth.IssueAccessToken(secret, auth.Identity{UserID: "user-123", OrganizationID: "org-1", Role: "admin"}, time.Hour, false)
	if _, err := auth.ParsePasswordResetToken(secret, accessTok); err == nil {
		t.Fatalf("expected ParsePasswordResetToken to reject access token")
	}

	// Expired reset token must fail.
	expiredTok, _ := auth.IssuePasswordResetToken(secret, "user-123", pwHash, -time.Minute)
	if _, err := auth.ParsePasswordResetToken(secret, expiredTok); err == nil {
		t.Fatalf("expected expired reset token to fail")
	}

	// Recovery codes generation & normalization.
	codes, err := auth.GenerateRecoveryCodes(8)
	if err != nil {
		t.Fatalf("generate recovery codes: %v", err)
	}
	if len(codes) != 8 {
		t.Fatalf("expected 8 recovery codes, got %d", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 9 || c[4] != '-' {
			t.Fatalf("unexpected recovery code format: %q", c)
		}
		if seen[c] {
			t.Fatalf("duplicate recovery code generated: %q", c)
		}
		seen[c] = true
		if norm := auth.NormalizeRecoveryCode("  " + strings.ToLower(c) + " "); norm != c {
			t.Fatalf("expected normalized %q, got %q", c, norm)
		}
	}
}

func newM1TestRouter(mw *auth.Middleware, h *auth.Handler, autoH *automation.Handler) *chi.Mux {
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/auth/signup", h.Signup)
		r.Post("/auth/login", h.Login)
		r.Post("/auth/forgot", h.ForgotPassword)
		r.Post("/auth/reset", h.ResetPassword)
		r.Post("/auth/mfa/verify", h.VerifyMFA)
		r.Get("/team/invites/{token}", h.InspectInvite)
		r.Post("/team/accept-invite", h.AcceptInvite)

		r.Group(func(r chi.Router) {
			r.Use(mw.Authenticate)
			r.Get("/auth/me", h.Me)
			r.Patch("/auth/me", h.UpdateMe)
		})

		r.Group(func(r chi.Router) {
			r.Use(mw.Authenticate)
			r.Use(mw.RequireTenantAccess)
			r.Use(mw.Idempotency)

			r.Post("/auth/mfa/setup", h.SetupMFA)
			r.Post("/auth/mfa/enable", h.EnableMFA)
			r.Post("/auth/mfa/recovery-codes", h.RegenerateRecoveryCodes)
			r.Post("/auth/mfa/disable", h.DisableMFA)

			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("admin"))
				r.Post("/api-tokens", h.CreateAPIToken)
				r.Delete("/api-tokens/{id}", h.RevokeAPIToken)
			})

			r.Get("/organization", h.GetOrganization)
			r.With(auth.RequireRole("admin")).Patch("/organization", h.UpdateOrganization)

			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Get("/team/invites", h.ListInvites)
				r.Post("/team/invites", h.CreateInvite)
				r.Delete("/team/invites/{id}", h.RevokeInvite)
			})
			r.Patch("/team/members/{id}", h.UpdateMember)
			r.With(auth.RequireRole("admin")).Delete("/team/members/{id}", h.RemoveMember)

			r.Post("/lgpd/requests", autoH.CreateLGPDRequest)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Post("/lgpd/requests/{id}/execute", autoH.ExecuteLGPDRequest)
				r.Post("/lgpd/requests/{id}/reject", autoH.RejectLGPDRequest)
			})
		})
	})
	return r
}

func doJSON(r http.Handler, method, path, token string, body any, headers ...[2]string) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for _, h := range headers {
		req.Header.Set(h[0], h[1])
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestM1_ForgotResetAndMe(t *testing.T) {
	mw, _, cleanup := connectTestDB(t)
	defer cleanup()

	cfg := config.Config{JWTSecret: mw.JWTSecret}
	h := &auth.Handler{Pool: mw.Pool, Cfg: cfg}
	autoH := &automation.Handler{Pool: mw.Pool}
	r := newM1TestRouter(mw, h, autoH)

	email := "m1-reset-" + time.Now().Format("150405.000000") + "@koracrm.dev"
	rec := doJSON(r, "POST", "/api/v1/auth/signup", "", map[string]any{
		"email": email, "password": "OldPassword123!", "full_name": "Reset User", "org_name": "Reset Org",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d %s", rec.Code, rec.Body.String())
	}
	var signupResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &signupResp)
	token := signupResp["access_token"].(string)
	user := signupResp["user"].(map[string]any)
	userID := user["id"].(string)
	orgID := user["organization_id"].(string)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, orgID)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)

	// Forgot password
	rec = doJSON(r, "POST", "/api/v1/auth/forgot", "", map[string]any{"email": email})
	if rec.Code != http.StatusOK {
		t.Fatalf("forgot failed: %d %s", rec.Code, rec.Body.String())
	}
	var forgotResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &forgotResp)
	resetToken, _ := forgotResp["reset_token"].(string)
	if resetToken == "" {
		t.Fatalf("expected reset_token in non-production env")
	}

	// Reset password
	rec = doJSON(r, "POST", "/api/v1/auth/reset", "", map[string]any{
		"token": resetToken, "new_password": "NewPassword456!",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("reset failed: %d %s", rec.Code, rec.Body.String())
	}

	// Single-use: reusing reset token must fail
	rec = doJSON(r, "POST", "/api/v1/auth/reset", "", map[string]any{
		"token": resetToken, "new_password": "AnotherPassword789!",
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 reusing reset token, got %d", rec.Code)
	}

	// Old password fails, new password succeeds
	if rec := doJSON(r, "POST", "/api/v1/auth/login", "", map[string]any{"email": email, "password": "OldPassword123!"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for old password, got %d", rec.Code)
	}
	if rec := doJSON(r, "POST", "/api/v1/auth/login", "", map[string]any{"email": email, "password": "NewPassword456!"}); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for new password, got %d: %s", rec.Code, rec.Body.String())
	}

	// GET /auth/me includes organizations
	rec = doJSON(r, "GET", "/api/v1/auth/me", token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("me failed: %d %s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &meResp)
	orgs, ok := meResp["organizations"].([]any)
	if !ok || len(orgs) == 0 {
		t.Fatalf("expected organizations list in /auth/me, got %+v", meResp)
	}

	// PATCH /auth/me updates full_name and password
	rec = doJSON(r, "PATCH", "/api/v1/auth/me", token, map[string]any{
		"full_name": "Updated Name", "current_password": "NewPassword456!", "new_password": "UpdatedPass789!",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("patch me failed: %d %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &meResp)
	if meResp["full_name"] != "Updated Name" {
		t.Fatalf("expected updated full_name, got %v", meResp["full_name"])
	}
}

func TestM1_MFARecoveryAndDisable(t *testing.T) {
	mw, _, cleanup := connectTestDB(t)
	defer cleanup()

	cfg := config.Config{JWTSecret: mw.JWTSecret}
	h := &auth.Handler{Pool: mw.Pool, Cfg: cfg}
	autoH := &automation.Handler{Pool: mw.Pool}
	r := newM1TestRouter(mw, h, autoH)

	email := "m1-mfa-" + time.Now().Format("150405.000000") + "@koracrm.dev"
	rec := doJSON(r, "POST", "/api/v1/auth/signup", "", map[string]any{
		"email": email, "password": "MfaPassword123!", "full_name": "MFA User", "org_name": "MFA Org",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d %s", rec.Code, rec.Body.String())
	}
	var signupResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &signupResp)
	token := signupResp["access_token"].(string)
	user := signupResp["user"].(map[string]any)
	userID := user["id"].(string)
	orgID := user["organization_id"].(string)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, orgID)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)

	// Setup MFA
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/setup", token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("mfa setup failed: %d", rec.Code)
	}
	var setupResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &setupResp)
	secret := setupResp["secret"].(string)

	totpCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp: %v", err)
	}

	// Enable MFA -> returns 8 recovery codes
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/enable", token, map[string]any{"code": totpCode})
	if rec.Code != http.StatusOK {
		t.Fatalf("mfa enable failed: %d %s", rec.Code, rec.Body.String())
	}
	var enableResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &enableResp)
	codesRaw := enableResp["recovery_codes"].([]any)
	if len(codesRaw) != 8 {
		t.Fatalf("expected 8 recovery codes, got %d", len(codesRaw))
	}
	firstCode := codesRaw[0].(string)

	// Login -> mfa_required
	rec = doJSON(r, "POST", "/api/v1/auth/login", "", map[string]any{"email": email, "password": "MfaPassword123!"})
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d", rec.Code)
	}
	var loginResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &loginResp)
	mfaToken := loginResp["mfa_token"].(string)

	// Verify MFA with recovery code -> succeeds
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/verify", "", map[string]any{
		"mfa_token": mfaToken, "recovery_code": firstCode,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("verify mfa with recovery code failed: %d %s", rec.Code, rec.Body.String())
	}

	// Second use of same recovery code -> fails
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/verify", "", map[string]any{
		"mfa_token": mfaToken, "recovery_code": firstCode,
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on reused recovery code, got %d", rec.Code)
	}

	// Regenerate recovery codes
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/recovery-codes", token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("regenerate recovery codes failed: %d %s", rec.Code, rec.Body.String())
	}
	var regenResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &regenResp)
	newCodes := regenResp["recovery_codes"].([]any)
	if len(newCodes) != 8 {
		t.Fatalf("expected 8 regenerated codes, got %d", len(newCodes))
	}

	// Old unused code no longer works
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/verify", "", map[string]any{
		"mfa_token": mfaToken, "recovery_code": codesRaw[1].(string),
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for replaced recovery code, got %d", rec.Code)
	}

	// Disable MFA
	rec = doJSON(r, "POST", "/api/v1/auth/mfa/disable", token, map[string]any{"password": "MfaPassword123!"})
	if rec.Code != http.StatusOK {
		t.Fatalf("disable mfa failed: %d %s", rec.Code, rec.Body.String())
	}
}

func TestM1_TeamInvitesMembersAndOrg(t *testing.T) {
	mw, _, cleanup := connectTestDB(t)
	defer cleanup()

	cfg := config.Config{JWTSecret: mw.JWTSecret}
	h := &auth.Handler{Pool: mw.Pool, Cfg: cfg}
	autoH := &automation.Handler{Pool: mw.Pool}
	r := newM1TestRouter(mw, h, autoH)

	adminEmail := "m1-admin-" + time.Now().Format("150405.000000") + "@koracrm.dev"
	rec := doJSON(r, "POST", "/api/v1/auth/signup", "", map[string]any{
		"email": adminEmail, "password": "AdminPass123!", "full_name": "Org Admin", "org_name": "Team Org",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d %s", rec.Code, rec.Body.String())
	}
	var signupResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &signupResp)
	adminToken := signupResp["access_token"].(string)
	adminUser := signupResp["user"].(map[string]any)
	adminID := adminUser["id"].(string)
	orgID := adminUser["organization_id"].(string)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, orgID)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, adminID)

	// Admin creates invite for agent
	agentEmail := "m1-agent-" + time.Now().Format("150405.000000") + "@koracrm.dev"
	rec = doJSON(r, "POST", "/api/v1/team/invites", adminToken, map[string]any{
		"email": agentEmail, "role": "agent",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create invite failed: %d %s", rec.Code, rec.Body.String())
	}
	var invResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &invResp)
	rawInviteTok := invResp["token"].(string)

	// Public inspect invite
	rec = doJSON(r, "GET", "/api/v1/team/invites/"+rawInviteTok, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("inspect invite failed: %d %s", rec.Code, rec.Body.String())
	}
	var inspectResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &inspectResp)
	if inspectResp["valid"] != true || inspectResp["email"] != agentEmail {
		t.Fatalf("unexpected inspect response: %+v", inspectResp)
	}

	// Accept invite
	rec = doJSON(r, "POST", "/api/v1/team/accept-invite", "", map[string]any{
		"token": rawInviteTok, "full_name": "Agent User", "password": "AgentPassword123!",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("accept invite failed: %d %s", rec.Code, rec.Body.String())
	}
	var accResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &accResp)
	agentToken := accResp["access_token"].(string)
	agentID := accResp["user"].(map[string]any)["id"].(string)
	defer mw.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, agentID)

	// RBAC: agent cannot invite or patch org or create api-token
	if rec := doJSON(r, "POST", "/api/v1/team/invites", agentToken, map[string]any{"email": "x@y.com", "role": "agent"}); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for agent creating invite, got %d", rec.Code)
	}
	if rec := doJSON(r, "PATCH", "/api/v1/organization", agentToken, map[string]any{"name": "Hacked"}); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for agent patching org, got %d", rec.Code)
	}
	if rec := doJSON(r, "POST", "/api/v1/api-tokens", agentToken, map[string]any{"name": "hack"}); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for agent creating api token, got %d", rec.Code)
	}

	// Agent can update own availability, but not admin's
	if rec := doJSON(r, "PATCH", "/api/v1/team/members/"+agentID, agentToken, map[string]any{"is_available": false}); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for self availability update, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec := doJSON(r, "PATCH", "/api/v1/team/members/"+adminID, agentToken, map[string]any{"is_available": false}); rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for agent updating another member, got %d", rec.Code)
	}

	// Last admin protection
	if rec := doJSON(r, "DELETE", "/api/v1/team/members/"+adminID, adminToken, nil); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 removing last admin, got %d: %s", rec.Code, rec.Body.String())
	}

	// Admin can remove agent
	if rec := doJSON(r, "DELETE", "/api/v1/team/members/"+agentID, adminToken, nil); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 removing agent, got %d: %s", rec.Code, rec.Body.String())
	}

	// Admin updates organization settings (JSONB merge)
	rec = doJSON(r, "PATCH", "/api/v1/organization", adminToken, map[string]any{
		"name":     "Updated Team Org",
		"settings": map[string]any{"onboarding_completed": true, "onboarding_step": 4},
		"branding": map[string]any{"primary_color": "#0f766e"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("patch org failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = doJSON(r, "PATCH", "/api/v1/organization", adminToken, map[string]any{
		"settings": map[string]any{"pipeline_vocabulary": map[string]string{"deal": "Caso"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("second patch org failed: %d %s", rec.Code, rec.Body.String())
	}
	var orgResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &orgResp)
	settingsMap := orgResp["settings"].(map[string]any)
	if settingsMap["onboarding_completed"] != true || settingsMap["pipeline_vocabulary"] == nil {
		t.Fatalf("expected JSONB merge to preserve onboarding_completed, got %+v", settingsMap)
	}
}

func TestM1_IdempotencyMiddleware(t *testing.T) {
	mw, _, cleanup := connectTestDB(t)
	defer cleanup()

	ctx := context.Background()
	var orgID, userID string
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Idemp Org', 'idemp-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	defer mw.Pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('idemp-' || substr(md5(random()::text),1,6) || '@koracrm.dev', 'h', 'Idemp') RETURNING id`).Scan(&userID)
	defer mw.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	_, _ = mw.Pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`, userID, orgID)

	tok, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{UserID: userID, OrganizationID: orgID, Role: "admin"}, time.Hour, false)

	var hits int32
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(mw.Authenticate)
		r.Use(mw.RequireTenantAccess)
		r.Use(mw.Idempotency)
		r.Post("/api/v1/test-idemp", func(w http.ResponseWriter, r *http.Request) {
			n := atomic.AddInt32(&hits, 1)
			httpx.JSON(w, http.StatusCreated, map[string]any{"hit": n})
		})
	})

	rec1 := doJSON(r, "POST", "/api/v1/test-idemp", tok, map[string]any{"a": 1}, [2]string{"Idempotency-Key", "key-abc-123"})
	if rec1.Code != http.StatusCreated || rec1.Header().Get("X-Idempotency-Replayed") != "" {
		t.Fatalf("unexpected first response: code=%d hdr=%q body=%s", rec1.Code, rec1.Header().Get("X-Idempotency-Replayed"), rec1.Body.String())
	}

	rec2 := doJSON(r, "POST", "/api/v1/test-idemp", tok, map[string]any{"a": 1}, [2]string{"Idempotency-Key", "key-abc-123"})
	if rec2.Code != http.StatusCreated || rec2.Header().Get("X-Idempotency-Replayed") != "true" {
		t.Fatalf("expected replayed response, got code=%d hdr=%q body=%s", rec2.Code, rec2.Header().Get("X-Idempotency-Replayed"), rec2.Body.String())
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("expected handler to execute exactly once, got %d", hits)
	}
}

func TestM1_SecurityAndConcurrencyFixes(t *testing.T) {
	mw, _, cleanup := connectTestDB(t)
	defer cleanup()

	cfg := config.Config{JWTSecret: mw.JWTSecret}
	h := &auth.Handler{Pool: mw.Pool, Cfg: cfg}
	autoH := &automation.Handler{Pool: mw.Pool}
	r := newM1TestRouter(mw, h, autoH)

	ctx := context.Background()
	var orgID, otherOrgID, admin1ID, admin2ID, managerID, contactID, otherContactID string
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Sec Org', 'sec-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	defer mw.Pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Other Org', 'oth-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&otherOrgID)
	defer mw.Pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, otherOrgID)

	_ = mw.Pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('sec-a1-' || substr(md5(random()::text),1,6) || '@koracrm.dev', 'h', 'A1') RETURNING id`).Scan(&admin1ID)
	defer mw.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, admin1ID)
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('sec-a2-' || substr(md5(random()::text),1,6) || '@koracrm.dev', 'h', 'A2') RETURNING id`).Scan(&admin2ID)
	defer mw.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, admin2ID)
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('sec-mgr-' || substr(md5(random()::text),1,6) || '@koracrm.dev', 'h', 'Mgr') RETURNING id`).Scan(&managerID)
	defer mw.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, managerID)

	_, _ = mw.Pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`, admin1ID, orgID)
	_, _ = mw.Pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`, admin2ID, orgID)
	_, _ = mw.Pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'manager')`, managerID, orgID)

	_ = mw.Pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name) VALUES ($1, 'Own Contact') RETURNING id`, orgID).Scan(&contactID)
	_ = mw.Pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name) VALUES ($1, 'Other Contact') RETURNING id`, otherOrgID).Scan(&otherContactID)

	admin1Tok, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{UserID: admin1ID, OrganizationID: orgID, Role: "admin"}, time.Hour, false)
	admin2Tok, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{UserID: admin2ID, OrganizationID: orgID, Role: "admin"}, time.Hour, false)
	mgrTok, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{UserID: managerID, OrganizationID: orgID, Role: "manager"}, time.Hour, false)

	// 1. Manager cannot invite admin (403 insufficient role), but can invite agent (201)
	rec := doJSON(r, "POST", "/api/v1/team/invites", mgrTok, map[string]any{"email": "esc@koracrm.dev", "role": "admin"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for manager inviting admin, got %d: %s", rec.Code, rec.Body.String())
	}
	rec = doJSON(r, "POST", "/api/v1/team/invites", mgrTok, map[string]any{"email": "ok-agent@koracrm.dev", "role": "agent"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for manager inviting agent, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. CreateLGPDRequest validation & tenant check
	if rec := doJSON(r, "POST", "/api/v1/lgpd/requests", admin1Tok, map[string]any{"contact_id": contactID, "request_type": "delete_all"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid request_type, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec := doJSON(r, "POST", "/api/v1/lgpd/requests", admin1Tok, map[string]any{"contact_id": otherContactID, "request_type": "export"}); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-tenant contact_id, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec := doJSON(r, "POST", "/api/v1/lgpd/requests", admin1Tok, map[string]any{"contact_id": contactID, "request_type": "export"}); rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for valid lgpd request, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. Idempotency: concurrent in-flight 409 + 5xx cleanup
	started := make(chan struct{})
	release := make(chan struct{})
	var failNext atomic.Bool
	failNext.Store(true)
	idempRouter := chi.NewRouter()
	idempRouter.Group(func(r chi.Router) {
		r.Use(mw.Authenticate)
		r.Use(mw.RequireTenantAccess)
		r.Use(mw.Idempotency)
		r.Post("/api/v1/slow", func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-release
			httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true})
		})
		r.Post("/api/v1/flaky", func(w http.ResponseWriter, r *http.Request) {
			if failNext.Swap(false) {
				httpx.Error(w, http.StatusInternalServerError, "boom")
				return
			}
			httpx.JSON(w, http.StatusCreated, map[string]any{"recovered": true})
		})
	})

	var wg sync.WaitGroup
	wg.Add(1)
	var slowCode int
	go func() {
		defer wg.Done()
		slowCode = doJSON(idempRouter, "POST", "/api/v1/slow", admin1Tok, map[string]any{}, [2]string{"Idempotency-Key", "inflight-1"}).Code
	}()
	<-started
	conflictRec := doJSON(idempRouter, "POST", "/api/v1/slow", admin1Tok, map[string]any{}, [2]string{"Idempotency-Key", "inflight-1"})
	close(release)
	wg.Wait()
	if slowCode != http.StatusCreated || conflictRec.Code != http.StatusConflict {
		t.Fatalf("expected 201 and 409 for concurrent idempotency, got %d and %d (%s)", slowCode, conflictRec.Code, conflictRec.Body.String())
	}

	if rec := doJSON(idempRouter, "POST", "/api/v1/flaky", admin1Tok, map[string]any{}, [2]string{"Idempotency-Key", "flaky-1"}); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on first flaky call, got %d", rec.Code)
	}
	if rec := doJSON(idempRouter, "POST", "/api/v1/flaky", admin1Tok, map[string]any{}, [2]string{"Idempotency-Key", "flaky-1"}); rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 after 500 cleanup, got %d: %s", rec.Code, rec.Body.String())
	}

	// 4. VerifyMFA concurrent recovery code double-use
	codes, _ := auth.GenerateRecoveryCodes(1)
	_, _ = mw.Pool.Exec(ctx, `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, admin1ID, auth.HashToken(codes[0]))
	mfaTok, _ := auth.IssueAccessToken(mw.JWTSecret, auth.Identity{UserID: admin1ID, OrganizationID: orgID, Role: "admin"}, 5*time.Minute, true)
	var mfaOK, mfaFail int32
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			res := doJSON(r, "POST", "/api/v1/auth/mfa/verify", "", map[string]any{"mfa_token": mfaTok, "recovery_code": codes[0]})
			if res.Code == http.StatusOK {
				atomic.AddInt32(&mfaOK, 1)
			} else if res.Code == http.StatusUnauthorized {
				atomic.AddInt32(&mfaFail, 1)
			}
		}()
	}
	wg.Wait()
	if mfaOK != 1 || mfaFail != 1 {
		t.Fatalf("expected 1 OK and 1 Unauthorized for concurrent recovery code use, got ok=%d fail=%d", mfaOK, mfaFail)
	}

	// 5. Concurrent last-admin safety (2 admins concurrently removing/demoting each other)
	var remOK, remConflict int32
	wg.Add(2)
	go func() {
		defer wg.Done()
		res := doJSON(r, "DELETE", "/api/v1/team/members/"+admin2ID, admin1Tok, nil)
		if res.Code == http.StatusOK {
			atomic.AddInt32(&remOK, 1)
		} else if res.Code == http.StatusConflict {
			atomic.AddInt32(&remConflict, 1)
		}
	}()
	go func() {
		defer wg.Done()
		res := doJSON(r, "PATCH", "/api/v1/team/members/"+admin1ID, admin2Tok, map[string]any{"role": "agent"})
		if res.Code == http.StatusOK {
			atomic.AddInt32(&remOK, 1)
		} else if res.Code == http.StatusConflict {
			atomic.AddInt32(&remConflict, 1)
		}
	}()
	wg.Wait()
	if remOK != 1 || remConflict != 1 {
		t.Fatalf("expected 1 OK and 1 Conflict for concurrent last-admin removal/demotion, got ok=%d conflict=%d", remOK, remConflict)
	}
}
