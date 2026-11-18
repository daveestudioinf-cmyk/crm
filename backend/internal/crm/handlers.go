package crm

import (
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	Pool *pgxpool.Pool
	Hub  *realtime.Hub
}

func (h *Handler) ListContacts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, COALESCE(phone_number,''), COALESCE(email,''), COALESCE(cpf,''), tags, is_blocked, force_human, is_anonymized, created_at
		FROM contacts
		WHERE organization_id = $1 AND is_merged_into IS NULL
		  AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR phone_number ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
		ORDER BY created_at DESC LIMIT 200
	`, id.OrganizationID, q)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, name, phone, email, cpf string
		var tags []string
		var blocked, forceHuman, anon bool
		var created any
		_ = rows.Scan(&cid, &name, &phone, &email, &cpf, &tags, &blocked, &forceHuman, &anon, &created)
		out = append(out, map[string]any{
			"id": cid, "name": name, "phone_number": phone, "email": email, "cpf": cpf,
			"tags": tags, "is_blocked": blocked, "force_human": forceHuman, "is_anonymized": anon, "created_at": created,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateContact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name        string   `json:"name"`
		PhoneNumber string   `json:"phone_number"`
		Email       string   `json:"email"`
		CPF         string   `json:"cpf"`
		Tags        []string `json:"tags"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Tags == nil {
		req.Tags = []string{}
	}

	// Deterministic identity resolution: cpf -> phone_number -> email
	var matchByCPF, matchByPhone, matchByEmail string
	if req.CPF != "" {
		_ = h.Pool.QueryRow(r.Context(), `SELECT id FROM contacts WHERE organization_id=$1 AND cpf=$2 AND is_merged_into IS NULL LIMIT 1`, id.OrganizationID, req.CPF).Scan(&matchByCPF)
	}
	if req.PhoneNumber != "" {
		_ = h.Pool.QueryRow(r.Context(), `SELECT id FROM contacts WHERE organization_id=$1 AND phone_number=$2 AND is_merged_into IS NULL LIMIT 1`, id.OrganizationID, req.PhoneNumber).Scan(&matchByPhone)
	}
	if req.Email != "" {
		_ = h.Pool.QueryRow(r.Context(), `SELECT id FROM contacts WHERE organization_id=$1 AND email=$2 AND is_merged_into IS NULL LIMIT 1`, id.OrganizationID, req.Email).Scan(&matchByEmail)
	}

	// Detect conflict between two distinct contacts
	if matchByPhone != "" && matchByEmail != "" && matchByPhone != matchByEmail {
		_, _ = h.Pool.Exec(r.Context(), `
			INSERT INTO merge_queue (organization_id, primary_contact_id, duplicate_contact_id, reason)
			VALUES ($1, $2, $3, 'phone_email_conflict')
		`, id.OrganizationID, matchByPhone, matchByEmail)
	}

	existing := matchByCPF
	if existing == "" {
		existing = matchByPhone
	}
	if existing == "" {
		existing = matchByEmail
	}
	if existing != "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": existing, "resolved_existing": true})
		return
	}

	var cid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO contacts (organization_id, name, phone_number, email, cpf, tags)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6) RETURNING id
	`, id.OrganizationID, req.Name, req.PhoneNumber, req.Email, req.CPF, req.Tags).Scan(&cid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create contact")
		return
	}
	if req.PhoneNumber != "" {
		_, _ = h.Pool.Exec(r.Context(), `INSERT INTO contact_phones (organization_id, contact_id, phone_e164, is_primary) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, id.OrganizationID, cid, req.PhoneNumber)
	}
	_, _ = h.Pool.Exec(r.Context(), `INSERT INTO crm_lead_activities (organization_id, contact_id, actor_user_id, type, summary) VALUES ($1,$2,$3,'contact_created','Contact created')`, id.OrganizationID, cid, id.UserID)
	auth.WriteAudit(r.Context(), h.Pool, id, "contact.create", "contact", cid, map[string]any{"name": req.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": cid, "name": req.Name, "phone_number": req.PhoneNumber, "email": req.Email, "tags": req.Tags})
}

func (h *Handler) GetContact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var name, phone, email, cpf string
	var tags []string
	var customFields map[string]any
	var blocked, forceHuman, anon bool
	var created any
	err := h.Pool.QueryRow(r.Context(), `
		SELECT name, COALESCE(phone_number,''), COALESCE(email,''), COALESCE(cpf,''), tags, custom_fields, is_blocked, force_human, is_anonymized, created_at
		FROM contacts WHERE id = $1 AND organization_id = $2
	`, cid, id.OrganizationID).Scan(&name, &phone, &email, &cpf, &tags, &customFields, &blocked, &forceHuman, &anon, &created)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}

	// Timeline
	tRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, type, summary, metadata, performed_at
		FROM crm_lead_activities WHERE organization_id=$1 AND contact_id=$2 ORDER BY performed_at DESC LIMIT 50
	`, id.OrganizationID, cid)
	timeline := []map[string]any{}
	if tRows != nil {
		defer tRows.Close()
		for tRows.Next() {
			var aid, atype, summary string
			var meta map[string]any
			var ts any
			_ = tRows.Scan(&aid, &atype, &summary, &meta, &ts)
			timeline = append(timeline, map[string]any{"id": aid, "type": atype, "summary": summary, "metadata": meta, "performed_at": ts})
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": cid, "name": name, "phone_number": phone, "email": email, "cpf": cpf,
		"tags": tags, "custom_fields": customFields, "is_blocked": blocked,
		"force_human": forceHuman, "is_anonymized": anon, "created_at": created,
		"timeline": timeline,
	})
}

func (h *Handler) UpdateContact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		Name       *string  `json:"name"`
		Email      *string  `json:"email"`
		Phone      *string  `json:"phone_number"`
		Tags       []string `json:"tags"`
		IsBlocked  *bool    `json:"is_blocked"`
		ForceHuman *bool    `json:"force_human"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	_, err := h.Pool.Exec(r.Context(), `
		UPDATE contacts SET
			name = COALESCE($3, name),
			email = COALESCE($4, email),
			phone_number = COALESCE($5, phone_number),
			tags = COALESCE($6, tags),
			is_blocked = COALESCE($7, is_blocked),
			force_human = COALESCE($8, force_human),
			updated_at = now()
		WHERE id = $1 AND organization_id = $2
	`, cid, id.OrganizationID, req.Name, req.Email, req.Phone, req.Tags, req.IsBlocked, req.ForceHuman)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *Handler) ListMergeQueue(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT mq.id, mq.primary_contact_id, c1.name, mq.duplicate_contact_id, c2.name, mq.reason, mq.status
		FROM merge_queue mq
		JOIN contacts c1 ON c1.id = mq.primary_contact_id
		JOIN contacts c2 ON c2.id = mq.duplicate_contact_id
		WHERE mq.organization_id = $1 AND mq.status = 'pending'
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var mid, pID, pName, dID, dName, reason, status string
		_ = rows.Scan(&mid, &pID, &pName, &dID, &dName, &reason, &status)
		out = append(out, map[string]any{
			"id": mid, "primary_contact_id": pID, "primary_name": pName,
			"duplicate_contact_id": dID, "duplicate_name": dName, "reason": reason, "status": status,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) MergeContacts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		PrimaryID   string `json:"primary_id"`
		DuplicateID string `json:"duplicate_id"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.PrimaryID == "" || req.DuplicateID == "" {
		httpx.Error(w, http.StatusBadRequest, "primary_id and duplicate_id required")
		return
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	_, _ = tx.Exec(r.Context(), `UPDATE crm_leads SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, req.PrimaryID, req.DuplicateID, id.OrganizationID)
	_, _ = tx.Exec(r.Context(), `UPDATE conversations SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, req.PrimaryID, req.DuplicateID, id.OrganizationID)
	_, _ = tx.Exec(r.Context(), `UPDATE crm_lead_activities SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, req.PrimaryID, req.DuplicateID, id.OrganizationID)
	_, _ = tx.Exec(r.Context(), `UPDATE contacts SET is_merged_into=$1, is_anonymized=true, updated_at=now() WHERE id=$2 AND organization_id=$3`, req.PrimaryID, req.DuplicateID, id.OrganizationID)
	_, _ = tx.Exec(r.Context(), `UPDATE merge_queue SET status='merged', resolved_by=$1, resolved_at=now() WHERE organization_id=$2 AND ((primary_contact_id=$3 AND duplicate_contact_id=$4) OR (primary_contact_id=$4 AND duplicate_contact_id=$3))`, id.UserID, id.OrganizationID, req.PrimaryID, req.DuplicateID)

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "merge failed")
		return
	}
	auth.WriteAudit(r.Context(), h.Pool, id, "contact.merge", "contact", req.PrimaryID, map[string]any{"merged_from": req.DuplicateID})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "merged"})
}

