package crm

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (h *Handler) ListLeads(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pipelineID := r.URL.Query().Get("pipeline_id")
	rows, err := h.Pool.Query(r.Context(), `
		SELECT l.id, l.contact_id, c.name, COALESCE(c.phone_number,''), l.pipeline_id, l.stage_id,
		       l.title, l.position_in_stage, l.value_cents, l.currency, l.status,
		       COALESCE(l.loss_reason,''), l.owner_user_id::text, COALESCE(l.source,'manual'),
		       l.custom_fields, l.tags, l.version, l.last_activity_at, l.created_at, l.updated_at
		FROM crm_leads l
		JOIN contacts c ON c.id = l.contact_id
		WHERE l.organization_id = $1 AND ($2 = '' OR l.pipeline_id::text = $2)
		ORDER BY l.position_in_stage ASC
	`, id.OrganizationID, pipelineID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var lid, cid, cname, cphone, pid, sid, title, curr, status, lossReason, source string
		var ownerID *string
		var pos float64
		var val int64
		var customFields map[string]any
		var tags []string
		var ver int
		var lastAct, createdAt, updatedAt any
		_ = rows.Scan(&lid, &cid, &cname, &cphone, &pid, &sid, &title, &pos, &val, &curr, &status,
			&lossReason, &ownerID, &source, &customFields, &tags, &ver, &lastAct, &createdAt, &updatedAt)
		if customFields == nil {
			customFields = map[string]any{}
		}
		if tags == nil {
			tags = []string{}
		}
		out = append(out, map[string]any{
			"id": lid, "contact_id": cid, "contact_name": cname, "contact_phone": cphone,
			"pipeline_id": pid, "stage_id": sid, "title": title, "position_in_stage": pos,
			"value_cents": val, "currency": curr, "status": status, "loss_reason": lossReason,
			"owner_user_id": ownerID, "source": source, "custom_fields": customFields,
			"tags": tags, "version": ver, "last_activity_at": lastAct,
			"created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) GetLead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")

	var cid, cname, cphone, cemail, pid, sid, title, curr, status, lossReason, source string
	var ownerID *string
	var pos float64
	var val int64
	var customFields map[string]any
	var tags []string
	var ver int
	var lastAct, createdAt, updatedAt any
	err := h.Pool.QueryRow(r.Context(), `
		SELECT l.contact_id, c.name, COALESCE(c.phone_number,''), COALESCE(c.email,''),
		       l.pipeline_id, l.stage_id, l.title, l.position_in_stage, l.value_cents,
		       l.currency, l.status, COALESCE(l.loss_reason,''), l.owner_user_id::text,
		       COALESCE(l.source,'manual'), l.custom_fields, l.tags, l.version,
		       l.last_activity_at, l.created_at, l.updated_at
		FROM crm_leads l
		JOIN contacts c ON c.id = l.contact_id
		WHERE l.id = $1 AND l.organization_id = $2
	`, lid, id.OrganizationID).Scan(&cid, &cname, &cphone, &cemail, &pid, &sid, &title, &pos, &val,
		&curr, &status, &lossReason, &ownerID, &source, &customFields, &tags, &ver,
		&lastAct, &createdAt, &updatedAt)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "lead not found")
		return
	}
	if customFields == nil {
		customFields = map[string]any{}
	}
	if tags == nil {
		tags = []string{}
	}

	// Pipeline & Stages
	var pname, ptype string
	var vocab map[string]any
	var fieldsSchema []any
	var isDef bool
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT name, pipeline_type, vocabulary, fields_schema, is_default
		FROM crm_pipelines WHERE id = $1 AND organization_id = $2
	`, pid, id.OrganizationID).Scan(&pname, &ptype, &vocab, &fieldsSchema, &isDef)
	if vocab == nil {
		vocab = map[string]any{"deal": "Lead", "deals": "Leads", "stage": "Etapa"}
	}
	if fieldsSchema == nil {
		fieldsSchema = []any{}
	}

	sRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, name, position, color, is_won, is_lost, requires_human
		FROM crm_stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY position ASC
	`, pid, id.OrganizationID)
	stages := []map[string]any{}
	var currentStage map[string]any
	if sRows != nil {
		for sRows.Next() {
			var stID, stName, stColor string
			var stPos float64
			var stWon, stLost, stReqHuman bool
			_ = sRows.Scan(&stID, &stName, &stPos, &stColor, &stWon, &stLost, &stReqHuman)
			stObj := map[string]any{
				"id": stID, "name": stName, "position": stPos, "color": stColor,
				"is_won": stWon, "is_lost": stLost, "requires_human": stReqHuman,
			}
			stages = append(stages, stObj)
			if stID == sid {
				currentStage = stObj
			}
		}
		sRows.Close()
	}

	// Activities
	aRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, type, summary, metadata, actor_user_id::text, performed_at
		FROM crm_lead_activities
		WHERE organization_id = $1 AND lead_id = $2
		ORDER BY performed_at DESC LIMIT 100
	`, id.OrganizationID, lid)
	activities := []map[string]any{}
	if aRows != nil {
		for aRows.Next() {
			var aid, atype, summary string
			var meta map[string]any
			var actorID *string
			var ts any
			_ = aRows.Scan(&aid, &atype, &summary, &meta, &actorID, &ts)
			if meta == nil {
				meta = map[string]any{}
			}
			activities = append(activities, map[string]any{
				"id": aid, "type": atype, "summary": summary, "metadata": meta,
				"actor_user_id": actorID, "performed_at": ts,
			})
		}
		aRows.Close()
	}

	// Links
	lkRows, _ := h.Pool.Query(r.Context(), `
		SELECT ll.id, ll.source_lead_id, ll.target_lead_id, ll.link_type, ll.created_at,
		       CASE WHEN ll.source_lead_id = $2 THEN tl.id ELSE sl.id END AS linked_id,
		       CASE WHEN ll.source_lead_id = $2 THEN tl.title ELSE sl.title END AS linked_title,
		       CASE WHEN ll.source_lead_id = $2 THEN tl.status ELSE sl.status END AS linked_status,
		       CASE WHEN ll.source_lead_id = $2 THEN tl.pipeline_id ELSE sl.pipeline_id END AS linked_pipeline_id,
		       CASE WHEN ll.source_lead_id = $2 THEN 'outbound' ELSE 'inbound' END AS direction
		FROM crm_lead_links ll
		JOIN crm_leads sl ON sl.id = ll.source_lead_id
		JOIN crm_leads tl ON tl.id = ll.target_lead_id
		WHERE ll.organization_id = $1 AND (ll.source_lead_id = $2 OR ll.target_lead_id = $2)
		ORDER BY ll.created_at DESC
	`, id.OrganizationID, lid)
	links := []map[string]any{}
	if lkRows != nil {
		for lkRows.Next() {
			var lkID, srcID, tgtID, lkType, linkedID, linkedTitle, linkedStatus, linkedPipeID, dir string
			var ts any
			_ = lkRows.Scan(&lkID, &srcID, &tgtID, &lkType, &ts, &linkedID, &linkedTitle, &linkedStatus, &linkedPipeID, &dir)
			links = append(links, map[string]any{
				"id": lkID, "source_lead_id": srcID, "target_lead_id": tgtID,
				"link_type": lkType, "created_at": ts, "linked_lead_id": linkedID,
				"linked_lead_title": linkedTitle, "linked_lead_status": linkedStatus,
				"linked_pipeline_id": linkedPipeID, "direction": dir,
			})
		}
		lkRows.Close()
	}

	// Attachments
	attRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, file_name, file_url, COALESCE(mime_type,''), size_bytes, uploaded_by::text, created_at
		FROM crm_lead_attachments
		WHERE organization_id = $1 AND lead_id = $2
		ORDER BY created_at DESC
	`, id.OrganizationID, lid)
	attachments := []map[string]any{}
	if attRows != nil {
		for attRows.Next() {
			var attID, fname, furl, mime string
			var sz int64
			var upBy *string
			var ts any
			_ = attRows.Scan(&attID, &fname, &furl, &mime, &sz, &upBy, &ts)
			attachments = append(attachments, map[string]any{
				"id": attID, "file_name": fname, "file_url": furl,
				"mime_type": mime, "size_bytes": sz, "uploaded_by": upBy, "created_at": ts,
			})
		}
		attRows.Close()
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": lid, "contact_id": cid, "pipeline_id": pid, "stage_id": sid,
		"title": title, "position_in_stage": pos, "value_cents": val,
		"currency": curr, "status": status, "loss_reason": lossReason,
		"owner_user_id": ownerID, "source": source, "custom_fields": customFields,
		"tags": tags, "version": ver, "last_activity_at": lastAct,
		"created_at": createdAt, "updated_at": updatedAt,
		"contact": map[string]any{
			"id": cid, "name": cname, "phone_number": cphone, "email": cemail,
		},
		"pipeline": map[string]any{
			"id": pid, "name": pname, "pipeline_type": ptype,
			"vocabulary": vocab, "fields_schema": fieldsSchema, "is_default": isDef,
		},
		"stage":       currentStage,
		"stages":      stages,
		"activities":  activities,
		"links":       links,
		"attachments": attachments,
	})
}

