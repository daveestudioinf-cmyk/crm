package crm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	e164Re        = regexp.MustCompile(`^\+[1-9]\d{6,14}$`)
	ErrInvalidCPF = errors.New("invalid_cpf")
)

type ContactInput struct {
	Name        string
	PhoneNumber string
	Email       string
	CPF         string
	Tags        []string
	ActorUserID string
}

type ContactResolution struct {
	ContactID        string
	ResolvedExisting bool
	Created          bool
}

// ResolveOrCreateContact performs deterministic identity resolution (cpf -> phone_e164 -> email),
// queues conflicts into merge_queue, or creates a new contact if no match exists.
func ResolveOrCreateContact(ctx context.Context, pool *pgxpool.Pool, orgID string, in ContactInput) (ContactResolution, error) {
	name := strings.TrimSpace(in.Name)
	phone := strings.TrimSpace(in.PhoneNumber)
	email := strings.TrimSpace(in.Email)
	tags := in.Tags
	if tags == nil {
		tags = []string{}
	}

	var cleanCPF string
	if strings.TrimSpace(in.CPF) != "" {
		var ok bool
		cleanCPF, ok = ValidateCPF(in.CPF)
		if !ok {
			return ContactResolution{}, ErrInvalidCPF
		}
	}

	var matchByCPF, matchByPhone, matchByEmail string
	if cleanCPF != "" {
		_ = pool.QueryRow(ctx, `
			SELECT id FROM contacts
			WHERE organization_id=$1 AND cpf=$2 AND is_merged_into IS NULL
			LIMIT 1
		`, orgID, cleanCPF).Scan(&matchByCPF)
	}
	if phone != "" {
		_ = pool.QueryRow(ctx, `
			SELECT c.id FROM contacts c
			WHERE c.organization_id=$1 AND c.is_merged_into IS NULL
			  AND (c.phone_number=$2 OR EXISTS (
			      SELECT 1 FROM contact_phones cp
			      WHERE cp.organization_id=$1 AND cp.contact_id=c.id AND cp.phone_e164=$2
			  ))
			LIMIT 1
		`, orgID, phone).Scan(&matchByPhone)
	}
	if email != "" {
		_ = pool.QueryRow(ctx, `
			SELECT id FROM contacts
			WHERE organization_id=$1 AND LOWER(email)=LOWER($2) AND is_merged_into IS NULL
			LIMIT 1
		`, orgID, email).Scan(&matchByEmail)
	}

	if matchByPhone != "" && matchByEmail != "" && matchByPhone != matchByEmail {
		_, _ = pool.Exec(ctx, `
			INSERT INTO merge_queue (organization_id, primary_contact_id, duplicate_contact_id, reason)
			VALUES ($1, $2, $3, 'phone_email_conflict')
		`, orgID, matchByPhone, matchByEmail)
	}

	existing := matchByCPF
	if existing == "" {
		existing = matchByPhone
	}
	if existing == "" {
		existing = matchByEmail
	}
	if existing != "" {
		return ContactResolution{ContactID: existing, ResolvedExisting: true}, nil
	}

	var cid string
	err := pool.QueryRow(ctx, `
		INSERT INTO contacts (organization_id, name, phone_number, email, cpf, tags)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6) RETURNING id
	`, orgID, name, phone, email, cleanCPF, tags).Scan(&cid)
	if err != nil {
		return ContactResolution{}, err
	}
	if phone != "" {
		_, _ = pool.Exec(ctx, `
			INSERT INTO contact_phones (organization_id, contact_id, phone_e164, is_primary)
			VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING
		`, orgID, cid, phone)
	}
	_, _ = pool.Exec(ctx, `
		INSERT INTO crm_lead_activities (organization_id, contact_id, actor_user_id, type, summary)
		VALUES ($1,$2,NULLIF($3,'')::uuid,'contact_created','Contact created')
	`, orgID, cid, in.ActorUserID)

	return ContactResolution{ContactID: cid, Created: true}, nil
}

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
			"id": cid, "name": name, "full_name": name, "phone_number": phone, "phone_e164": phone, "email": email, "cpf": cpf,
			"tags": tags, "is_blocked": blocked, "force_human": forceHuman, "is_anonymized": anon, "created_at": created,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateContact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name        string   `json:"name"`
		FullName    string   `json:"full_name"`
		PhoneNumber string   `json:"phone_number"`
		PhoneE164   string   `json:"phone_e164"`
		Phone       string   `json:"phone"`
		Email       string   `json:"email"`
		CPF         string   `json:"cpf"`
		Tags        []string `json:"tags"`
		IsBlocked   *bool    `json:"is_blocked"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		req.Name = req.FullName
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name is required")
		return
	}
	if strings.TrimSpace(req.PhoneNumber) == "" {
		if strings.TrimSpace(req.PhoneE164) != "" {
			req.PhoneNumber = req.PhoneE164
		} else {
			req.PhoneNumber = req.Phone
		}
	}
	if req.Tags == nil {
		req.Tags = []string{}
	}

	res, err := ResolveOrCreateContact(r.Context(), h.Pool, id.OrganizationID, ContactInput{
		Name:        req.Name,
		PhoneNumber: req.PhoneNumber,
		Email:       req.Email,
		CPF:         req.CPF,
		Tags:        req.Tags,
		ActorUserID: id.UserID,
	})
	if err != nil {
		if errors.Is(err, ErrInvalidCPF) {
			httpx.Error(w, http.StatusBadRequest, "invalid_cpf")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "failed to create contact")
		return
	}
	if req.IsBlocked != nil && *req.IsBlocked {
		_, _ = h.Pool.Exec(r.Context(), `UPDATE contacts SET is_blocked = true WHERE id = $1 AND organization_id = $2`, res.ContactID, id.OrganizationID)
	}
	if res.ResolvedExisting {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": res.ContactID, "resolved_existing": true})
		return
	}
	auth.WriteAudit(r.Context(), h.Pool, id, "contact.create", "contact", res.ContactID, map[string]any{"name": req.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": res.ContactID, "name": req.Name, "phone_number": req.PhoneNumber, "email": req.Email, "tags": req.Tags})
}

func (h *Handler) GetContact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var name, displayName, phone, email, cpf string
	var isMergedInto *string
	var tags []string
	var customFields, consent map[string]any
	var blocked, forceHuman, anon bool
	var created, updated any
	err := h.Pool.QueryRow(r.Context(), `
		SELECT name, COALESCE(display_name,''), COALESCE(phone_number,''), COALESCE(email,''), COALESCE(cpf,''),
		       tags, custom_fields, consent, is_blocked, force_human, is_anonymized, is_merged_into::text, created_at, updated_at
		FROM contacts WHERE id = $1 AND organization_id = $2
	`, cid, id.OrganizationID).Scan(&name, &displayName, &phone, &email, &cpf, &tags, &customFields, &consent, &blocked, &forceHuman, &anon, &isMergedInto, &created, &updated)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}

	// Phones
	pRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, phone_e164, label, is_primary, created_at
		FROM contact_phones WHERE organization_id=$1 AND contact_id=$2 ORDER BY is_primary DESC, created_at ASC
	`, id.OrganizationID, cid)
	phones := []map[string]any{}
	if pRows != nil {
		defer pRows.Close()
		for pRows.Next() {
			var pid, pe164, label string
			var isPrim bool
			var ts any
			_ = pRows.Scan(&pid, &pe164, &label, &isPrim, &ts)
			phones = append(phones, map[string]any{
				"id": pid, "phone_e164": pe164, "label": label, "is_primary": isPrim, "created_at": ts,
			})
		}
	}

	// Leads
	lRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, pipeline_id, stage_id, title, value_cents, currency, status, created_at
		FROM crm_leads WHERE organization_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 50
	`, id.OrganizationID, cid)
	leads := []map[string]any{}
	if lRows != nil {
		defer lRows.Close()
		for lRows.Next() {
			var lid, pid, sid, title, curr, st string
			var val int64
			var ts any
			_ = lRows.Scan(&lid, &pid, &sid, &title, &val, &curr, &st, &ts)
			leads = append(leads, map[string]any{
				"id": lid, "pipeline_id": pid, "stage_id": sid, "title": title,
				"value_cents": val, "currency": curr, "status": st, "created_at": ts,
			})
		}
	}

	// Conversations
	cRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, status, assigned_to::text, service_revision, COALESCE(last_message_preview,''), last_message_at, unread_count
		FROM conversations WHERE organization_id=$1 AND contact_id=$2 ORDER BY last_message_at DESC LIMIT 50
	`, id.OrganizationID, cid)
	conversations := []map[string]any{}
	if cRows != nil {
		defer cRows.Close()
		for cRows.Next() {
			var convID, st, preview string
			var assignedTo *string
			var rev, unread int
			var lastMsg any
			_ = cRows.Scan(&convID, &st, &assignedTo, &rev, &preview, &lastMsg, &unread)
			conversations = append(conversations, map[string]any{
				"id": convID, "status": st, "assigned_to": assignedTo, "service_revision": rev,
				"last_message_preview": preview, "last_message_at": lastMsg, "unread_count": unread,
			})
		}
	}

	// Tasks
	tkRows, _ := h.Pool.Query(r.Context(), `
		SELECT id, title, COALESCE(description,''), status, due_at, created_at
		FROM crm_tasks WHERE organization_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 50
	`, id.OrganizationID, cid)
	tasks := []map[string]any{}
	if tkRows != nil {
		defer tkRows.Close()
		for tkRows.Next() {
			var tid, title, desc, st string
			var due, ts any
			_ = tkRows.Scan(&tid, &title, &desc, &st, &due, &ts)
			tasks = append(tasks, map[string]any{
				"id": tid, "title": title, "description": desc, "status": st, "due_at": due, "created_at": ts,
			})
		}
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

	// Pending Merge Queue items
	mqRows, _ := h.Pool.Query(r.Context(), `
		SELECT mq.id, mq.primary_contact_id, c1.name, mq.duplicate_contact_id, c2.name, mq.reason, mq.status, mq.created_at
		FROM merge_queue mq
		JOIN contacts c1 ON c1.id = mq.primary_contact_id
		JOIN contacts c2 ON c2.id = mq.duplicate_contact_id
		WHERE mq.organization_id=$1 AND mq.status='pending' AND (mq.primary_contact_id=$2 OR mq.duplicate_contact_id=$2)
		ORDER BY mq.created_at DESC
	`, id.OrganizationID, cid)
	mergeQueue := []map[string]any{}
	if mqRows != nil {
		defer mqRows.Close()
		for mqRows.Next() {
			var mid, pID, pName, dID, dName, reason, st string
			var ts any
			_ = mqRows.Scan(&mid, &pID, &pName, &dID, &dName, &reason, &st, &ts)
			mergeQueue = append(mergeQueue, map[string]any{
				"id": mid, "primary_contact_id": pID, "primary_name": pName,
				"duplicate_contact_id": dID, "duplicate_name": dName, "reason": reason, "status": st, "created_at": ts,
			})
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": cid, "name": name, "full_name": name, "display_name": displayName, "phone_number": phone, "email": email, "cpf": cpf,
		"tags": tags, "custom_fields": customFields, "consent": consent, "is_blocked": blocked,
		"force_human": forceHuman, "is_anonymized": anon, "is_merged_into": isMergedInto,
		"created_at": created, "updated_at": updated,
		"phones": phones, "leads": leads, "conversations": conversations, "tasks": tasks,
		"timeline": timeline, "merge_queue": mergeQueue,
	})
}

