package auth

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"
)

type Handler struct {
	Pool *pgxpool.Pool
	Cfg  config.Config
}

func (h *Handler) Signup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		FullName string `json:"full_name"`
		OrgName  string `json:"org_name"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || len(req.Password) < 6 || req.OrgName == "" {
		httpx.Error(w, http.StatusBadRequest, "email, password (>=6), and org_name are required")
		return
	}
	if req.FullName == "" {
		req.FullName = strings.Split(req.Email, "@")[0]
	}

	hash, err := HashPassword(req.Password)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var userID, orgID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO users (email, password_hash, full_name)
		VALUES ($1, $2, $3)
		RETURNING id
	`, req.Email, hash, req.FullName).Scan(&userID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "email already registered")
		return
	}

	slug := strings.ToLower(strings.ReplaceAll(req.OrgName, " ", "-")) + "-" + uuid.NewString()[:6]
	err = tx.QueryRow(r.Context(), `
		INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id
	`, req.OrgName, slug).Scan(&orgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create organization")
		return
	}

	_, err = tx.Exec(r.Context(), `
		INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')
	`, userID, orgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to link membership")
		return
	}

	// Default Sales Pipeline & Stages
	var salesPipeID string
	_ = tx.QueryRow(r.Context(), `
		INSERT INTO crm_pipelines (organization_id, name, pipeline_type, is_default)
		VALUES ($1, 'Embudo de Ventas', 'sales', true) RETURNING id
	`, orgID).Scan(&salesPipeID)
	_, _ = tx.Exec(r.Context(), `
		INSERT INTO crm_stages (organization_id, pipeline_id, name, position, color, is_won, is_lost, requires_human) VALUES
		($1, $2, 'Nuevo Lead', 1000, '#0f766e', false, false, false),
		($1, $2, 'Calificado', 2000, '#2563eb', false, false, false),
		($1, $2, 'Propuesta', 3000, '#d97706', false, false, true),
		($1, $2, 'Ganado', 4000, '#15803d', true, false, false),
		($1, $2, 'Perdido', 5000, '#b91c1c', false, true, false)
	`, orgID, salesPipeID)

	// Default Support Pipeline
	var suppPipeID string
	_ = tx.QueryRow(r.Context(), `
		INSERT INTO crm_pipelines (organization_id, name, pipeline_type, vocabulary, is_default)
		VALUES ($1, 'Tickets de Soporte', 'support', '{"deal":"Ticket","deals":"Tickets","stage":"Estado"}', false) RETURNING id
	`, orgID).Scan(&suppPipeID)
	_, _ = tx.Exec(r.Context(), `
		INSERT INTO crm_stages (organization_id, pipeline_id, name, position, color, is_won, is_lost) VALUES
		($1, $2, 'Abierto', 1000, '#0f766e', false, false),
		($1, $2, 'En Progreso', 2000, '#2563eb', false, false),
		($1, $2, 'Resuelto', 3000, '#15803d', true, false)
	`, orgID, suppPipeID)

	// Default AI Agent & Budget
	_, _ = tx.Exec(r.Context(), `
		INSERT INTO ai_agents (organization_id, name, system_prompt)
		VALUES ($1, 'Asistente de Ventas', 'Eres un asistente útil de ventas y soporte por WhatsApp. Sé conciso, amable y escala a un humano si tienes dudas.')
	`, orgID)
	_, _ = tx.Exec(r.Context(), `INSERT INTO ai_budgets (organization_id) VALUES ($1)`, orgID)

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	id := Identity{UserID: userID, OrganizationID: orgID, Role: "admin"}
	access, _ := IssueAccessToken(h.Cfg.JWTSecret, id, 24*time.Hour, false)
	h.setRefreshCookie(w, r, userID)

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"access_token": access,
		"user": map[string]any{
			"id": userID, "email": req.Email, "full_name": req.FullName,
			"organization_id": orgID, "org_name": req.OrgName, "role": "admin",
		},
	})
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	var userID, pwHash, fullName, orgID, orgName, role string
	var mfaEnabled, isPlatformAdmin bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT u.id, u.password_hash, u.full_name, u.mfa_enabled, u.is_platform_admin,
		       uo.organization_id, o.name, uo.role
		FROM users u
		JOIN user_organizations uo ON uo.user_id = u.id
		JOIN organizations o ON o.id = uo.organization_id
		WHERE u.email = $1
		ORDER BY uo.created_at ASC LIMIT 1
	`, req.Email).Scan(&userID, &pwHash, &fullName, &mfaEnabled, &isPlatformAdmin, &orgID, &orgName, &role)
	if err != nil || !CheckPassword(pwHash, req.Password) {
		httpx.Error(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	id := Identity{UserID: userID, OrganizationID: orgID, Role: role, IsPlatformAdmin: isPlatformAdmin}
	if mfaEnabled {
		mfaToken, _ := IssueAccessToken(h.Cfg.JWTSecret, id, 5*time.Minute, true)
		httpx.JSON(w, http.StatusOK, map[string]any{
			"mfa_required": true,
			"mfa_token":    mfaToken,
		})
		return
	}

	access, _ := IssueAccessToken(h.Cfg.JWTSecret, id, 24*time.Hour, false)
	h.setRefreshCookie(w, r, userID)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": access,
		"user": map[string]any{
			"id": userID, "email": req.Email, "full_name": fullName,
			"organization_id": orgID, "org_name": orgName, "role": role,
			"mfa_enabled": mfaEnabled, "is_platform_admin": isPlatformAdmin,
		},
	})
}

func (h *Handler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	resp := map[string]any{
		"ok":      true,
		"message": "Si el correo existe, recibirás instrucciones para restablecer tu contraseña.",
	}
	if email != "" {
		var userID, pwHash string
		err := h.Pool.QueryRow(r.Context(), `SELECT id, password_hash FROM users WHERE email = $1`, email).Scan(&userID, &pwHash)
		if err == nil {
			if tok, err := IssuePasswordResetToken(h.Cfg.JWTSecret, userID, pwHash, time.Hour); err == nil {
				if os.Getenv("ENV") != "production" && os.Getenv("APP_ENV") != "production" {
					resp["reset_token"] = tok
				}
			}
		}
	}
	httpx.JSON(w, http.StatusOK, resp)
}

func (h *Handler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(req.Token) == "" || len(req.NewPassword) < 8 {
		httpx.Error(w, http.StatusBadRequest, "token and new_password (>=8) are required")
		return
	}
	claims, err := ParsePasswordResetToken(h.Cfg.JWTSecret, req.Token)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid or expired reset token")
		return
	}
	var currentHash string
	err = h.Pool.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id = $1`, claims.UserID).Scan(&currentHash)
	if err != nil || passwordHashPrefix(currentHash) != claims.PWHashPrefix {
		httpx.Error(w, http.StatusUnauthorized, "invalid or expired reset token")
		return
	}
	newHash, err := HashPassword(req.NewPassword)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, newHash, claims.UserID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to update password")
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, claims.UserID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to revoke sessions")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "status": "password_reset"})
}