func (h *Handler) ListPipelines(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, pipeline_type, vocabulary, is_default
		FROM crm_pipelines WHERE organization_id = $1 ORDER BY is_default DESC, created_at ASC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pid, name, ptype string
		var vocab map[string]any
		var isDef bool
		_ = rows.Scan(&pid, &name, &ptype, &vocab, &isDef)

		sRows, _ := h.Pool.Query(r.Context(), `
			SELECT id, name, position, color, is_won, is_lost, requires_human
			FROM crm_stages WHERE pipeline_id = $1 ORDER BY position ASC
		`, pid)
		stages := []map[string]any{}
		if sRows != nil {
			for sRows.Next() {
				var sid, sname, color string
				var pos float64
				var won, lost, reqHuman bool
				_ = sRows.Scan(&sid, &sname, &pos, &color, &won, &lost, &reqHuman)
				stages = append(stages, map[string]any{
					"id": sid, "name": sname, "position": pos, "color": color,
					"is_won": won, "is_lost": lost, "requires_human": reqHuman,
				})
			}
			sRows.Close()
		}
		out = append(out, map[string]any{
			"id": pid, "name": name, "pipeline_type": ptype, "vocabulary": vocab, "is_default": isDef, "stages": stages,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) DeleteStage(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	sid := chi.URLParam(r, "id")
	var cnt int
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM crm_leads WHERE stage_id = $1 AND organization_id = $2`, sid, id.OrganizationID).Scan(&cnt)
	if cnt > 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot delete stage with existing leads")
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `DELETE FROM crm_stages WHERE id = $1 AND organization_id = $2`, sid, id.OrganizationID)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) ListLeads(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pipelineID := r.URL.Query().Get("pipeline_id")
	rows, err := h.Pool.Query(r.Context(), `
		SELECT l.id, l.contact_id, c.name, COALESCE(c.phone_number,''), l.pipeline_id, l.stage_id,
		       l.title, l.position_in_stage, l.value_cents, l.currency, l.status, l.tags, l.version, l.last_activity_at
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
		var lid, cid, cname, cphone, pid, sid, title, curr, status string
		var pos float64
		var val int64
		var tags []string
		var ver int
		var lastAct any
		_ = rows.Scan(&lid, &cid, &cname, &cphone, &pid, &sid, &title, &pos, &val, &curr, &status, &tags, &ver, &lastAct)
		out = append(out, map[string]any{
			"id": lid, "contact_id": cid, "contact_name": cname, "contact_phone": cphone,
			"pipeline_id": pid, "stage_id": sid, "title": title, "position_in_stage": pos,
			"value_cents": val, "currency": curr, "status": status, "tags": tags, "version": ver, "last_activity_at": lastAct,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateLead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		ContactID  string `json:"contact_id"`
		PipelineID string `json:"pipeline_id"`
		StageID    string `json:"stage_id"`
		Title      string `json:"title"`
		ValueCents int64  `json:"value_cents"`
		Currency   string `json:"currency"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.ContactID == "" || req.Title == "" {
		httpx.Error(w, http.StatusBadRequest, "contact_id and title are required")
		return
	}
	if req.Currency == "" {
		req.Currency = "USD"
	}
	if req.PipelineID == "" || req.StageID == "" {
		_ = h.Pool.QueryRow(r.Context(), `
			SELECT p.id, s.id FROM crm_pipelines p
			JOIN crm_stages s ON s.pipeline_id = p.id
			WHERE p.organization_id = $1 ORDER BY p.is_default DESC, s.position ASC LIMIT 1
		`, id.OrganizationID).Scan(&req.PipelineID, &req.StageID)
	}
	var lid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_leads (organization_id, contact_id, pipeline_id, stage_id, title, value_cents, currency, owner_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
	`, id.OrganizationID, req.ContactID, req.PipelineID, req.StageID, req.Title, req.ValueCents, req.Currency, id.UserID).Scan(&lid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create lead")
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `INSERT INTO crm_lead_activities (organization_id, lead_id, contact_id, actor_user_id, type, summary) VALUES ($1,$2,$3,$4,'lead_created',$5)`, id.OrganizationID, lid, req.ContactID, id.UserID, "Created deal: "+req.Title)
	h.Hub.Publish(id.OrganizationID, "lead.created", map[string]any{"id": lid, "stage_id": req.StageID})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": lid, "title": req.Title, "stage_id": req.StageID, "pipeline_id": req.PipelineID})
}

func (h *Handler) UpdateLead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	lid := chi.URLParam(r, "id")
	var req struct {
		StageID         *string  `json:"stage_id"`
		PositionInStage *float64 `json:"position_in_stage"`
		Title           *string  `json:"title"`
		ValueCents      *int64   `json:"value_cents"`
		ExpectedVersion *int     `json:"version"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	if req.ExpectedVersion != nil {
		var curVer int
		_ = h.Pool.QueryRow(r.Context(), `SELECT version FROM crm_leads WHERE id=$1 AND organization_id=$2`, lid, id.OrganizationID).Scan(&curVer)
		if curVer != *req.ExpectedVersion {
			httpx.Error(w, http.StatusConflict, "lead modified concurrently")
			return
		}
	}

	newStatus := ""
	if req.StageID != nil {
		var won, lost bool
		_ = h.Pool.QueryRow(r.Context(), `SELECT is_won, is_lost FROM crm_stages WHERE id=$1 AND organization_id=$2`, *req.StageID, id.OrganizationID).Scan(&won, &lost)
		if won {
			newStatus = "won"
		} else if lost {
			newStatus = "lost"
		} else {
			newStatus = "open"
		}
	}

	_, err := h.Pool.Exec(r.Context(), `
		UPDATE crm_leads SET
			stage_id = COALESCE($3, stage_id),
			position_in_stage = COALESCE($4, position_in_stage),
			title = COALESCE($5, title),
			value_cents = COALESCE($6, value_cents),
			status = CASE WHEN $7 <> '' THEN $7 ELSE status END,
			version = version + 1,
			last_activity_at = now(),
			updated_at = now()
		WHERE id = $1 AND organization_id = $2
	`, lid, id.OrganizationID, req.StageID, req.PositionInStage, req.Title, req.ValueCents, newStatus)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	h.Hub.Publish(id.OrganizationID, "lead.updated", map[string]any{"id": lid, "stage_id": req.StageID})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *Handler) BulkMoveLeads(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		LeadIDs []string `json:"lead_ids"`
		StageID string   `json:"stage_id"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(req.LeadIDs) > 50 {
		httpx.Error(w, http.StatusUnprocessableEntity, "bulk move limited to 50 leads")
		return
	}
	_, err := h.Pool.Exec(r.Context(), `UPDATE crm_leads SET stage_id=$1, version=version+1, updated_at=now() WHERE organization_id=$2 AND id = ANY($3::uuid[])`, req.StageID, id.OrganizationID, req.LeadIDs)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "bulk move failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"moved": len(req.LeadIDs)})
}

func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `SELECT id, title, COALESCE(description,''), status, due_at, created_at FROM crm_tasks WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tid, title, desc, status string
		var due, created any
		_ = rows.Scan(&tid, &title, &desc, &status, &due, &created)
		out = append(out, map[string]any{"id": tid, "title": title, "description": desc, "status": status, "due_at": due, "created_at": created})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Title       string  `json:"title"`
		Description string  `json:"description"`
		ContactID   *string `json:"contact_id"`
		LeadID      *string `json:"lead_id"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Title == "" {
		httpx.Error(w, http.StatusBadRequest, "title required")
		return
	}
	var tid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_tasks (organization_id, title, description, contact_id, lead_id, assigned_to)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
	`, id.OrganizationID, req.Title, req.Description, req.ContactID, req.LeadID, id.UserID).Scan(&tid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": tid, "title": req.Title, "status": "pending"})
}

func (h *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	tid := chi.URLParam(r, "id")
	var req struct {
		Status string `json:"status"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `UPDATE crm_tasks SET status=$1, updated_at=now() WHERE id=$2 AND organization_id=$3`, req.Status, tid, id.OrganizationID)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *Handler) ListProducts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `SELECT id, COALESCE(sku,''), name, COALESCE(description,''), price_cents, currency, stock_qty FROM catalog_products WHERE organization_id=$1 ORDER BY created_at DESC`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pid, sku, name, desc, curr string
		var price int64
		var stock int
		_ = rows.Scan(&pid, &sku, &name, &desc, &price, &curr, &stock)
		out = append(out, map[string]any{"id": pid, "sku": sku, "name": name, "description": desc, "price_cents": price, "currency": curr, "stock_qty": stock})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateProduct(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		SKU         string `json:"sku"`
		Name        string `json:"name"`
		Description string `json:"description"`
		PriceCents  int64  `json:"price_cents"`
		StockQty    int    `json:"stock_qty"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	var pid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO catalog_products (organization_id, sku, name, description, price_cents, stock_qty)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
	`, id.OrganizationID, req.SKU, req.Name, req.Description, req.PriceCents, req.StockQty).Scan(&pid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": pid, "name": req.Name, "price_cents": req.PriceCents})
}