func (h *Handler) UpdateContact(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		Name         *string        `json:"name"`
		DisplayName  *string        `json:"display_name"`
		Email        *string        `json:"email"`
		Phone        *string        `json:"phone_number"`
		CPF          *string        `json:"cpf"`
		Tags         []string       `json:"tags"`
		CustomFields map[string]any `json:"custom_fields"`
		Consent      map[string]any `json:"consent"`
		IsBlocked    *bool          `json:"is_blocked"`
		ForceHuman   *bool          `json:"force_human"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	var normalizedCPF *string
	if req.CPF != nil {
		trimmed := strings.TrimSpace(*req.CPF)
		if trimmed == "" {
			empty := ""
			normalizedCPF = &empty
		} else {
			cleanCPF, ok := ValidateCPF(trimmed)
			if !ok {
				httpx.Error(w, http.StatusBadRequest, "invalid_cpf")
				return
			}
			var conflictID string
			if err := h.Pool.QueryRow(r.Context(), `
				SELECT id FROM contacts
				WHERE organization_id = $1 AND cpf = $2 AND id <> $3 AND is_merged_into IS NULL
				LIMIT 1
			`, id.OrganizationID, cleanCPF, cid).Scan(&conflictID); err == nil && conflictID != "" {
				httpx.Error(w, http.StatusConflict, "cpf_conflict")
				return
			}
			normalizedCPF = &cleanCPF
		}
	}

	var retID, retName, retDisplayName, retEmail, retPhone, retCPF string
	var retTags []string
	var retCustomFields, retConsent json.RawMessage
	var retBlocked, retForceHuman bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE contacts SET
			name = COALESCE($3, name),
			display_name = COALESCE($4, display_name),
			email = COALESCE($5, email),
			phone_number = COALESCE($6, phone_number),
			cpf = CASE WHEN $7::text IS NULL THEN cpf ELSE NULLIF($7::text, '') END,
			tags = COALESCE($8, tags),
			custom_fields = COALESCE($9, custom_fields),
			consent = COALESCE($10, consent),
			is_blocked = COALESCE($11, is_blocked),
			force_human = COALESCE($12, force_human),
			updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING id, name, COALESCE(display_name,''), COALESCE(email,''), COALESCE(phone_number,''), COALESCE(cpf,''), tags, custom_fields, consent, is_blocked, force_human
	`, cid, id.OrganizationID, req.Name, req.DisplayName, req.Email, req.Phone, normalizedCPF, req.Tags, req.CustomFields, req.Consent, req.IsBlocked, req.ForceHuman).Scan(
		&retID, &retName, &retDisplayName, &retEmail, &retPhone, &retCPF, &retTags, &retCustomFields, &retConsent, &retBlocked, &retForceHuman,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "contact not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "contact.update", "contact", cid, map[string]any{
		"cpf_updated": req.CPF != nil, "custom_fields_updated": req.CustomFields != nil,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status":        "updated",
		"id":            retID,
		"name":          retName,
		"display_name":  retDisplayName,
		"email":         retEmail,
		"phone_number":  retPhone,
		"cpf":           retCPF,
		"tags":          retTags,
		"custom_fields": retCustomFields,
		"consent":       retConsent,
		"is_blocked":    retBlocked,
		"force_human":   retForceHuman,
	})
}