func (h *Handler) VerifyMFA(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MFAToken     string `json:"mfa_token"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recovery_code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	claims, err := ParseToken(h.Cfg.JWTSecret, req.MFAToken)
	if err != nil || !claims.MfaPending {
		httpx.Error(w, http.StatusUnauthorized, "invalid mfa token")
		return
	}
	var secret, email, fullName, orgName string
	var mfaEnabled, isPlatformAdmin bool
	err = h.Pool.QueryRow(r.Context(), `
		SELECT COALESCE(u.mfa_secret, ''), u.email, u.full_name, u.mfa_enabled, u.is_platform_admin, o.name
		FROM users u
		JOIN organizations o ON o.id = $2
		WHERE u.id = $1
	`, claims.UserID, claims.OrganizationID).Scan(&secret, &email, &fullName, &mfaEnabled, &isPlatformAdmin, &orgName)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid mfa token")
		return
	}

	recoveryInput := strings.TrimSpace(req.RecoveryCode)
	if recoveryInput == "" && (len(strings.TrimSpace(req.Code)) > 6 || strings.Contains(req.Code, "-")) {
		recoveryInput = strings.TrimSpace(req.Code)
	}
	if recoveryInput != "" {
		norm := NormalizeRecoveryCode(recoveryInput)
		codeHash := HashToken(norm)
		var rcID string
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE user_recovery_codes
			SET used_at = now()
			WHERE id = (
				SELECT id FROM user_recovery_codes
				WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
				LIMIT 1
			)
			  AND used_at IS NULL
			RETURNING id
		`, claims.UserID, codeHash).Scan(&rcID)
		if err != nil {
			httpx.Error(w, http.StatusUnauthorized, "invalid or used recovery code")
			return
		}
	} else if !totp.Validate(req.Code, secret) {
		httpx.Error(w, http.StatusUnauthorized, "invalid totp code")
		return
	}

	id := Identity{UserID: claims.UserID, OrganizationID: claims.OrganizationID, Role: claims.Role, IsPlatformAdmin: isPlatformAdmin}
	access, _ := IssueAccessToken(h.Cfg.JWTSecret, id, 24*time.Hour, false)
	h.setRefreshCookie(w, r, claims.UserID)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": access,
		"user": map[string]any{
			"id": claims.UserID, "email": email, "full_name": fullName,
			"organization_id": claims.OrganizationID, "org_name": orgName, "role": claims.Role,
			"mfa_enabled": mfaEnabled, "is_platform_admin": isPlatformAdmin,
		},
	})
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie("crm_refresh")
	if err != nil || c.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "missing refresh cookie")
		return
	}
	hash := HashToken(c.Value)
	var userID, orgID, role string
	var isPA bool
	err = h.Pool.QueryRow(r.Context(), `
		SELECT rt.user_id, uo.organization_id, uo.role, u.is_platform_admin
		FROM refresh_tokens rt
		JOIN users u ON u.id = rt.user_id
		JOIN user_organizations uo ON uo.user_id = u.id
		WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()
		LIMIT 1
	`, hash).Scan(&userID, &orgID, &role, &isPA)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	id := Identity{UserID: userID, OrganizationID: orgID, Role: role, IsPlatformAdmin: isPA}
	access, _ := IssueAccessToken(h.Cfg.JWTSecret, id, 24*time.Hour, false)
	httpx.JSON(w, http.StatusOK, map[string]any{"access_token": access})
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("crm_refresh"); err == nil && c.Value != "" {
		_, _ = h.Pool.Exec(r.Context(), `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, HashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{
		Name: "crm_refresh", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var email, fullName, avatarURL, orgName string
	var mfaEnabled, isPlatformAdmin bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT u.email, u.full_name, COALESCE(u.avatar_url, ''), u.mfa_enabled, u.is_platform_admin, o.name
		FROM users u, organizations o
		WHERE u.id = $1 AND o.id = $2
	`, id.UserID, id.OrganizationID).Scan(&email, &fullName, &avatarURL, &mfaEnabled, &isPlatformAdmin, &orgName)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}

	orgs := []map[string]any{}
	rows, err := h.Pool.Query(r.Context(), `
		SELECT o.id, o.name, o.slug, uo.role
		FROM user_organizations uo
		JOIN organizations o ON o.id = uo.organization_id
		WHERE uo.user_id = $1
		ORDER BY uo.created_at ASC
	`, id.UserID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var oid, oname, oslug, orole string
			if scanErr := rows.Scan(&oid, &oname, &oslug, &orole); scanErr == nil {
				orgs = append(orgs, map[string]any{
					"id": oid, "name": oname, "slug": oslug, "role": orole,
				})
			}
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": id.UserID, "email": email, "full_name": fullName, "avatar_url": avatarURL,
		"organization_id": id.OrganizationID, "org_name": orgName,
		"role": id.Role, "mfa_enabled": mfaEnabled, "is_platform_admin": isPlatformAdmin,
		"organizations": orgs,
	})
}