func (h *Handler) CreateLead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		ContactID       string         `json:"contact_id"`
		PipelineID      string         `json:"pipeline_id"`
		StageID         string         `json:"stage_id"`
		Title           string         `json:"title"`
		ValueCents      int64          `json:"value_cents"`
		Currency        string         `json:"currency"`
		OwnerUserID     *string        `json:"owner_user_id"`
		Source          string         `json:"source"`
		CustomFields    map[string]any `json:"custom_fields"`
		Tags            []string       `json:"tags"`
		PositionInStage *float64       `json:"position_in_stage"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.ContactID) == "" || strings.TrimSpace(req.Title) == "" {
		httpx.Error(w, http.StatusBadRequest, "contact_id and title are required")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Currency == "" {
		req.Currency = "USD"
	}
	if req.Source == "" {
		req.Source = "manual"
	}
	if req.CustomFields == nil {
		req.CustomFields = map[string]any{}
	}
	if req.Tags == nil {
		req.Tags = []string{}
	}
	ownerID := id.UserID
	if req.OwnerUserID != nil {
		s := strings.TrimSpace(*req.OwnerUserID)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid owner_user_id")
				return
			}
			ownerID = s
		}
	}

	var contactExists string
	if err := h.Pool.QueryRow(r.Context(), `SELECT id FROM contacts WHERE id = $1 AND organization_id = $2`, req.ContactID, id.OrganizationID).Scan(&contactExists); err != nil {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}

	if req.PipelineID == "" || req.StageID == "" {
		if err := h.Pool.QueryRow(r.Context(), `
			SELECT p.id, s.id FROM crm_pipelines p
			JOIN crm_stages s ON s.pipeline_id = p.id
			WHERE p.organization_id = $1 ORDER BY p.is_default DESC, s.position ASC LIMIT 1
		`, id.OrganizationID).Scan(&req.PipelineID, &req.StageID); err != nil {
			httpx.Error(w, http.StatusBadRequest, "no pipeline or stage available")
			return
		}
	} else {
		var stageExists string
		if err := h.Pool.QueryRow(r.Context(), `SELECT id FROM crm_stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3`, req.StageID, req.PipelineID, id.OrganizationID).Scan(&stageExists); err != nil {
			httpx.Error(w, http.StatusNotFound, "pipeline or stage not found")
			return
		}
	}

	pos := 1000.0
	if req.PositionInStage != nil {
		pos = *req.PositionInStage
	} else {
		_ = h.Pool.QueryRow(r.Context(), `SELECT COALESCE(MAX(position_in_stage), 0) + 1000 FROM crm_leads WHERE stage_id = $1 AND organization_id = $2`, req.StageID, id.OrganizationID).Scan(&pos)
	}

	cfJSON, _ := json.Marshal(req.CustomFields)
	var lid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_leads (organization_id, contact_id, pipeline_id, stage_id, title, position_in_stage, value_cents, currency, owner_user_id, source, custom_fields, tags)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12) RETURNING id
	`, id.OrganizationID, req.ContactID, req.PipelineID, req.StageID, req.Title, pos, req.ValueCents, req.Currency, ownerID, req.Source, string(cfJSON), req.Tags).Scan(&lid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create lead")
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `INSERT INTO crm_lead_activities (organization_id, lead_id, contact_id, actor_user_id, type, summary) VALUES ($1,$2,$3,$4,'lead_created',$5)`, id.OrganizationID, lid, req.ContactID, id.UserID, "Creado: "+req.Title)
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead.create", "lead", lid, map[string]any{"title": req.Title, "stage_id": req.StageID})
	if h.Hub != nil {
		h.Hub.Publish(id.OrganizationID, "lead.created", map[string]any{"id": lid, "stage_id": req.StageID})
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": lid, "title": req.Title, "stage_id": req.StageID, "pipeline_id": req.PipelineID,
		"position_in_stage": pos, "value_cents": req.ValueCents, "currency": req.Currency, "version": 1,
	})
}

