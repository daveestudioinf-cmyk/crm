package automation

import (
	"encoding/json"
	"net/http"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	Pool *pgxpool.Pool
}

func (h *Handler) ListWebhookSources(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `SELECT id, name, token, is_active, created_at FROM webhook_sources WHERE organization_id=$1 ORDER BY created_at DESC`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var wid, name, tok string
		var active bool
		var created any
		_ = rows.Scan(&wid, &name, &tok, &active, &created)
		out = append(out, map[string]any{"id": wid, "name": name, "token": tok, "is_active": active, "created_at": created})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateWebhookSource(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name string `json:"name"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	tok, _ := auth.RandomToken(16)
	var wid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO webhook_sources (organization_id, name, token) VALUES ($1,$2,$3) RETURNING id
	`, id.OrganizationID, req.Name, tok).Scan(&wid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": wid, "name": req.Name, "token": tok})
}

func (h *Handler) InboundLeadCapture(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	var orgID string
	var isSuspended bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT ws.organization_id, o.is_suspended
		FROM webhook_sources ws
		JOIN organizations o ON o.id = ws.organization_id
		WHERE ws.token=$1 AND ws.is_active=true
	`, tok).Scan(&orgID, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "invalid webhook token")
		return
	}
	if isSuspended {
		httpx.Error(w, http.StatusForbidden, "tenant_suspended")
		return
	}
	var req struct {
		Name  string `json:"name"`
		Phone string `json:"phone"`
		Email string `json:"email"`
		Title string `json:"title"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	var contactID string
	_ = h.Pool.QueryRow(r.Context(), `
		INSERT INTO contacts (organization_id, name, phone_number, email) VALUES ($1,$2,NULLIF($3,''),NULLIF($4,'')) RETURNING id
	`, orgID, req.Name, req.Phone, req.Email).Scan(&contactID)
	if req.Title == "" {
		req.Title = "Inbound: " + req.Name
	}
	var pipeID, stageID string
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT p.id, s.id FROM crm_pipelines p JOIN crm_stages s ON s.pipeline_id=p.id
		WHERE p.organization_id=$1 ORDER BY p.is_default DESC, s.position ASC LIMIT 1
	`, orgID).Scan(&pipeID, &stageID)
	if pipeID != "" && stageID != "" {
		_, _ = h.Pool.Exec(r.Context(), `
			INSERT INTO crm_leads (organization_id, contact_id, pipeline_id, stage_id, title, source)
			VALUES ($1,$2,$3,$4,$5,'webhook')
		`, orgID, contactID, pipeID, stageID, req.Title)
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"status": "captured", "contact_id": contactID})
}

func (h *Handler) ListRules(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `SELECT id, name, trigger_event, conditions, actions, is_active FROM automation_rules WHERE organization_id=$1 ORDER BY created_at DESC`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, name, trig string
		var cond, act any
		var active bool
		_ = rows.Scan(&rid, &name, &trig, &cond, &act, &active)
		out = append(out, map[string]any{"id": rid, "name": name, "trigger_event": trig, "conditions": cond, "actions": act, "is_active": active})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateRule(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name         string `json:"name"`
		TriggerEvent string `json:"trigger_event"`
		Conditions   any    `json:"conditions"`
		Actions      any    `json:"actions"`
		IsActive     bool   `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" || req.TriggerEvent == "" {
		httpx.Error(w, http.StatusBadRequest, "name and trigger_event required")
		return
	}
	cb, _ := json.Marshal(req.Conditions)
	ab, _ := json.Marshal(req.Actions)
	var rid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO automation_rules (organization_id, name, trigger_event, conditions, actions, is_active)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
	`, id.OrganizationID, req.Name, req.TriggerEvent, string(cb), string(ab), req.IsActive).Scan(&rid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": rid, "name": req.Name, "is_active": req.IsActive})
}

func (h *Handler) ListLGPDRequests(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT l.id, l.contact_id, c.name, l.request_type, l.status, l.created_at, l.completed_at
		FROM lgpd_requests l JOIN contacts c ON c.id = l.contact_id
		WHERE l.organization_id=$1 ORDER BY l.created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var lid, cid, cname, rtype, status string
		var created, completed any
		_ = rows.Scan(&lid, &cid, &cname, &rtype, &status, &created, &completed)
		out = append(out, map[string]any{"id": lid, "contact_id": cid, "contact_name": cname, "request_type": rtype, "status": status, "created_at": created, "completed_at": completed})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateLGPDRequest(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		ContactID   string `json:"contact_id"`
		RequestType string `json:"request_type"` // export | redact
	}
	if err := httpx.Decode(r, &req); err != nil || req.ContactID == "" {
		httpx.Error(w, http.StatusBadRequest, "contact_id and request_type required")
		return
	}
	var lid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO lgpd_requests (organization_id, contact_id, request_type, requested_by)
		VALUES ($1,$2,$3,$4) RETURNING id
	`, id.OrganizationID, req.ContactID, req.RequestType, id.UserID).Scan(&lid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": lid, "status": "pending"})
}