func (h *Handler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		FullName        *string `json:"full_name"`
		AvatarURL       *string `json:"avatar_url"`
		CurrentPassword string  `json:"current_password"`
		NewPassword     string  `json:"new_password"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	if req.NewPassword != "" {
		if len(req.NewPassword) < 8 || req.CurrentPassword == "" {
			httpx.Error(w, http.StatusBadRequest, "current_password and new_password (>=8) are required")
			return
		}
		var currentHash string
		if err := h.Pool.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id = $1`, id.UserID).Scan(&currentHash); err != nil || !CheckPassword(currentHash, req.CurrentPassword) {
			httpx.Error(w, http.StatusUnauthorized, "invalid current password")
			return
		}
		newHash, err := HashPassword(req.NewPassword)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to hash password")
			return
		}
		if _, err := h.Pool.Exec(r.Context(), `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, newHash, id.UserID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to update password")
			return
		}
	}

	if req.FullName != nil {
		name := strings.TrimSpace(*req.FullName)
		if name == "" {
			httpx.Error(w, http.StatusBadRequest, "full_name cannot be empty")
			return
		}
		if _, err := h.Pool.Exec(r.Context(), `UPDATE users SET full_name = $1, updated_at = now() WHERE id = $2`, name, id.UserID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to update full_name")
			return
		}
	}

	if req.AvatarURL != nil {
		avatar := strings.TrimSpace(*req.AvatarURL)
		if _, err := h.Pool.Exec(r.Context(), `UPDATE users SET avatar_url = NULLIF($1, ''), updated_at = now() WHERE id = $2`, avatar, id.UserID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to update avatar_url")
			return
		}
	}

	h.Me(w, r)
}

func (h *Handler) SetupMFA(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var email string
	_ = h.Pool.QueryRow(r.Context(), `SELECT email FROM users WHERE id = $1`, id.UserID).Scan(&email)
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "KoraCRM", AccountName: email})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to generate totp")
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `UPDATE users SET mfa_secret = $1 WHERE id = $2`, key.Secret(), id.UserID)
	httpx.JSON(w, http.StatusOK, map[string]any{"secret": key.Secret(), "otpauth_url": key.URL()})
}

func (h *Handler) replaceRecoveryCodes(r *http.Request, userID string) ([]string, error) {
	codes, err := GenerateRecoveryCodes(8)
	if err != nil {
		return nil, err
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `DELETE FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
		return nil, err
	}
	for _, c := range codes {
		if _, err := tx.Exec(r.Context(), `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, userID, HashToken(c)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	return codes, nil
}

func (h *Handler) EnableMFA(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		Code string `json:"code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var secret string
	_ = h.Pool.QueryRow(r.Context(), `SELECT COALESCE(mfa_secret, '') FROM users WHERE id = $1`, id.UserID).Scan(&secret)
	if !totp.Validate(req.Code, secret) {
		httpx.Error(w, http.StatusBadRequest, "invalid totp code")
		return
	}
	if _, err := h.Pool.Exec(r.Context(), `UPDATE users SET mfa_enabled = true, updated_at = now() WHERE id = $1`, id.UserID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	codes, err := h.replaceRecoveryCodes(r, id.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to generate recovery codes")
		return
	}
	_ = WriteAudit(r.Context(), h.Pool, id, "mfa.enable", "user", id.UserID, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]any{"enabled": true, "mfa_enabled": true, "recovery_codes": codes})
}

func (h *Handler) RegenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var mfaEnabled bool
	if err := h.Pool.QueryRow(r.Context(), `SELECT mfa_enabled FROM users WHERE id = $1`, id.UserID).Scan(&mfaEnabled); err != nil || !mfaEnabled {
		httpx.Error(w, http.StatusBadRequest, "mfa is not enabled")
		return
	}
	codes, err := h.replaceRecoveryCodes(r, id.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to generate recovery codes")
		return
	}
	_ = WriteAudit(r.Context(), h.Pool, id, "mfa.recovery_codes.regenerate", "user", id.UserID, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]any{"recovery_codes": codes})
}