func (h *Handler) UpdateLead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	var req struct {
		StageID         *string        `json:"stage_id"`
		PositionInStage *float64       `json:"position_in_stage"`
		Title           *string        `json:"title"`
		ValueCents      *int64         `json:"value_cents"`
		Currency        *string        `json:"currency"`
		Status          *string        `json:"status"`
		LossReason      *string        `json:"loss_reason"`
		OwnerUserID     *string        `json:"owner_user_id"`
		CustomFields    map[string]any `json:"custom_fields"`
		Tags            []string       `json:"tags"`
		ExpectedVersion *int           `json:"version"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Status != nil && *req.Status != "open" && *req.Status != "won" && *req.Status != "lost" {
		httpx.Error(w, http.StatusBadRequest, "invalid status")
		return
	}

	if req.StageID != nil {
		s := strings.TrimSpace(*req.StageID)
		if s == "" {
			req.StageID = nil
		} else {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid stage_id")
				return
			}
			req.StageID = &s
		}
	}

	if req.OwnerUserID != nil {
		s := strings.TrimSpace(*req.OwnerUserID)
		if s == "" {
			req.OwnerUserID = nil
		} else {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid owner_user_id")
				return
			}
			req.OwnerUserID = &s
		}
	}

	newStatus := ""
	var stageName string
	var newPipelineID *string
	if req.StageID != nil {
		var stagePipeID string
		var won, lost bool
		if err := h.Pool.QueryRow(r.Context(), `SELECT pipeline_id, name, is_won, is_lost FROM crm_stages WHERE id = $1 AND organization_id = $2`, *req.StageID, id.OrganizationID).Scan(&stagePipeID, &stageName, &won, &lost); err != nil {
			httpx.Error(w, http.StatusNotFound, "stage not found")
			return
		}
		newPipelineID = &stagePipeID
		if req.Status != nil && *req.Status != "" {
			newStatus = *req.Status
		} else if won {
			newStatus = "won"
		} else if lost {
			newStatus = "lost"
		} else {
			newStatus = "open"
		}
	} else if req.Status != nil {
		newStatus = *req.Status
	}

	var cfParam *string
	if req.CustomFields != nil {
		b, _ := json.Marshal(req.CustomFields)
		s := string(b)
		cfParam = &s
	}

	var newVer int
	var contactID, finalStageID, finalStatus string
	var err error
	if req.ExpectedVersion != nil {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE crm_leads SET
				stage_id = COALESCE(NULLIF($4, '')::uuid, stage_id),
				pipeline_id = COALESCE(NULLIF($14, '')::uuid, pipeline_id),
				position_in_stage = COALESCE($5, position_in_stage),
				title = COALESCE($6, title),
				value_cents = COALESCE($7, value_cents),
				currency = COALESCE($8, currency),
				status = CASE WHEN $9 <> '' THEN $9 ELSE status END,
				loss_reason = COALESCE($10, loss_reason),
				owner_user_id = COALESCE(NULLIF($11, '')::uuid, owner_user_id),
				custom_fields = COALESCE($12::jsonb, custom_fields),
				tags = COALESCE($13, tags),
				version = version + 1,
				last_activity_at = now(),
				updated_at = now()
			WHERE id = $1 AND organization_id = $2 AND version = $3
			RETURNING version, contact_id, stage_id, status
		`, lid, id.OrganizationID, *req.ExpectedVersion, req.StageID, req.PositionInStage, req.Title, req.ValueCents,
			req.Currency, newStatus, req.LossReason, req.OwnerUserID, cfParam, req.Tags, newPipelineID).Scan(&newVer, &contactID, &finalStageID, &finalStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			var curVer int
			if qErr := h.Pool.QueryRow(r.Context(), `SELECT version FROM crm_leads WHERE id = $1 AND organization_id = $2`, lid, id.OrganizationID).Scan(&curVer); qErr != nil {
				httpx.Error(w, http.StatusNotFound, "lead not found")
				return
			}
			httpx.JSON(w, http.StatusConflict, map[string]any{
				"error":           "version_conflict",
				"current_version": curVer,
			})
			return
		}
	} else {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE crm_leads SET
				stage_id = COALESCE(NULLIF($3, '')::uuid, stage_id),
				pipeline_id = COALESCE(NULLIF($13, '')::uuid, pipeline_id),
				position_in_stage = COALESCE($4, position_in_stage),
				title = COALESCE($5, title),
				value_cents = COALESCE($6, value_cents),
				currency = COALESCE($7, currency),
				status = CASE WHEN $8 <> '' THEN $8 ELSE status END,
				loss_reason = COALESCE($9, loss_reason),
				owner_user_id = COALESCE(NULLIF($10, '')::uuid, owner_user_id),
				custom_fields = COALESCE($11::jsonb, custom_fields),
				tags = COALESCE($12, tags),
				version = version + 1,
				last_activity_at = now(),
				updated_at = now()
			WHERE id = $1 AND organization_id = $2
			RETURNING version, contact_id, stage_id, status
		`, lid, id.OrganizationID, req.StageID, req.PositionInStage, req.Title, req.ValueCents,
			req.Currency, newStatus, req.LossReason, req.OwnerUserID, cfParam, req.Tags, newPipelineID).Scan(&newVer, &contactID, &finalStageID, &finalStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "lead not found")
			return
		}
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}

	if req.StageID != nil {
		_, _ = h.Pool.Exec(r.Context(), `
			INSERT INTO crm_lead_activities (organization_id, lead_id, contact_id, actor_user_id, type, summary, metadata)
			VALUES ($1, $2, $3, $4, 'stage_changed', $5, jsonb_build_object('stage_id', $6::text, 'stage_name', $7::text))
		`, id.OrganizationID, lid, contactID, id.UserID, "Movido a etapa: "+stageName, finalStageID, stageName)
	} else if req.Status != nil {
		_, _ = h.Pool.Exec(r.Context(), `
			INSERT INTO crm_lead_activities (organization_id, lead_id, contact_id, actor_user_id, type, summary)
			VALUES ($1, $2, $3, $4, 'status_changed', $5)
		`, id.OrganizationID, lid, contactID, id.UserID, "Estado actualizado: "+finalStatus)
	}

	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead.update", "lead", lid, map[string]any{"version": newVer, "stage_id": finalStageID, "status": finalStatus})
	if h.Hub != nil {
		h.Hub.Publish(id.OrganizationID, "lead.updated", map[string]any{"id": lid, "stage_id": finalStageID, "version": newVer})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "updated", "version": newVer, "lead_status": finalStatus})
}

func (h *Handler) DeleteLead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM crm_leads WHERE id = $1 AND organization_id = $2`, lid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "lead not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead.delete", "lead", lid, map[string]any{})
	if h.Hub != nil {
		h.Hub.Publish(id.OrganizationID, "lead.deleted", map[string]any{"id": lid})
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) BulkMoveLeads(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		LeadIDs     []string `json:"lead_ids"`
		Action      string   `json:"action"`
		StageID     string   `json:"stage_id"`
		OwnerUserID *string  `json:"owner_user_id"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(req.LeadIDs) == 0 {
		httpx.Error(w, http.StatusBadRequest, "lead_ids required")
		return
	}
	if len(req.LeadIDs) > 50 {
		httpx.Error(w, http.StatusUnprocessableEntity, "bulk_limit_exceeded")
		return
	}
	action := strings.TrimSpace(req.Action)
	if action == "" {
		action = "move_stage"
	}

	var affected int64
	switch action {
	case "move_stage":
		if req.StageID == "" {
			httpx.Error(w, http.StatusBadRequest, "stage_id required")
			return
		}
		var won, lost bool
		if err := h.Pool.QueryRow(r.Context(), `SELECT is_won, is_lost FROM crm_stages WHERE id = $1 AND organization_id = $2`, req.StageID, id.OrganizationID).Scan(&won, &lost); err != nil {
			httpx.Error(w, http.StatusNotFound, "stage not found")
			return
		}
		newStatus := "open"
		if won {
			newStatus = "won"
		} else if lost {
			newStatus = "lost"
		}
		tag, err := h.Pool.Exec(r.Context(), `
			UPDATE crm_leads SET stage_id = $1, status = $2, version = version + 1, last_activity_at = now(), updated_at = now()
			WHERE organization_id = $3 AND id = ANY($4::uuid[])
		`, req.StageID, newStatus, id.OrganizationID, req.LeadIDs)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "bulk move failed")
			return
		}
		affected = tag.RowsAffected()
	case "assign":
		if req.OwnerUserID == nil || *req.OwnerUserID == "" {
			httpx.Error(w, http.StatusBadRequest, "owner_user_id required")
			return
		}
		tag, err := h.Pool.Exec(r.Context(), `
			UPDATE crm_leads SET owner_user_id = $1::uuid, version = version + 1, updated_at = now()
			WHERE organization_id = $2 AND id = ANY($3::uuid[])
		`, *req.OwnerUserID, id.OrganizationID, req.LeadIDs)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "bulk assign failed")
			return
		}
		affected = tag.RowsAffected()
	case "delete":
		tag, err := h.Pool.Exec(r.Context(), `
			DELETE FROM crm_leads WHERE organization_id = $1 AND id = ANY($2::uuid[])
		`, id.OrganizationID, req.LeadIDs)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "bulk delete failed")
			return
		}
		affected = tag.RowsAffected()
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid action")
		return
	}

	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead.bulk_"+action, "lead", "", map[string]any{"count": affected, "lead_ids": req.LeadIDs})
	if h.Hub != nil {
		h.Hub.Publish(id.OrganizationID, "lead.updated", map[string]any{"bulk_action": action, "count": affected})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": affected, "moved": affected})
}

func (h *Handler) CreateLeadLink(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	sourceID := chi.URLParam(r, "id")
	var req struct {
		TargetLeadID string `json:"target_lead_id"`
		LinkType     string `json:"link_type"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.TargetLeadID) == "" {
		httpx.Error(w, http.StatusBadRequest, "target_lead_id required")
		return
	}
	if sourceID == req.TargetLeadID {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot_link_self")
		return
	}
	if req.LinkType == "" {
		req.LinkType = "related"
	}
	switch req.LinkType {
	case "related", "blocks", "blocked_by", "duplicate", "ticket":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid link_type")
		return
	}

	var cnt int
	if err := h.Pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM crm_leads WHERE organization_id = $1 AND id IN ($2::uuid, $3::uuid)
	`, id.OrganizationID, sourceID, req.TargetLeadID).Scan(&cnt); err != nil || cnt != 2 {
		httpx.Error(w, http.StatusNotFound, "lead not found")
		return
	}

	var linkID string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_lead_links (organization_id, source_lead_id, target_lead_id, link_type, created_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING id
	`, id.OrganizationID, sourceID, req.TargetLeadID, req.LinkType, id.UserID).Scan(&linkID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			httpx.Error(w, http.StatusConflict, "link_already_exists")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "failed to create link")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead_link.create", "lead_link", linkID, map[string]any{"source": sourceID, "target": req.TargetLeadID, "type": req.LinkType})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": linkID, "source_lead_id": sourceID, "target_lead_id": req.TargetLeadID, "link_type": req.LinkType,
	})
}