func (h *Handler) AddContactPhone(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		PhoneE164 string `json:"phone_e164"`
		Phone     string `json:"phone"`
		Label     string `json:"label"`
		IsPrimary bool   `json:"is_primary"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	phone := strings.TrimSpace(req.PhoneE164)
	if phone == "" {
		phone = strings.TrimSpace(req.Phone)
	}
	if !ValidateE164(phone) {
		httpx.Error(w, http.StatusBadRequest, "invalid e164 phone_e164")
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = "whatsapp"
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var existingPrimaryPhone *string
	err = tx.QueryRow(r.Context(), `
		SELECT phone_number FROM contacts WHERE id = $1 AND organization_id = $2 AND is_merged_into IS NULL FOR UPDATE
	`, cid, id.OrganizationID).Scan(&existingPrimaryPhone)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}

	effectivePrimary := req.IsPrimary || existingPrimaryPhone == nil || strings.TrimSpace(*existingPrimaryPhone) == ""
	if effectivePrimary {
		if _, err := tx.Exec(r.Context(), `
			UPDATE contact_phones SET is_primary = false WHERE organization_id = $1 AND contact_id = $2
		`, id.OrganizationID, cid); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to update primary phone")
			return
		}
	}

	var phoneID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO contact_phones (organization_id, contact_id, phone_e164, label, is_primary)
		VALUES ($1, $2, $3, $4, $5) RETURNING id
	`, id.OrganizationID, cid, phone, label, effectivePrimary).Scan(&phoneID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			httpx.Error(w, http.StatusConflict, "phone_already_exists")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "failed to add phone")
		return
	}

	if effectivePrimary {
		if _, err := tx.Exec(r.Context(), `
			UPDATE contacts SET phone_number = $1, updated_at = now() WHERE id = $2 AND organization_id = $3
		`, phone, cid, id.OrganizationID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to sync contact phone")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": phoneID, "contact_id": cid, "phone_e164": phone, "label": label, "is_primary": effectivePrimary,
	})
}

