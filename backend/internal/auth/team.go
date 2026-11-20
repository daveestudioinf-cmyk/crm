package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

var validRoles = map[string]bool{
	"viewer":  true,
	"agent":   true,
	"manager": true,
	"admin":   true,
}

func (h *Handler) ListInvites(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, email, role, COALESCE(invited_by::text, ''), expires_at, accepted_at, created_at
		FROM team_invites
		WHERE organization_id = $1
		ORDER BY created_at DESC
		LIMIT 50
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var iid, email, role, invitedBy string
		var expiresAt, createdAt time.Time
		var acceptedAt *time.Time
		if err := rows.Scan(&iid, &email, &role, &invitedBy, &expiresAt, &acceptedAt, &createdAt); err == nil {
			out = append(out, map[string]any{
				"id":          iid,
				"email":       email,
				"role":        role,
				"invited_by":  invitedBy,
				"expires_at":  expiresAt,
				"accepted_at": acceptedAt,
				"created_at":  createdAt,
			})
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	role := strings.TrimSpace(strings.ToLower(req.Role))
	if role == "" {
		role = "agent"
	}
	if email == "" || !strings.Contains(email, "@") || !validRoles[role] {
		httpx.Error(w, http.StatusBadRequest, "valid email and role (viewer|agent|manager|admin) are required")
		return
	}
	if role == "admin" && !HasRole(id.Role, "admin") {
		httpx.Error(w, http.StatusForbidden, "insufficient role")
		return
	}

	rawToken, err := RandomToken(24)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to generate token")
		return
	}
	tokenHash := HashToken(rawToken)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)

	var inviteID string
	var createdAt time.Time
	err = h.Pool.QueryRow(r.Context(), `
		INSERT INTO team_invites (organization_id, email, role, token_hash, invited_by, expires_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, '')::uuid, $6)
		RETURNING id, created_at
	`, id.OrganizationID, email, role, tokenHash, id.UserID, expiresAt).Scan(&inviteID, &createdAt)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create invite")
		return
	}

	_ = WriteAudit(r.Context(), h.Pool, id, "team.invite.create", "team_invite", inviteID, map[string]any{
		"email": email,
		"role":  role,
	})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"invite": map[string]any{
			"id":         inviteID,
			"email":      email,
			"role":       role,
			"expires_at": expiresAt,
			"created_at": createdAt,
		},
		"token": rawToken,
	})
}

func (h *Handler) RevokeInvite(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	inviteID := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `
		DELETE FROM team_invites
		WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL
	`, inviteID, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "invite not found or already accepted")
		return
	}
	_ = WriteAudit(r.Context(), h.Pool, id, "team.invite.revoke", "team_invite", inviteID, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (h *Handler) InspectInvite(w http.ResponseWriter, r *http.Request) {
	rawToken := strings.TrimSpace(chi.URLParam(r, "token"))
	if rawToken == "" {
		httpx.Error(w, http.StatusNotFound, "invite not found")
		return
	}
	tokenHash := HashToken(rawToken)
	var email, role, orgName string
	var expiresAt time.Time
	var acceptedAt *time.Time
	err := h.Pool.QueryRow(r.Context(), `
		SELECT ti.email, ti.role, o.name, ti.expires_at, ti.accepted_at
		FROM team_invites ti
		JOIN organizations o ON o.id = ti.organization_id
		WHERE ti.token_hash = $1
	`, tokenHash).Scan(&email, &role, &orgName, &expiresAt, &acceptedAt)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "invite not found")
		return
	}
	expired := time.Now().After(expiresAt)
	accepted := acceptedAt != nil
	valid := !expired && !accepted
	httpx.JSON(w, http.StatusOK, map[string]any{
		"valid":             valid,
		"expired":           expired,
		"accepted":          accepted,
		"email":             email,
		"role":              role,
		"organization_name": orgName,
	})
}