func (h *Handler) DeleteLeadLink(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	linkID := chi.URLParam(r, "linkId")
	tag, err := h.Pool.Exec(r.Context(), `
		DELETE FROM crm_lead_links
		WHERE id = $1 AND organization_id = $2 AND (source_lead_id = $3 OR target_lead_id = $3)
	`, linkID, id.OrganizationID, lid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "link not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead_link.delete", "lead_link", linkID, map[string]any{"lead_id": lid})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) CreateLeadActivity(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	var req struct {
		Type     string         `json:"type"`
		Summary  string         `json:"summary"`
		Metadata map[string]any `json:"metadata"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Summary) == "" {
		httpx.Error(w, http.StatusBadRequest, "summary required")
		return
	}
	if req.Type == "" {
		req.Type = "note"
	}
	if req.Metadata == nil {
		req.Metadata = map[string]any{}
	}

	var contactID string
	if err := h.Pool.QueryRow(r.Context(), `SELECT contact_id FROM crm_leads WHERE id = $1 AND organization_id = $2`, lid, id.OrganizationID).Scan(&contactID); err != nil {
		httpx.Error(w, http.StatusNotFound, "lead not found")
		return
	}
	metaJSON, _ := json.Marshal(req.Metadata)
	var aid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_lead_activities (organization_id, lead_id, contact_id, actor_user_id, type, summary, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id
	`, id.OrganizationID, lid, contactID, id.UserID, req.Type, strings.TrimSpace(req.Summary), string(metaJSON)).Scan(&aid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create activity")
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `UPDATE crm_leads SET last_activity_at = now(), updated_at = now() WHERE id = $1 AND organization_id = $2`, lid, id.OrganizationID)
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead_activity.create", "lead_activity", aid, map[string]any{"lead_id": lid, "type": req.Type})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": aid, "lead_id": lid, "type": req.Type, "summary": strings.TrimSpace(req.Summary), "metadata": req.Metadata,
	})
}

