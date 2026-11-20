package automation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/crm"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	Pool *pgxpool.Pool
	Hub  *realtime.Hub
}

type inboundLeadPayload struct {
	Name        string   `json:"name"`
	Phone       string   `json:"phone"`
	PhoneNumber string   `json:"phone_number"`
	Email       string   `json:"email"`
	CPF         string   `json:"cpf"`
	Title       string   `json:"title"`
	ValueCents  int64    `json:"value_cents"`
	Currency    string   `json:"currency"`
	Tags        []string `json:"tags"`
}

type inboundCaptureResult struct {
	ContactID        string
	ResolvedExisting bool
	LeadID           string
	PipelineID       string
	StageID          string
	EventID          string
}

func (h *Handler) captureInboundLead(ctx context.Context, orgID, sourceID, defaultPipelineID, actorUserID string, req inboundLeadPayload) (inboundCaptureResult, error) {
	phone := strings.TrimSpace(req.Phone)
	if phone == "" {
		phone = strings.TrimSpace(req.PhoneNumber)
	}
	res, err := crm.ResolveOrCreateContact(ctx, h.Pool, orgID, crm.ContactInput{
		Name:        req.Name,
		PhoneNumber: phone,
		Email:       req.Email,
		CPF:         req.CPF,
		Tags:        req.Tags,
		ActorUserID: actorUserID,
	})
	if err != nil {
		return inboundCaptureResult{}, err
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Inbound: " + strings.TrimSpace(req.Name)
	}
	curr := strings.TrimSpace(req.Currency)
	if curr == "" {
		curr = "USD"
	}

	var pipeID, stageID string
	if defaultPipelineID != "" {
		_ = h.Pool.QueryRow(ctx, `
			SELECT p.id, s.id FROM crm_pipelines p
			JOIN crm_stages s ON s.pipeline_id = p.id
			WHERE p.organization_id = $1 AND p.id = $2
			ORDER BY s.position ASC LIMIT 1
		`, orgID, defaultPipelineID).Scan(&pipeID, &stageID)
	}
	if pipeID == "" || stageID == "" {
		_ = h.Pool.QueryRow(ctx, `
			SELECT p.id, s.id FROM crm_pipelines p
			JOIN crm_stages s ON s.pipeline_id = p.id
			WHERE p.organization_id = $1
			ORDER BY p.is_default DESC, s.position ASC LIMIT 1
		`, orgID).Scan(&pipeID, &stageID)
	}

	var leadID string
	if pipeID != "" && stageID != "" {
		_ = h.Pool.QueryRow(ctx, `
			INSERT INTO crm_leads (organization_id, contact_id, pipeline_id, stage_id, title, value_cents, currency, source)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'webhook') RETURNING id
		`, orgID, res.ContactID, pipeID, stageID, title, req.ValueCents, curr).Scan(&leadID)
	}

	actMeta, _ := json.Marshal(map[string]any{
		"webhook_source_id": sourceID,
		"resolved_existing": res.ResolvedExisting,
		"phone":             phone,
		"email":             req.Email,
	})
	_, _ = h.Pool.Exec(ctx, `
		INSERT INTO crm_lead_activities (organization_id, lead_id, contact_id, actor_user_id, type, summary, metadata)
		VALUES ($1, NULLIF($2,'')::uuid, $3, NULLIF($4,'')::uuid, 'webhook_inbound', $5, $6)
	`, orgID, leadID, res.ContactID, actorUserID, "Inbound lead captured: "+title, string(actMeta))

	evPayload, _ := json.Marshal(map[string]any{
		"trigger_event":     "webhook.inbound",
		"event_name":        "lead.created",
		"webhook_source_id": sourceID,
		"contact_id":        res.ContactID,
		"lead_id":           leadID,
		"pipeline_id":       pipeID,
		"stage_id":          stageID,
		"name":              strings.TrimSpace(req.Name),
		"phone":             phone,
		"email":             strings.TrimSpace(req.Email),
		"title":             title,
	})
	var eventID string
	_ = h.Pool.QueryRow(ctx, `
		INSERT INTO event_log (organization_id, event_type, payload)
		VALUES ($1, 'automation.evaluate', $2) RETURNING id
	`, orgID, string(evPayload)).Scan(&eventID)

	if h.Hub != nil {
		h.Hub.Publish(orgID, "lead.updated", map[string]any{
			"lead_id":           leadID,
			"contact_id":        res.ContactID,
			"pipeline_id":       pipeID,
			"stage_id":          stageID,
			"source":            "webhook",
			"webhook_source_id": sourceID,
		})
	}

	return inboundCaptureResult{
		ContactID:        res.ContactID,
		ResolvedExisting: res.ResolvedExisting,
		LeadID:           leadID,
		PipelineID:       pipeID,
		StageID:          stageID,
		EventID:          eventID,
	}, nil
}