func (h *Handler) ExecuteLGPDRequest(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	var contactID, rtype string
	err := h.Pool.QueryRow(r.Context(), `SELECT contact_id, request_type FROM lgpd_requests WHERE id=$1 AND organization_id=$2`, lid, id.OrganizationID).Scan(&contactID, &rtype)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "request not found")
		return
	}
	if rtype == "redact" {
		_, _ = h.Pool.Exec(r.Context(), `
			UPDATE contacts SET name='Anonymized Contact', phone_number=NULL, email=NULL, cpf=NULL, is_anonymized=true, updated_at=now()
			WHERE id=$1 AND organization_id=$2
		`, contactID, id.OrganizationID)
		_, _ = h.Pool.Exec(r.Context(), `UPDATE lgpd_requests SET status='completed', completed_at=now() WHERE id=$1`, lid)
		auth.WriteAudit(r.Context(), h.Pool, id, "lgpd.redact", "contact", contactID, map[string]any{})
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "redacted"})
		return
	}

	var name, email, phone string
	_ = h.Pool.QueryRow(r.Context(), `SELECT name, COALESCE(email,''), COALESCE(phone_number,'') FROM contacts WHERE id=$1`, contactID).Scan(&name, &email, &phone)
	exp, _ := json.Marshal(map[string]any{"contact_id": contactID, "name": name, "email": email, "phone_number": phone})
	_, _ = h.Pool.Exec(r.Context(), `UPDATE lgpd_requests SET status='completed', export_payload=$1, completed_at=now() WHERE id=$2`, string(exp), lid)
	auth.WriteAudit(r.Context(), h.Pool, id, "lgpd.export", "contact", contactID, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "exported", "data": json.RawMessage(exp)})
}

func (h *Handler) ListTeam(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT u.id, u.email, u.full_name, uo.role, uo.is_available, uo.max_concurrent_chats
		FROM user_organizations uo JOIN users u ON u.id = uo.user_id
		WHERE uo.organization_id = $1 ORDER BY uo.created_at ASC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var uid, email, name, role string
		var avail bool
		var maxChats int
		_ = rows.Scan(&uid, &email, &name, &role, &avail, &maxChats)
		out = append(out, map[string]any{"id": uid, "email": email, "full_name": name, "role": role, "is_available": avail, "max_concurrent_chats": maxChats})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) ListAudit(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, action, resource_type, COALESCE(resource_id,''), metadata, created_at
		FROM api_audit_log WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var aid, act, rtype, rid string
		var meta any
		var created any
		_ = rows.Scan(&aid, &act, &rtype, &rid, &meta, &created)
		out = append(out, map[string]any{"id": aid, "action": act, "resource_type": rtype, "resource_id": rid, "metadata": meta, "created_at": created})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) GetMetrics(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var contactsCnt, leadsOpen, leadsWon, convOpen, msgsToday int
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM contacts WHERE organization_id=$1 AND is_merged_into IS NULL`, id.OrganizationID).Scan(&contactsCnt)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM crm_leads WHERE organization_id=$1 AND status='open'`, id.OrganizationID).Scan(&leadsOpen)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM crm_leads WHERE organization_id=$1 AND status='won'`, id.OrganizationID).Scan(&leadsWon)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM conversations WHERE organization_id=$1 AND status IN ('open','pending','ai_handling','claimed')`, id.OrganizationID).Scan(&convOpen)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM messages WHERE organization_id=$1 AND sent_at >= date_trunc('day', now())`, id.OrganizationID).Scan(&msgsToday)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"contacts_total":     contactsCnt,
		"leads_open":         leadsOpen,
		"leads_won":          leadsWon,
		"conversations_open": convOpen,
		"messages_today":     msgsToday,
	})
}