func (h *Handler) DisableMFA(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var pwHash, secret string
	if err := h.Pool.QueryRow(r.Context(), `SELECT password_hash, COALESCE(mfa_secret, '') FROM users WHERE id = $1`, id.UserID).Scan(&pwHash, &secret); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	validPW := req.Password != "" && CheckPassword(pwHash, req.Password)
	validCode := req.Code != "" && secret != "" && totp.Validate(req.Code, secret)
	if !validPW && !validCode {
		httpx.Error(w, http.StatusUnauthorized, "invalid password or totp code")
		return
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `UPDATE users SET mfa_enabled = false, mfa_secret = NULL, updated_at = now() WHERE id = $1`, id.UserID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, id.UserID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}
	_ = WriteAudit(r.Context(), h.Pool, id, "mfa.disable", "user", id.UserID, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]any{"enabled": false, "mfa_enabled": false})
}

func (h *Handler) ListAPITokens(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, scopes, last_used_at, created_at
		FROM api_tokens WHERE organization_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tid, name string
		var scopes []string
		var lastUsed, created any
		_ = rows.Scan(&tid, &name, &scopes, &lastUsed, &created)
		out = append(out, map[string]any{"id": tid, "name": name, "scopes": scopes, "last_used_at": lastUsed, "created_at": created})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateAPIToken(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		Name string `json:"name"`
	}
	req.Name = strings.TrimSpace(req.Name)
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	raw, _ := RandomToken(24)
	full := "crm_" + raw
	var tid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO api_tokens (organization_id, user_id, name, token_hash)
		VALUES ($1, $2, $3, $4) RETURNING id
	`, id.OrganizationID, id.UserID, req.Name, HashToken(full)).Scan(&tid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	WriteAudit(r.Context(), h.Pool, id, "api_token.create", "api_token", tid, map[string]any{"name": req.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": tid, "name": req.Name, "token": full})
}

func (h *Handler) RevokeAPIToken(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	tid := chi.URLParam(r, "id")
	_, _ = h.Pool.Exec(r.Context(), `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND organization_id = $2`, tid, id.OrganizationID)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (h *Handler) setRefreshCookie(w http.ResponseWriter, r *http.Request, userID string) {
	raw, _ := RandomToken(32)
	_, _ = h.Pool.Exec(r.Context(), `
		INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)
	`, userID, HashToken(raw), time.Now().Add(7*24*time.Hour))
	http.SetCookie(w, &http.Cookie{
		Name: "crm_refresh", Value: raw, Path: "/", MaxAge: 7 * 86400,
		HttpOnly: true, Secure: h.Cfg.SecureCookies, SameSite: http.SameSiteLaxMode,
	})
}