func (h *Handler) ListWebhookSources(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, token, COALESCE(default_pipeline_id::text,''), is_active, created_at
		FROM webhook_sources WHERE organization_id=$1 ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var wid, name, tok, defPipe string
		var active bool
		var created any
		_ = rows.Scan(&wid, &name, &tok, &defPipe, &active, &created)
		out = append(out, map[string]any{
			"id":                  wid,
			"name":                name,
			"token":               tok,
			"default_pipeline_id": defPipe,
			"is_active":           active,
			"created_at":          created,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateWebhookSource(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name              string  `json:"name"`
		DefaultPipelineID *string `json:"default_pipeline_id"`
		IsActive          *bool   `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	tok, _ := auth.RandomToken(16)
	var wid, defPipe string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO webhook_sources (organization_id, name, token, default_pipeline_id, is_active)
		VALUES ($1,$2,$3,NULLIF($4,'')::uuid,$5)
		RETURNING id, COALESCE(default_pipeline_id::text,'')
	`, id.OrganizationID, strings.TrimSpace(req.Name), tok, derefStr(req.DefaultPipelineID), active).Scan(&wid, &defPipe)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "webhook_source.create", "webhook_source", wid, map[string]any{"name": strings.TrimSpace(req.Name)})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":                  wid,
		"name":                strings.TrimSpace(req.Name),
		"token":               tok,
		"default_pipeline_id": defPipe,
		"is_active":           active,
	})
}

func (h *Handler) UpdateWebhookSource(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	wid := chi.URLParam(r, "id")
	var req struct {
		Name              *string `json:"name"`
		DefaultPipelineID *string `json:"default_pipeline_id"`
		IsActive          *bool   `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var name, tok, defPipe string
	var active bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE webhook_sources
		SET name = COALESCE(NULLIF($3, ''), name),
		    default_pipeline_id = CASE WHEN $4::text IS NULL THEN default_pipeline_id ELSE NULLIF($4, '')::uuid END,
		    is_active = COALESCE($5, is_active)
		WHERE id=$1 AND organization_id=$2
		RETURNING name, token, COALESCE(default_pipeline_id::text,''), is_active
	`, wid, id.OrganizationID, req.Name, req.DefaultPipelineID, req.IsActive).Scan(&name, &tok, &defPipe, &active)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "webhook source not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "webhook_source.update", "webhook_source", wid, map[string]any{"is_active": active})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":                  wid,
		"name":                name,
		"token":               tok,
		"default_pipeline_id": defPipe,
		"is_active":           active,
	})
}