func (h *Handler) CreateLeadAttachment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	var req struct {
		FileName  string `json:"file_name"`
		FileURL   string `json:"file_url"`
		MimeType  string `json:"mime_type"`
		SizeBytes int64  `json:"size_bytes"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.FileName) == "" || strings.TrimSpace(req.FileURL) == "" {
		httpx.Error(w, http.StatusBadRequest, "file_name and file_url required")
		return
	}
	var exists string
	if err := h.Pool.QueryRow(r.Context(), `SELECT id FROM crm_leads WHERE id = $1 AND organization_id = $2`, lid, id.OrganizationID).Scan(&exists); err != nil {
		httpx.Error(w, http.StatusNotFound, "lead not found")
		return
	}
	var attID string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_lead_attachments (organization_id, lead_id, uploaded_by, file_name, file_url, mime_type, size_bytes)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6,''), $7) RETURNING id
	`, id.OrganizationID, lid, id.UserID, strings.TrimSpace(req.FileName), strings.TrimSpace(req.FileURL), strings.TrimSpace(req.MimeType), req.SizeBytes).Scan(&attID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create attachment")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead_attachment.create", "lead_attachment", attID, map[string]any{"lead_id": lid, "file_name": req.FileName})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": attID, "lead_id": lid, "file_name": strings.TrimSpace(req.FileName), "file_url": strings.TrimSpace(req.FileURL),
		"mime_type": req.MimeType, "size_bytes": req.SizeBytes,
	})
}

func (h *Handler) DeleteLeadAttachment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	attID := chi.URLParam(r, "attId")
	tag, err := h.Pool.Exec(r.Context(), `
		DELETE FROM crm_lead_attachments WHERE id = $1 AND lead_id = $2 AND organization_id = $3
	`, attID, lid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "attachment not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "lead_attachment.delete", "lead_attachment", attID, map[string]any{"lead_id": lid})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