func (h *Handler) DeleteContactPhone(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	phoneID := chi.URLParam(r, "phoneId")

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var deletedPhone string
	var wasPrimary bool
	err = tx.QueryRow(r.Context(), `
		DELETE FROM contact_phones WHERE id = $1 AND contact_id = $2 AND organization_id = $3
		RETURNING phone_e164, is_primary
	`, phoneID, cid, id.OrganizationID).Scan(&deletedPhone, &wasPrimary)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "phone not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}

	if wasPrimary {
		var nextID, nextPhone string
		err = tx.QueryRow(r.Context(), `
			SELECT id, phone_e164 FROM contact_phones
			WHERE contact_id = $1 AND organization_id = $2
			ORDER BY created_at ASC LIMIT 1
		`, cid, id.OrganizationID).Scan(&nextID, &nextPhone)
		if err == nil {
			if _, err := tx.Exec(r.Context(), `UPDATE contact_phones SET is_primary = true WHERE id = $1`, nextID); err != nil {
				httpx.Error(w, http.StatusInternalServerError, "failed to promote primary phone")
				return
			}
			if _, err := tx.Exec(r.Context(), `UPDATE contacts SET phone_number = $1, updated_at = now() WHERE id = $2 AND organization_id = $3`, nextPhone, cid, id.OrganizationID); err != nil {
				httpx.Error(w, http.StatusInternalServerError, "failed to sync primary phone")
				return
			}
		} else {
			if _, err := tx.Exec(r.Context(), `UPDATE contacts SET phone_number = NULL, updated_at = now() WHERE id = $1 AND organization_id = $2`, cid, id.OrganizationID); err != nil {
				httpx.Error(w, http.StatusInternalServerError, "failed to clear primary phone")
				return
			}
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) ListMergeQueue(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT mq.id, mq.primary_contact_id, c1.name, COALESCE(c1.phone_number,''), COALESCE(c1.email,''),
		       mq.duplicate_contact_id, c2.name, COALESCE(c2.phone_number,''), COALESCE(c2.email,''),
		       mq.reason, mq.status
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
		var mid, pID, pName, pPhone, pEmail, dID, dName, dPhone, dEmail, reason, status string
		_ = rows.Scan(&mid, &pID, &pName, &pPhone, &pEmail, &dID, &dName, &dPhone, &dEmail, &reason, &status)
		out = append(out, map[string]any{
			"id": mid,
			"primary_contact_id": pID, "primary_name": pName, "primary_phone": pPhone, "primary_email": pEmail,
			"duplicate_contact_id": dID, "duplicate_name": dName, "duplicate_phone": dPhone, "duplicate_email": dEmail,
			"reason": reason, "status": status,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) DismissMergeQueue(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	mqID := chi.URLParam(r, "id")

	var status string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT status FROM merge_queue WHERE id = $1 AND organization_id = $2
	`, mqID, id.OrganizationID).Scan(&status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "merge queue item not found")
		return
	}
	if status != "pending" {
		httpx.Error(w, http.StatusConflict, "merge queue item already resolved")
		return
	}

	tag, err := h.Pool.Exec(r.Context(), `
		UPDATE merge_queue SET status = 'dismissed', resolved_by = $3, resolved_at = now()
		WHERE id = $1 AND organization_id = $2 AND status = 'pending'
	`, mqID, id.OrganizationID, id.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "dismiss failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusConflict, "merge queue item already resolved")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "contact.merge_dismiss", "merge_queue", mqID, map[string]any{"status": "dismissed"})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": mqID, "status": "dismissed"})
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
	if req.PrimaryID == req.DuplicateID {
		httpx.Error(w, http.StatusBadRequest, "primary_id and duplicate_id must be distinct")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var pMerged, dMerged *string
	if err := tx.QueryRow(r.Context(), `
		SELECT is_merged_into::text FROM contacts WHERE id = $1 AND organization_id = $2 FOR UPDATE
	`, req.PrimaryID, id.OrganizationID).Scan(&pMerged); err != nil {
		httpx.Error(w, http.StatusNotFound, "primary contact not found")
		return
	}
	if err := tx.QueryRow(r.Context(), `
		SELECT is_merged_into::text FROM contacts WHERE id = $1 AND organization_id = $2 FOR UPDATE
	`, req.DuplicateID, id.OrganizationID).Scan(&dMerged); err != nil {
		httpx.Error(w, http.StatusNotFound, "duplicate contact not found")
		return
	}
	if pMerged != nil || dMerged != nil {
		httpx.Error(w, http.StatusConflict, "contact already merged")
		return
	}

	stmts := []struct {
		query string
		args  []any
	}{
		{`UPDATE crm_leads SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE conversations SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE crm_lead_activities SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE crm_tasks SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE lgpd_requests SET contact_id=$1 WHERE contact_id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE contact_phones SET contact_id=$1, is_primary=false WHERE contact_id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE contacts SET is_merged_into=$1, is_anonymized=true, updated_at=now() WHERE id=$2 AND organization_id=$3`, []any{req.PrimaryID, req.DuplicateID, id.OrganizationID}},
		{`UPDATE merge_queue SET status='merged', resolved_by=$1, resolved_at=now() WHERE organization_id=$2 AND status='pending' AND ((primary_contact_id=$3 AND duplicate_contact_id=$4) OR (primary_contact_id=$4 AND duplicate_contact_id=$3))`, []any{id.UserID, id.OrganizationID, req.PrimaryID, req.DuplicateID}},
		{`INSERT INTO crm_lead_activities (organization_id, contact_id, actor_user_id, type, summary, metadata) VALUES ($1, $2, $3, 'contact_merged', 'Merged duplicate contact', jsonb_build_object('duplicate_contact_id', $4::text))`, []any{id.OrganizationID, req.PrimaryID, id.UserID, req.DuplicateID}},
	}
	for _, s := range stmts {
		if _, err := tx.Exec(r.Context(), s.query, s.args...); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "merge failed")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "merge commit failed")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "contact.merge", "contact", req.PrimaryID, map[string]any{"merged_from": req.DuplicateID})
	httpx.JSON(w, http.StatusOK, map[string]string{
		"status": "merged", "primary_id": req.PrimaryID, "duplicate_id": req.DuplicateID,
	})
}

// ValidateCPF normalizes a Brazilian CPF and verifies its mod-11 check digits.
func ValidateCPF(raw string) (string, bool) {
	var digits strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		} else if r != '.' && r != '-' && r != '/' && r != ' ' {
			return "", false
		}
	}
	s := digits.String()
	if len(s) != 11 {
		return "", false
	}
	allSame := true
	for i := 1; i < 11; i++ {
		if s[i] != s[0] {
			allSame = false
			break
		}
	}
	if allSame {
		return "", false
	}

	sum := 0
	for i := 0; i < 9; i++ {
		sum += int(s[i]-'0') * (10 - i)
	}
	d1 := (sum * 10) % 11
	if d1 == 10 {
		d1 = 0
	}
	if d1 != int(s[9]-'0') {
		return "", false
	}

	sum = 0
	for i := 0; i < 10; i++ {
		sum += int(s[i]-'0') * (11 - i)
	}
	d2 := (sum * 10) % 11
	if d2 == 10 {
		d2 = 0
	}
	if d2 != int(s[10]-'0') {
		return "", false
	}
	return s, true
}

// ValidateE164 validates an international E.164 phone number (e.g. +5511999990001).
func ValidateE164(phone string) bool {
	return e164Re.MatchString(phone)
}