func (h *Handler) DeleteWebhookSource(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	wid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `DELETE FROM webhook_sources WHERE id=$1 AND organization_id=$2`, wid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "webhook source not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "webhook_source.delete", "webhook_source", wid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) TestWebhookSource(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	wid := chi.URLParam(r, "id")
	var defPipe string
	var active bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT COALESCE(default_pipeline_id::text,''), is_active
		FROM webhook_sources WHERE id=$1 AND organization_id=$2
	`, wid, id.OrganizationID).Scan(&defPipe, &active)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "webhook source not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	var req inboundLeadPayload
	if err := httpx.Decode(r, &req); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		req.Name = "Lead de Prueba Webhook"
	}
	if strings.TrimSpace(req.Phone) == "" && strings.TrimSpace(req.PhoneNumber) == "" {
		req.Phone = "+5511999998888"
	}
	if strings.TrimSpace(req.Email) == "" {
		req.Email = "prueba-webhook@example.com"
	}
	if strings.TrimSpace(req.Title) == "" {
		req.Title = "Prueba Webhook: " + req.Name
	}

	out, err := h.captureInboundLead(r.Context(), id.OrganizationID, wid, defPipe, id.UserID, req)
	if err != nil {
		if errors.Is(err, crm.ErrInvalidCPF) {
			httpx.Error(w, http.StatusBadRequest, "invalid_cpf")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "failed to test webhook")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "webhook_source.test", "webhook_source", wid, map[string]any{"contact_id": out.ContactID, "lead_id": out.LeadID})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"status":            "tested",
		"contact_id":        out.ContactID,
		"resolved_existing": out.ResolvedExisting,
		"lead_id":           out.LeadID,
		"pipeline_id":       out.PipelineID,
		"stage_id":          out.StageID,
		"event_id":          out.EventID,
	})
}

func (h *Handler) InboundLeadCapture(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	var sourceID, orgID, defPipe string
	var isSuspended bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT ws.id, ws.organization_id, COALESCE(ws.default_pipeline_id::text,''), o.is_suspended
		FROM webhook_sources ws
		JOIN organizations o ON o.id = ws.organization_id
		WHERE ws.token=$1 AND ws.is_active=true
	`, tok).Scan(&sourceID, &orgID, &defPipe, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "invalid webhook token")
		return
	}
	if isSuspended {
		httpx.Error(w, http.StatusForbidden, "tenant_suspended")
		return
	}
	var req inboundLeadPayload
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	out, err := h.captureInboundLead(r.Context(), orgID, sourceID, defPipe, "", req)
	if err != nil {
		if errors.Is(err, crm.ErrInvalidCPF) {
			httpx.Error(w, http.StatusBadRequest, "invalid_cpf")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "failed to capture lead")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"status":            "captured",
		"contact_id":        out.ContactID,
		"resolved_existing": out.ResolvedExisting,
		"lead_id":           out.LeadID,
		"pipeline_id":       out.PipelineID,
		"stage_id":          out.StageID,
		"event_id":          out.EventID,
	})
}

func (h *Handler) ListRules(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, description, trigger_event, conditions, actions, priority, is_active, created_at, updated_at
		FROM automation_rules WHERE organization_id=$1
		ORDER BY priority ASC, created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, name, desc, trig string
		var cond, act any
		var prio int
		var active bool
		var createdAt, updatedAt any
		_ = rows.Scan(&rid, &name, &desc, &trig, &cond, &act, &prio, &active, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id":            rid,
			"name":          name,
			"description":   desc,
			"trigger_event": trig,
			"conditions":    cond,
			"actions":       act,
			"priority":      prio,
			"is_active":     active,
			"created_at":    createdAt,
			"updated_at":    updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateRule(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		TriggerEvent string `json:"trigger_event"`
		Conditions   any    `json:"conditions"`
		Actions      any    `json:"actions"`
		Priority     *int   `json:"priority"`
		IsActive     bool   `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.TriggerEvent) == "" {
		httpx.Error(w, http.StatusBadRequest, "name and trigger_event required")
		return
	}
	if req.Conditions == nil {
		req.Conditions = map[string]any{}
	}
	if req.Actions == nil {
		req.Actions = []any{}
	}
	prio := 100
	if req.Priority != nil {
		prio = *req.Priority
	}
	cb, _ := json.Marshal(req.Conditions)
	ab, _ := json.Marshal(req.Actions)
	var rid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO automation_rules (organization_id, name, description, trigger_event, conditions, actions, priority, is_active)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
	`, id.OrganizationID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description), strings.TrimSpace(req.TriggerEvent), string(cb), string(ab), prio, req.IsActive).Scan(&rid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "automation_rule.create", "automation_rule", rid, map[string]any{"name": strings.TrimSpace(req.Name), "trigger_event": req.TriggerEvent})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":            rid,
		"name":          strings.TrimSpace(req.Name),
		"description":   strings.TrimSpace(req.Description),
		"trigger_event": strings.TrimSpace(req.TriggerEvent),
		"conditions":    req.Conditions,
		"actions":       req.Actions,
		"priority":      prio,
		"is_active":     req.IsActive,
	})
}