func (h *Handler) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token    string `json:"token"`
		FullName string `json:"full_name"`
		Password string `json:"password"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		httpx.Error(w, http.StatusBadRequest, "token is required")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var inviteID, orgID, orgName, email, role string
	var expiresAt time.Time
	var acceptedAt *time.Time
	err = tx.QueryRow(r.Context(), `
		SELECT ti.id, ti.organization_id, o.name, ti.email, ti.role, ti.expires_at, ti.accepted_at
		FROM team_invites ti
		JOIN organizations o ON o.id = ti.organization_id
		WHERE ti.token_hash = $1
		FOR UPDATE OF ti
	`, HashToken(req.Token)).Scan(&inviteID, &orgID, &orgName, &email, &role, &expiresAt, &acceptedAt)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "invite not found")
		return
	}
	if acceptedAt != nil {
		httpx.Error(w, http.StatusConflict, "invite already accepted")
		return
	}
	if time.Now().After(expiresAt) {
		httpx.Error(w, http.StatusGone, "invite expired")
		return
	}

	var userID, existingHash, fullName string
	var isPlatformAdmin bool
	err = tx.QueryRow(r.Context(), `
		SELECT id, password_hash, full_name, is_platform_admin FROM users WHERE email = $1
	`, email).Scan(&userID, &existingHash, &fullName, &isPlatformAdmin)
	if errors.Is(err, pgx.ErrNoRows) {
		if len(req.Password) < 8 {
			httpx.Error(w, http.StatusBadRequest, "password (>=8) is required for new account")
			return
		}
		fullName = strings.TrimSpace(req.FullName)
		if fullName == "" {
			fullName = strings.Split(email, "@")[0]
		}
		pwHash, hashErr := HashPassword(req.Password)
		if hashErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to hash password")
			return
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (email, password_hash, full_name)
			VALUES ($1, $2, $3)
			RETURNING id
		`, email, pwHash, fullName).Scan(&userID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to create user")
			return
		}
	} else if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	} else {
		if req.Password == "" || !CheckPassword(existingHash, req.Password) {
			httpx.Error(w, http.StatusUnauthorized, "invalid password for existing account")
			return
		}
	}

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO user_organizations (user_id, organization_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role
	`, userID, orgID, role); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to link membership")
		return
	}

	if _, err := tx.Exec(r.Context(), `UPDATE team_invites SET accepted_at = now() WHERE id = $1`, inviteID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to mark invite accepted")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	id := Identity{
		UserID:          userID,
		OrganizationID:  orgID,
		Role:            role,
		IsPlatformAdmin: isPlatformAdmin,
		RemoteIP:        extractRemoteIP(r),
	}
	_ = WriteAudit(r.Context(), h.Pool, id, "team.invite.accept", "team_invite", inviteID, map[string]any{
		"email": email,
		"role":  role,
	})

	access, _ := IssueAccessToken(h.Cfg.JWTSecret, id, 24*time.Hour, false)
	h.setRefreshCookie(w, r, userID)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": access,
		"user": map[string]any{
			"id": userID, "email": email, "full_name": fullName,
			"organization_id": orgID, "org_name": orgName, "role": role,
			"is_platform_admin": isPlatformAdmin,
		},
	})
}

func (h *Handler) UpdateMember(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	targetUserID := chi.URLParam(r, "id")

	var req struct {
		Role                 *string         `json:"role"`
		IsAvailable          *bool           `json:"is_available"`
		MaxConcurrentChats   *int            `json:"max_concurrent_chats"`
		AvailabilitySchedule json.RawMessage `json:"availability_schedule"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	isAdmin := HasRole(id.Role, "admin")
	if !isAdmin {
		if targetUserID != id.UserID || req.Role != nil || req.MaxConcurrentChats != nil {
			httpx.Error(w, http.StatusForbidden, "insufficient role")
			return
		}
	}

	if req.Role != nil {
		roleVal := strings.TrimSpace(strings.ToLower(*req.Role))
		if !validRoles[roleVal] {
			httpx.Error(w, http.StatusBadRequest, "invalid role")
			return
		}
		req.Role = &roleVal
	}

	if req.MaxConcurrentChats != nil && *req.MaxConcurrentChats < 1 {
		httpx.Error(w, http.StatusBadRequest, "max_concurrent_chats must be >= 1")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var adminCount int
	if req.Role != nil && *req.Role != "admin" {
		adminRows, err := tx.Query(r.Context(), `
			SELECT id FROM user_organizations WHERE organization_id = $1 AND role = 'admin' ORDER BY id FOR UPDATE
		`, id.OrganizationID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "db error")
			return
		}
		for adminRows.Next() {
			adminCount++
		}
		adminRows.Close()
		if err := adminRows.Err(); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "db error")
			return
		}
	}

	var currentRole string
	var currentAvail bool
	var currentMax int
	var currentSched json.RawMessage
	err = tx.QueryRow(r.Context(), `
		SELECT role, is_available, max_concurrent_chats, availability_schedule
		FROM user_organizations
		WHERE user_id = $1 AND organization_id = $2
		FOR UPDATE
	`, targetUserID, id.OrganizationID).Scan(&currentRole, &currentAvail, &currentMax, &currentSched)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "member not found")
		return
	}

	if req.Role != nil && currentRole == "admin" && *req.Role != "admin" {
		if adminCount <= 1 {
			httpx.Error(w, http.StatusConflict, "cannot demote the last admin")
			return
		}
	}

	newRole := currentRole
	if req.Role != nil {
		newRole = *req.Role
	}
	newAvail := currentAvail
	if req.IsAvailable != nil {
		newAvail = *req.IsAvailable
	}
	newMax := currentMax
	if req.MaxConcurrentChats != nil {
		newMax = *req.MaxConcurrentChats
	}
	newSched := currentSched
	if len(req.AvailabilitySchedule) > 0 && string(req.AvailabilitySchedule) != "null" {
		if !json.Valid(req.AvailabilitySchedule) {
			httpx.Error(w, http.StatusBadRequest, "invalid availability_schedule json")
			return
		}
		newSched = req.AvailabilitySchedule
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE user_organizations
		SET role = $1, is_available = $2, max_concurrent_chats = $3, availability_schedule = $4::jsonb
		WHERE user_id = $5 AND organization_id = $6
	`, newRole, newAvail, newMax, string(newSched), targetUserID, id.OrganizationID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to update member")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	_ = WriteAudit(r.Context(), h.Pool, id, "team.member.update", "user_organization", targetUserID, map[string]any{
		"role":                 newRole,
		"is_available":         newAvail,
		"max_concurrent_chats": newMax,
	})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":                    targetUserID,
		"role":                  newRole,
		"is_available":          newAvail,
		"max_concurrent_chats":  newMax,
		"availability_schedule": json.RawMessage(newSched),
	})
}

func (h *Handler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	targetUserID := chi.URLParam(r, "id")

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	adminRows, err := tx.Query(r.Context(), `
		SELECT id FROM user_organizations WHERE organization_id = $1 AND role = 'admin' ORDER BY id FOR UPDATE
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	var adminCount int
	for adminRows.Next() {
		adminCount++
	}
	adminRows.Close()
	if err := adminRows.Err(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	var role string
	err = tx.QueryRow(r.Context(), `
		SELECT role FROM user_organizations WHERE user_id = $1 AND organization_id = $2 FOR UPDATE
	`, targetUserID, id.OrganizationID).Scan(&role)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "member not found")
		return
	}

	if role == "admin" && adminCount <= 1 {
		httpx.Error(w, http.StatusConflict, "cannot remove the last admin")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		DELETE FROM user_organizations WHERE user_id = $1 AND organization_id = $2
	`, targetUserID, id.OrganizationID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to remove member")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	_ = WriteAudit(r.Context(), h.Pool, id, "team.member.remove", "user_organization", targetUserID, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "removed"})
}
