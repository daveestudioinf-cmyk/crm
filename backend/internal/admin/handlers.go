package admin

import (
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	Pool *pgxpool.Pool
}

// ListTenants returns paginated organizations with optional search and suspension filter.
func (h *Handler) ListTenants(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil {
			limit = v
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 0 {
			offset = v
		}
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	suspParam := strings.TrimSpace(r.URL.Query().Get("is_suspended"))

	where := "WHERE 1=1"
	args := []any{}
	idx := 1

	if q != "" {
		where += " AND (o.name ILIKE $" + strconv.Itoa(idx) + " OR o.slug ILIKE $" + strconv.Itoa(idx) + ")"
		args = append(args, "%"+q+"%")
		idx++
	}
	if suspParam == "true" || suspParam == "false" {
		where += " AND o.is_suspended = $" + strconv.Itoa(idx)
		args = append(args, suspParam == "true")
		idx++
	}

	var total int
	countSQL := "SELECT COUNT(*) FROM organizations o " + where
	if err := h.Pool.QueryRow(r.Context(), countSQL, args...).Scan(&total); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	listSQL := `
		SELECT o.id, o.name, o.slug, o.is_suspended, o.created_at, o.updated_at,
		       (SELECT COUNT(*) FROM user_organizations uo WHERE uo.organization_id = o.id) AS users_count,
		       (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = o.id) AS contacts_count,
		       (SELECT COUNT(*) FROM conversations cv WHERE cv.organization_id = o.id) AS conversations_count,
		       (SELECT COUNT(*) FROM platform_support_sessions ps WHERE ps.target_organization_id = o.id AND ps.ended_at IS NULL AND ps.expires_at > now()) AS active_support_sessions
		FROM organizations o
	` + where + `
		ORDER BY o.created_at DESC
		LIMIT $` + strconv.Itoa(idx) + ` OFFSET $` + strconv.Itoa(idx+1)

	queryArgs := append(append([]any{}, args...), limit, offset)
	rows, err := h.Pool.Query(r.Context(), listSQL, queryArgs...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		var id, name, slug string
		var isSuspended bool
		var createdAt, updatedAt time.Time
		var usersCount, contactsCount, convsCount, activeSupport int
		if err := rows.Scan(&id, &name, &slug, &isSuspended, &createdAt, &updatedAt, &usersCount, &contactsCount, &convsCount, &activeSupport); err != nil {
			continue
		}
		items = append(items, map[string]any{
			"id":                      id,
			"name":                    name,
			"slug":                    slug,
			"is_suspended":            isSuspended,
			"created_at":              createdAt,
			"updated_at":              updatedAt,
			"users_count":             usersCount,
			"contacts_count":          contactsCount,
			"conversations_count":     convsCount,
			"active_support_sessions": activeSupport,
		})
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":  items,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

// UpdateTenantStatus suspends or reactivates a tenant organization and audits on target_organization_id atomically.
func (h *Handler) UpdateTenantStatus(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	tenantID := chi.URLParam(r, "id")

	var req struct {
		IsSuspended *bool  `json:"is_suspended"`
		Reason      string `json:"reason"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.IsSuspended == nil {
		httpx.Error(w, http.StatusBadRequest, "is_suspended is required")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var name string
	var isSuspended bool
	err = tx.QueryRow(r.Context(), `
		UPDATE organizations
		SET is_suspended = $1, updated_at = now()
		WHERE id = $2
		RETURNING name, is_suspended
	`, *req.IsSuspended, tenantID).Scan(&name, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "organization not found")
		return
	}

	action := "tenant.activate"
	if isSuspended {
		action = "tenant.suspend"
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO api_audit_log (organization_id, actor_user_id, support_session_id, action, resource_type, resource_id, metadata, ip_address)
		VALUES (NULLIF($1, '')::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4, 'organization', $5, $6, NULLIF($7, ''))
	`, tenantID, id.UserID, id.SupportSessID, action, tenantID, map[string]any{
		"is_suspended": isSuspended,
		"reason":       strings.TrimSpace(req.Reason),
	}, id.RemoteIP)
	if err != nil {
		log.Printf("admin audit error (%s): %v", action, err)
		httpx.Error(w, http.StatusInternalServerError, "audit log failure")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":           tenantID,
		"name":         name,
		"is_suspended": isSuspended,
	})
}

// StartSupportSession creates an audited temporary support session (max 60 minutes) atomically.
func (h *Handler) StartSupportSession(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())

	var req struct {
		TargetOrganizationID string `json:"target_organization_id"`
		Reason               string `json:"reason"`
		Mode                 string `json:"mode"`
		TTLMinutes           int    `json:"ttl_minutes"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	req.TargetOrganizationID = strings.TrimSpace(req.TargetOrganizationID)
	req.Reason = strings.TrimSpace(req.Reason)
	if req.TargetOrganizationID == "" {
		httpx.Error(w, http.StatusBadRequest, "target_organization_id is required")
		return
	}
	if req.Reason == "" {
		httpx.Error(w, http.StatusBadRequest, "reason is required")
		return
	}

	mode := strings.TrimSpace(req.Mode)
	if mode == "" {
		mode = "support_readonly"
	}
	if mode != "support_readonly" && mode != "full" {
		httpx.Error(w, http.StatusBadRequest, "invalid mode")
		return
	}

	ttl := req.TTLMinutes
	if ttl == 0 {
		ttl = 60
	}
	if ttl < 1 || ttl > 60 {
		httpx.Error(w, http.StatusBadRequest, "ttl_minutes must be between 1 and 60")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var orgName string
	err = tx.QueryRow(r.Context(), `SELECT name FROM organizations WHERE id = $1`, req.TargetOrganizationID).Scan(&orgName)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "organization not found")
		return
	}

	var sessID string
	var expiresAt, createdAt time.Time
	err = tx.QueryRow(r.Context(), `
		INSERT INTO platform_support_sessions (admin_user_id, target_organization_id, mode, reason, expires_at)
		VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'))
		RETURNING id, expires_at, created_at
	`, id.UserID, req.TargetOrganizationID, mode, req.Reason, ttl).Scan(&sessID, &expiresAt, &createdAt)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create support session")
		return
	}

	_, err = tx.Exec(r.Context(), `
		INSERT INTO api_audit_log (organization_id, actor_user_id, support_session_id, action, resource_type, resource_id, metadata, ip_address)
		VALUES (NULLIF($1, '')::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, 'support_session.start', 'platform_support_session', $4, $5, NULLIF($6, ''))
	`, req.TargetOrganizationID, id.UserID, sessID, sessID, map[string]any{
		"mode":        mode,
		"reason":      req.Reason,
		"ttl_minutes": ttl,
	}, id.RemoteIP)
	if err != nil {
		log.Printf("admin audit error (support_session.start): %v", err)
		httpx.Error(w, http.StatusInternalServerError, "audit log failure")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":                     sessID,
		"target_organization_id": req.TargetOrganizationID,
		"organization_name":      orgName,
		"mode":                   mode,
		"reason":                 req.Reason,
		"expires_at":             expiresAt,
		"created_at":             createdAt,
	})
}

// EndSupportSession terminates an active support session immediately and audits atomically.
func (h *Handler) EndSupportSession(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	sessID := chi.URLParam(r, "id")

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var targetOrgID string
	var endedAt *time.Time
	err = tx.QueryRow(r.Context(), `
		SELECT target_organization_id, ended_at
		FROM platform_support_sessions
		WHERE id = $1
	`, sessID).Scan(&targetOrgID, &endedAt)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "support session not found")
		return
	}

	if endedAt == nil {
		_, err = tx.Exec(r.Context(), `
			UPDATE platform_support_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL
		`, sessID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to end support session")
			return
		}
	}

	_, err = tx.Exec(r.Context(), `
		INSERT INTO api_audit_log (organization_id, actor_user_id, support_session_id, action, resource_type, resource_id, metadata, ip_address)
		VALUES (NULLIF($1, '')::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, 'support_session.end', 'platform_support_session', $4, $5, NULLIF($6, ''))
	`, targetOrgID, id.UserID, sessID, sessID, map[string]any{}, id.RemoteIP)
	if err != nil {
		log.Printf("admin audit error (support_session.end): %v", err)
		httpx.Error(w, http.StatusInternalServerError, "audit log failure")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"status":                 "ended",
		"id":                     sessID,
		"target_organization_id": targetOrgID,
	})
}

// GetMetrics returns global cross-tenant KPIs for the platform admin console.
func (h *Handler) GetMetrics(w http.ResponseWriter, r *http.Request) {
	var totalTenants, suspendedTenants, totalUsers, totalContacts, totalConvs, totalMsgs, activeSessions int
	err := h.Pool.QueryRow(r.Context(), `
		SELECT
			(SELECT COUNT(*) FROM organizations),
			(SELECT COUNT(*) FROM organizations WHERE is_suspended = true),
			(SELECT COUNT(*) FROM users),
			(SELECT COUNT(*) FROM contacts),
			(SELECT COUNT(*) FROM conversations),
			(SELECT COUNT(*) FROM messages),
			(SELECT COUNT(*) FROM platform_support_sessions WHERE ended_at IS NULL AND expires_at > now())
	`).Scan(&totalTenants, &suspendedTenants, &totalUsers, &totalContacts, &totalConvs, &totalMsgs, &activeSessions)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"total_tenants":           totalTenants,
		"active_tenants":          totalTenants - suspendedTenants,
		"suspended_tenants":       suspendedTenants,
		"total_users":             totalUsers,
		"total_contacts":          totalContacts,
		"total_conversations":     totalConvs,
		"total_messages":          totalMsgs,
		"active_support_sessions": activeSessions,
	})
}