func (h *Handler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rid := chi.URLParam(r, "id")
	var req struct {
		Name         *string         `json:"name"`
		Description  *string         `json:"description"`
		TriggerEvent *string         `json:"trigger_event"`
		Conditions   json.RawMessage `json:"conditions"`
		Actions      json.RawMessage `json:"actions"`
		Priority     *int            `json:"priority"`
		IsActive     *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var condStr, actStr *string
	if len(req.Conditions) > 0 && string(req.Conditions) != "null" {
		s := string(req.Conditions)
		condStr = &s
	}
	if len(req.Actions) > 0 && string(req.Actions) != "null" {
		s := string(req.Actions)
		actStr = &s
	}

	var name, desc, trig string
	var cond, act any
	var prio int
	var active bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE automation_rules
		SET name = COALESCE(NULLIF($3, ''), name),
		    description = COALESCE($4, description),
		    trigger_event = COALESCE(NULLIF($5, ''), trigger_event),
		    conditions = COALESCE($6::jsonb, conditions),
		    actions = COALESCE($7::jsonb, actions),
		    priority = COALESCE($8, priority),
		    is_active = COALESCE($9, is_active),
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING name, description, trigger_event, conditions, actions, priority, is_active
	`, rid, id.OrganizationID, req.Name, req.Description, req.TriggerEvent, condStr, actStr, req.Priority, req.IsActive).
		Scan(&name, &desc, &trig, &cond, &act, &prio, &active)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "automation rule not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "automation_rule.update", "automation_rule", rid, map[string]any{"is_active": active})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":            rid,
		"name":          name,
		"description":   desc,
		"trigger_event": trig,
		"conditions":    cond,
		"actions":       act,
		"priority":      prio,
		"is_active":     active,
	})
}

func (h *Handler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `DELETE FROM automation_rules WHERE id=$1 AND organization_id=$2`, rid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "automation rule not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "automation_rule.delete", "automation_rule", rid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) ListRuleRuns(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	ruleID := strings.TrimSpace(chi.URLParam(r, "id"))
	if ruleID == "" {
		ruleID = strings.TrimSpace(r.URL.Query().Get("rule_id"))
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	limit := parseBoundedInt(r.URL.Query().Get("limit"), 50, 1, 200)

	rows, err := h.Pool.Query(r.Context(), `
		SELECT rr.id, rr.rule_id, COALESCE(ar.name,''), COALESCE(rr.event_id::text,''),
		       rr.trigger_event, rr.status, rr.input_payload, rr.actions_executed,
		       COALESCE(rr.error_message,''), rr.started_at, rr.finished_at, rr.created_at
		FROM automation_rule_runs rr
		LEFT JOIN automation_rules ar ON ar.id = rr.rule_id
		WHERE rr.organization_id = $1
		  AND ($2 = '' OR rr.rule_id::text = $2)
		  AND ($3 = '' OR rr.status = $3)
		ORDER BY rr.created_at DESC
		LIMIT $4
	`, id.OrganizationID, ruleID, status, limit)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var runID, rID, rName, evID, trig, st, errMsg string
		var inPayload, actExec any
		var startedAt, finishedAt, createdAt any
		_ = rows.Scan(&runID, &rID, &rName, &evID, &trig, &st, &inPayload, &actExec, &errMsg, &startedAt, &finishedAt, &createdAt)
		out = append(out, map[string]any{
			"id":               runID,
			"rule_id":          rID,
			"rule_name":        rName,
			"event_id":         evID,
			"trigger_event":    trig,
			"status":           st,
			"input_payload":    inPayload,
			"actions_executed": actExec,
			"error_message":    errMsg,
			"started_at":       startedAt,
			"finished_at":      finishedAt,
			"created_at":       createdAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) RetryAutomationRun(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	runID := chi.URLParam(r, "id")
	var ruleID, trig string
	var inputPayload json.RawMessage
	err := h.Pool.QueryRow(r.Context(), `
		SELECT rule_id, trigger_event, input_payload
		FROM automation_rule_runs
		WHERE id=$1 AND organization_id=$2
	`, runID, id.OrganizationID).Scan(&ruleID, &trig, &inputPayload)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "automation run not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	payloadMap := map[string]any{}
	if len(inputPayload) > 0 {
		_ = json.Unmarshal(inputPayload, &payloadMap)
	}
	payloadMap["trigger_event"] = trig
	payloadMap["rule_id"] = ruleID
	payloadMap["retry_of_run_id"] = runID
	b, _ := json.Marshal(payloadMap)

	var eventID string
	err = h.Pool.QueryRow(r.Context(), `
		INSERT INTO event_log (organization_id, event_type, payload)
		VALUES ($1, 'automation.evaluate', $2) RETURNING id
	`, id.OrganizationID, string(b)).Scan(&eventID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to enqueue retry")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "automation_run.retry", "automation_rule_run", runID, map[string]any{"event_id": eventID, "rule_id": ruleID})
	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"status":   "requeued",
		"run_id":   runID,
		"event_id": eventID,
	})
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
	if req.RequestType != "export" && req.RequestType != "redact" {
		httpx.Error(w, http.StatusBadRequest, "invalid request_type")
		return
	}
	var contactExists bool
	if err := h.Pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM contacts WHERE id=$1 AND organization_id=$2)
	`, req.ContactID, id.OrganizationID).Scan(&contactExists); err != nil || !contactExists {
		httpx.Error(w, http.StatusNotFound, "contact not found")
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
	var contactID, rtype, status string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT contact_id, request_type, status
		FROM lgpd_requests
		WHERE id=$1 AND organization_id=$2
	`, lid, id.OrganizationID).Scan(&contactID, &rtype, &status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "request not found")
		return
	}
	if status != "pending" {
		httpx.Error(w, http.StatusConflict, "request already processed")
		return
	}

	var contactExists bool
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM contacts WHERE id=$1 AND organization_id=$2)
	`, contactID, id.OrganizationID).Scan(&contactExists)
	if !contactExists {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}

	if rtype == "redact" {
		tx, err := h.Pool.Begin(r.Context())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback(r.Context())

		if _, err := tx.Exec(r.Context(), `
			UPDATE contacts
			SET name='Anonymized Contact', display_name=NULL, phone_number=NULL, email=NULL, cpf=NULL,
			    tags='{}', custom_fields='{}', is_anonymized=true, updated_at=now()
			WHERE id=$1 AND organization_id=$2
		`, contactID, id.OrganizationID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to redact contact")
			return
		}
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM contact_phones WHERE contact_id=$1 AND organization_id=$2
		`, contactID, id.OrganizationID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to redact contact phones")
			return
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE lgpd_requests SET status='completed', completed_at=now() WHERE id=$1 AND organization_id=$2
		`, lid, id.OrganizationID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to update request")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "commit failed")
			return
		}

		_ = auth.WriteAudit(r.Context(), h.Pool, id, "lgpd.redact", "contact", contactID, map[string]any{"request_id": lid})
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "redacted"})
		return
	}

	var name, email, phone, cpf string
	var tags []string
	var customFields, consent json.RawMessage
	err = h.Pool.QueryRow(r.Context(), `
		SELECT name, COALESCE(email,''), COALESCE(phone_number,''), COALESCE(cpf,''), tags, custom_fields, consent
		FROM contacts
		WHERE id=$1 AND organization_id=$2
	`, contactID, id.OrganizationID).Scan(&name, &email, &phone, &cpf, &tags, &customFields, &consent)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}

	phones := []map[string]any{}
	rows, err := h.Pool.Query(r.Context(), `
		SELECT phone_e164, label, is_primary FROM contact_phones WHERE contact_id=$1 AND organization_id=$2
	`, contactID, id.OrganizationID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var pe164, lbl string
			var isPrim bool
			if rows.Scan(&pe164, &lbl, &isPrim) == nil {
				phones = append(phones, map[string]any{"phone_e164": pe164, "label": lbl, "is_primary": isPrim})
			}
		}
	}

	exp, _ := json.Marshal(map[string]any{
		"contact_id":    contactID,
		"name":          name,
		"email":         email,
		"phone_number":  phone,
		"cpf":           cpf,
		"tags":          tags,
		"custom_fields": json.RawMessage(customFields),
		"consent":       json.RawMessage(consent),
		"phones":        phones,
	})
	_, _ = h.Pool.Exec(r.Context(), `
		UPDATE lgpd_requests SET status='completed', export_payload=$1, completed_at=now() WHERE id=$2 AND organization_id=$3
	`, string(exp), lid, id.OrganizationID)
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lgpd.export", "contact", contactID, map[string]any{"request_id": lid})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "exported", "data": json.RawMessage(exp)})
}

func (h *Handler) RejectLGPDRequest(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	var status string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT status FROM lgpd_requests WHERE id=$1 AND organization_id=$2
	`, lid, id.OrganizationID).Scan(&status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "request not found")
		return
	}
	if status != "pending" {
		httpx.Error(w, http.StatusConflict, "request already processed")
		return
	}
	if _, err := h.Pool.Exec(r.Context(), `
		UPDATE lgpd_requests SET status='rejected', completed_at=now() WHERE id=$1 AND organization_id=$2
	`, lid, id.OrganizationID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lgpd.reject", "lgpd_request", lid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "rejected"})
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

type AuditFilter struct {
	Actor        string
	Action       string
	ResourceType string
	From         string
	To           string
	Query        string
	Limit        int
	Offset       int
}

func BuildAuditQuery(orgID string, f AuditFilter) (string, []any) {
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	} else if limit > 500 {
		limit = 500
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	args := []any{orgID}
	conds := []string{"organization_id = $1"}

	addArg := func(val any) string {
		args = append(args, val)
		return fmt.Sprintf("$%d", len(args))
	}

	if v := strings.TrimSpace(f.Actor); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("actor_user_id::text = %s", p))
	}
	if v := strings.TrimSpace(f.Action); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("action = %s", p))
	}
	if v := strings.TrimSpace(f.ResourceType); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("resource_type = %s", p))
	}
	if v := strings.TrimSpace(f.From); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("created_at >= %s::timestamptz", p))
	}
	if v := strings.TrimSpace(f.To); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("created_at <= %s::timestamptz", p))
	}
	if v := strings.TrimSpace(f.Query); v != "" {
		p := addArg("%" + v + "%")
		conds = append(conds, fmt.Sprintf("(action ILIKE %s OR resource_type ILIKE %s OR COALESCE(resource_id,'') ILIKE %s OR metadata::text ILIKE %s)", p, p, p, p))
	}

	limPlaceholder := addArg(limit)
	offPlaceholder := addArg(offset)

	sql := fmt.Sprintf(`
		SELECT id, action, resource_type, COALESCE(resource_id,''),
		       COALESCE(actor_user_id::text,''), COALESCE(support_session_id::text,''), COALESCE(ip_address,''),
		       metadata, created_at
		FROM api_audit_log
		WHERE %s
		ORDER BY created_at DESC
		LIMIT %s OFFSET %s
	`, strings.Join(conds, " AND "), limPlaceholder, offPlaceholder)

	return sql, args
}

func (h *Handler) ListAudit(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	q := r.URL.Query()
	filter := AuditFilter{
		Actor:        q.Get("actor"),
		Action:       q.Get("action"),
		ResourceType: q.Get("resource_type"),
		From:         q.Get("from"),
		To:           q.Get("to"),
		Query:        q.Get("q"),
		Limit:        parseBoundedInt(q.Get("limit"), 100, 1, 500),
		Offset:       parseBoundedInt(q.Get("offset"), 0, 0, 100000),
	}
	sqlQuery, args := BuildAuditQuery(id.OrganizationID, filter)
	rows, err := h.Pool.Query(r.Context(), sqlQuery, args...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var aid, act, rtype, rid, actorID, suppSessID, ipAddr string
		var meta any
		var created any
		_ = rows.Scan(&aid, &act, &rtype, &rid, &actorID, &suppSessID, &ipAddr, &meta, &created)
		out = append(out, map[string]any{
			"id":                 aid,
			"action":             act,
			"resource_type":      rtype,
			"resource_id":        rid,
			"actor_user_id":      actorID,
			"support_session_id": suppSessID,
			"ip_address":         ipAddr,
			"metadata":           meta,
			"created_at":         created,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

type ActivitiesFilter struct {
	Type      string
	ContactID string
	LeadID    string
	From      string
	To        string
	Limit     int
}

func BuildActivitiesQuery(orgID string, f ActivitiesFilter) (string, []any) {
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	} else if limit > 200 {
		limit = 200
	}

	args := []any{orgID}
	conds := []string{"a.organization_id = $1"}

	addArg := func(val any) string {
		args = append(args, val)
		return fmt.Sprintf("$%d", len(args))
	}

	if v := strings.TrimSpace(f.Type); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("a.type = %s", p))
	}
	if v := strings.TrimSpace(f.ContactID); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("a.contact_id::text = %s", p))
	}
	if v := strings.TrimSpace(f.LeadID); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("a.lead_id::text = %s", p))
	}
	if v := strings.TrimSpace(f.From); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("a.performed_at >= %s::timestamptz", p))
	}
	if v := strings.TrimSpace(f.To); v != "" {
		p := addArg(v)
		conds = append(conds, fmt.Sprintf("a.performed_at <= %s::timestamptz", p))
	}

	limPlaceholder := addArg(limit)

	sql := fmt.Sprintf(`
		SELECT a.id, COALESCE(a.lead_id::text,''), COALESCE(a.contact_id::text,''),
		       COALESCE(c.name,''), COALESCE(a.actor_user_id::text,''), COALESCE(u.full_name,''),
		       a.type, a.summary, a.metadata, a.performed_at
		FROM crm_lead_activities a
		LEFT JOIN contacts c ON c.id = a.contact_id
		LEFT JOIN users u ON u.id = a.actor_user_id
		WHERE %s
		ORDER BY a.performed_at DESC
		LIMIT %s
	`, strings.Join(conds, " AND "), limPlaceholder)

	return sql, args
}

func (h *Handler) ListActivities(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	q := r.URL.Query()
	filter := ActivitiesFilter{
		Type:      q.Get("type"),
		ContactID: q.Get("contact_id"),
		LeadID:    q.Get("lead_id"),
		From:      q.Get("from"),
		To:        q.Get("to"),
		Limit:     parseBoundedInt(q.Get("limit"), 50, 1, 200),
	}
	sqlQuery, args := BuildActivitiesQuery(id.OrganizationID, filter)
	rows, err := h.Pool.Query(r.Context(), sqlQuery, args...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var aid, leadID, contactID, contactName, actorID, actorName, typ, summary string
		var meta any
		var performedAt any
		_ = rows.Scan(&aid, &leadID, &contactID, &contactName, &actorID, &actorName, &typ, &summary, &meta, &performedAt)
		out = append(out, map[string]any{
			"id":            aid,
			"lead_id":       leadID,
			"contact_id":    contactID,
			"contact_name":  contactName,
			"actor_user_id": actorID,
			"actor_name":    actorName,
			"type":          typ,
			"summary":       summary,
			"metadata":      meta,
			"performed_at":  performedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) GetMetrics(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var contactsCnt, leadsOpen, leadsWon, leadsLost, convOpen, msgsToday int
	var revWon, revOpen int64
	var aiRunsTotal, aiCasesOpen, aiCasesTotal int

	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM contacts WHERE organization_id=$1 AND is_merged_into IS NULL`, id.OrganizationID).Scan(&contactsCnt)
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT
			COUNT(*) FILTER (WHERE status='open'),
			COUNT(*) FILTER (WHERE status='won'),
			COUNT(*) FILTER (WHERE status='lost'),
			COALESCE(SUM(value_cents) FILTER (WHERE status='won'), 0),
			COALESCE(SUM(value_cents) FILTER (WHERE status='open'), 0)
		FROM crm_leads WHERE organization_id=$1
	`, id.OrganizationID).Scan(&leadsOpen, &leadsWon, &leadsLost, &revWon, &revOpen)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM conversations WHERE organization_id=$1 AND status IN ('open','pending','ai_handling','claimed')`, id.OrganizationID).Scan(&convOpen)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM messages WHERE organization_id=$1 AND sent_at >= date_trunc('day', now())`, id.OrganizationID).Scan(&msgsToday)
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM ai_agent_runs WHERE organization_id=$1`, id.OrganizationID).Scan(&aiRunsTotal)
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FILTER (WHERE status='awaiting_human'), COUNT(*)
		FROM agent_cases WHERE organization_id=$1
	`, id.OrganizationID).Scan(&aiCasesOpen, &aiCasesTotal)

	leadsTotal := leadsOpen + leadsWon + leadsLost
	convRate := 0.0
	if leadsTotal > 0 {
		convRate = math.Round((float64(leadsWon)/float64(leadsTotal))*10000) / 100
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"contacts_total":     contactsCnt,
		"leads_open":         leadsOpen,
		"leads_won":          leadsWon,
		"leads_lost":         leadsLost,
		"leads_total":        leadsTotal,
		"conversion_rate":    convRate,
		"revenue_won_cents":  revWon,
		"revenue_open_cents": revOpen,
		"conversations_open": convOpen,
		"messages_today":     msgsToday,
		"ai_runs_total":      aiRunsTotal,
		"ai_cases_open":      aiCasesOpen,
		"ai_cases_total":     aiCasesTotal,
	})
}

func (h *Handler) GetFunnelMetrics(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pipelineID := strings.TrimSpace(r.URL.Query().Get("pipeline_id"))
	rows, err := h.Pool.Query(r.Context(), `
		SELECT p.id, p.name, s.id, s.name, s.position, s.color, s.is_won, s.is_lost,
		       COUNT(l.id) AS leads_count,
		       COALESCE(SUM(l.value_cents), 0) AS value_cents
		FROM crm_pipelines p
		JOIN crm_stages s ON s.pipeline_id = p.id
		LEFT JOIN crm_leads l ON l.stage_id = s.id AND l.organization_id = p.organization_id
		WHERE p.organization_id = $1
		  AND ($2 = '' OR p.id::text = $2)
		GROUP BY p.id, p.name, p.is_default, p.created_at, s.id, s.name, s.position, s.color, s.is_won, s.is_lost
		ORDER BY p.is_default DESC, p.created_at ASC, s.position ASC
	`, id.OrganizationID, pipelineID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pID, pName, sID, sName, color string
		var pos float64
		var isWon, isLost bool
		var leadsCnt int
		var valCents int64
		_ = rows.Scan(&pID, &pName, &sID, &sName, &pos, &color, &isWon, &isLost, &leadsCnt, &valCents)
		out = append(out, map[string]any{
			"pipeline_id":   pID,
			"pipeline_name": pName,
			"stage_id":      sID,
			"stage_name":    sName,
			"position":      pos,
			"color":         color,
			"is_won":        isWon,
			"is_lost":       isLost,
			"leads_count":   leadsCnt,
			"value_cents":   valCents,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) GetAttendantMetrics(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT u.id, u.full_name, u.email, uo.role,
		       (SELECT COUNT(*) FROM conversations c WHERE c.organization_id = $1 AND c.assigned_to = u.id AND c.status IN ('open','pending','claimed')) AS conv_assigned,
		       (SELECT COUNT(*) FROM conversations c WHERE c.organization_id = $1 AND c.assigned_to = u.id AND c.status = 'resolved') AS conv_resolved,
		       (SELECT COUNT(*) FROM crm_leads l WHERE l.organization_id = $1 AND l.owner_user_id = u.id) AS leads_owned,
		       (SELECT COUNT(*) FROM crm_tasks t WHERE t.organization_id = $1 AND t.assigned_to = u.id AND t.status = 'done') AS tasks_done
		FROM user_organizations uo
		JOIN users u ON u.id = uo.user_id
		WHERE uo.organization_id = $1
		ORDER BY u.full_name ASC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var uid, fullName, email, role string
		var convAssigned, convResolved, leadsOwned, tasksDone int
		_ = rows.Scan(&uid, &fullName, &email, &role, &convAssigned, &convResolved, &leadsOwned, &tasksDone)
		out = append(out, map[string]any{
			"user_id":                uid,
			"full_name":              fullName,
			"email":                  email,
			"role":                   role,
			"conversations_assigned": convAssigned,
			"conversations_resolved": convResolved,
			"leads_owned":            leadsOwned,
			"tasks_done":             tasksDone,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func parseBoundedInt(raw string, def, minVal, maxVal int) int {
	if strings.TrimSpace(raw) == "" {
		return def
	}
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return def
	}
	if v < minVal {
		return minVal
	}
	if v > maxVal {
		return maxVal
	}
	return v
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
