package automation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Campaign struct {
	ID                   string         `json:"id"`
	OrganizationID       string         `json:"organization_id"`
	ChannelSessionID     string         `json:"channel_session_id,omitempty"`
	Name                 string         `json:"name"`
	MessageTemplate      string         `json:"message_template"`
	AudienceFilter       map[string]any `json:"audience_filter"`
	Status               string         `json:"status"`
	ThrottlePerMinute    int            `json:"throttle_per_minute"`
	MinDelaySec          int            `json:"min_delay_sec"`
	MaxDelaySec          int            `json:"max_delay_sec"`
	DailyCap             int            `json:"daily_cap"`
	RespectBusinessHours bool           `json:"respect_business_hours"`
	ScheduledAt          *time.Time     `json:"scheduled_at,omitempty"`
	StartedAt            *time.Time     `json:"started_at,omitempty"`
	CompletedAt          *time.Time     `json:"completed_at,omitempty"`
	TotalCount           int            `json:"total_count"`
	SentCount            int            `json:"sent_count"`
	FailedCount          int            `json:"failed_count"`
	SkippedCount         int            `json:"skipped_count"`
	CreatedBy            string         `json:"created_by,omitempty"`
	CreatedAt            time.Time      `json:"created_at"`
	UpdatedAt            time.Time      `json:"updated_at"`
}

type CampaignRecipient struct {
	ID           string     `json:"id"`
	CampaignID   string     `json:"campaign_id"`
	ContactID    string     `json:"contact_id"`
	ContactName  string     `json:"contact_name"`
	PhoneNumber  string     `json:"phone_number"`
	Status       string     `json:"status"`
	ErrorMessage string     `json:"error_message,omitempty"`
	SentAt       *time.Time `json:"sent_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

func validCampaignStatus(s string) bool {
	switch s {
	case "draft", "scheduled", "running", "paused", "completed", "cancelled":
		return true
	default:
		return false
	}
}

func (h *Handler) publishCampaignEvent(orgID, campaignID, status string) {
	if h.Hub != nil {
		h.Hub.Publish(orgID, "campaign.updated", map[string]any{
			"campaign_id": campaignID,
			"status":      status,
		})
	}
}

func scanCampaign(row pgx.Row) (Campaign, error) {
	var c Campaign
	var filterRaw []byte
	err := row.Scan(
		&c.ID, &c.OrganizationID, &c.ChannelSessionID, &c.Name, &c.MessageTemplate,
		&filterRaw, &c.Status, &c.ThrottlePerMinute, &c.MinDelaySec, &c.MaxDelaySec,
		&c.DailyCap, &c.RespectBusinessHours, &c.ScheduledAt, &c.StartedAt, &c.CompletedAt,
		&c.TotalCount, &c.SentCount, &c.FailedCount, &c.SkippedCount, &c.CreatedBy,
		&c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return c, err
	}
	c.AudienceFilter = map[string]any{}
	if len(filterRaw) > 0 {
		_ = json.Unmarshal(filterRaw, &c.AudienceFilter)
	}
	return c, nil
}

const campaignSelectCols = `
	id, organization_id, COALESCE(channel_session_id::text, ''), name, message_template,
	audience_filter, status, throttle_per_minute, min_delay_sec, max_delay_sec,
	daily_cap, respect_business_hours, scheduled_at, started_at, completed_at,
	total_count, sent_count, failed_count, skipped_count, COALESCE(created_by::text, ''),
	created_at, updated_at
`

// MaterializeCampaignRecipients inserts eligible contacts into campaign_recipients,
// excluding blocked (STOP), anonymized, merged, missing-phone, or opted-out contacts.
func MaterializeCampaignRecipients(ctx context.Context, pool *pgxpool.Pool, orgID, campaignID string, contactIDs []string) (int, error) {
	var inserted int
	if len(contactIDs) > 0 {
		tag, err := pool.Exec(ctx, `
			INSERT INTO campaign_recipients (campaign_id, organization_id, contact_id, phone_number, status)
			SELECT $1, $2, c.id, c.phone_number, 'pending'
			FROM contacts c
			WHERE c.organization_id = $2
			  AND c.id = ANY($3::uuid[])
			  AND c.is_blocked = false
			  AND c.is_anonymized = false
			  AND c.is_merged_into IS NULL
			  AND COALESCE(c.phone_number, '') <> ''
			  AND COALESCE((c.consent->>'whatsapp')::boolean, true) = true
			  AND COALESCE((c.consent->>'marketing')::boolean, true) = true
			ON CONFLICT (campaign_id, contact_id) DO NOTHING
		`, campaignID, orgID, contactIDs)
		if err != nil {
			return 0, err
		}
		inserted = int(tag.RowsAffected())
	} else {
		tag, err := pool.Exec(ctx, `
			INSERT INTO campaign_recipients (campaign_id, organization_id, contact_id, phone_number, status)
			SELECT $1, $2, c.id, c.phone_number, 'pending'
			FROM contacts c
			WHERE c.organization_id = $2
			  AND c.is_blocked = false
			  AND c.is_anonymized = false
			  AND c.is_merged_into IS NULL
			  AND COALESCE(c.phone_number, '') <> ''
			  AND COALESCE((c.consent->>'whatsapp')::boolean, true) = true
			  AND COALESCE((c.consent->>'marketing')::boolean, true) = true
			ORDER BY c.created_at DESC
			LIMIT 500
			ON CONFLICT (campaign_id, contact_id) DO NOTHING
		`, campaignID, orgID)
		if err != nil {
			return 0, err
		}
		inserted = int(tag.RowsAffected())
	}

	_, _ = pool.Exec(ctx, `
		UPDATE campaigns
		SET total_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1),
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
	`, campaignID, orgID)

	return inserted, nil
}

func enqueueCampaignSend(ctx context.Context, pool *pgxpool.Pool, orgID, campaignID string) error {
	payload, _ := json.Marshal(map[string]any{"campaign_id": campaignID})
	_, err := pool.Exec(ctx, `
		INSERT INTO event_log (organization_id, event_type, payload, status, available_at)
		SELECT $1, 'campaign.send', $2::jsonb, 'pending', now()
		WHERE NOT EXISTS (
			SELECT 1 FROM event_log
			WHERE organization_id = $1
			  AND event_type = 'campaign.send'
			  AND status IN ('pending', 'processing')
			  AND payload->>'campaign_id' = $3
		)
	`, orgID, string(payload), campaignID)
	return err
}

func (h *Handler) ListCampaigns(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	rows, err := h.Pool.Query(r.Context(), `
		SELECT `+campaignSelectCols+`
		FROM campaigns
		WHERE organization_id = $1
		  AND ($2 = '' OR status = $2)
		ORDER BY created_at DESC
		LIMIT 200
	`, id.OrganizationID, statusFilter)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	items := make([]Campaign, 0)
	for rows.Next() {
		c, err := scanCampaign(rows)
		if err == nil {
			items = append(items, c)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "campaigns": items})
}

func (h *Handler) GetCampaign(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	campaignID := chi.URLParam(r, "id")
	c, err := scanCampaign(h.Pool.QueryRow(r.Context(), `
		SELECT `+campaignSelectCols+`
		FROM campaigns
		WHERE id = $1 AND organization_id = $2
	`, campaignID, id.OrganizationID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "campaign_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	httpx.JSON(w, http.StatusOK, c)
}

func (h *Handler) ListCampaignRecipients(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	campaignID := chi.URLParam(r, "id")

	var exists bool
	if err := h.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM campaigns WHERE id = $1 AND organization_id = $2)`, campaignID, id.OrganizationID).Scan(&exists); err != nil || !exists {
		httpx.Error(w, http.StatusNotFound, "campaign_not_found")
		return
	}

	rows, err := h.Pool.Query(r.Context(), `
		SELECT cr.id, cr.campaign_id, cr.contact_id, COALESCE(c.name, ''), cr.phone_number,
		       cr.status, COALESCE(cr.error_message, ''), cr.sent_at, cr.created_at
		FROM campaign_recipients cr
		LEFT JOIN contacts c ON c.id = cr.contact_id
		WHERE cr.campaign_id = $1 AND cr.organization_id = $2
		ORDER BY cr.created_at ASC
		LIMIT 500
	`, campaignID, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	items := make([]CampaignRecipient, 0)
	for rows.Next() {
		var rec CampaignRecipient
		if err := rows.Scan(&rec.ID, &rec.CampaignID, &rec.ContactID, &rec.ContactName, &rec.PhoneNumber, &rec.Status, &rec.ErrorMessage, &rec.SentAt, &rec.CreatedAt); err == nil {
			items = append(items, rec)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "recipients": items})
}

func (h *Handler) CreateCampaign(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name                 string         `json:"name"`
		MessageTemplate      string         `json:"message_template"`
		ChannelSessionID     string         `json:"channel_session_id"`
		AudienceFilter       map[string]any `json:"audience_filter"`
		ThrottlePerMinute    *int           `json:"throttle_per_minute"`
		MinDelaySec          *int           `json:"min_delay_sec"`
		MaxDelaySec          *int           `json:"max_delay_sec"`
		DailyCap             int            `json:"daily_cap"`
		RespectBusinessHours *bool          `json:"respect_business_hours"`
		ScheduledAt          string         `json:"scheduled_at"`
		ContactIDs           []string       `json:"contact_ids"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	name := strings.TrimSpace(req.Name)
	tmpl := strings.TrimSpace(req.MessageTemplate)
	if name == "" || tmpl == "" {
		httpx.Error(w, http.StatusBadRequest, "name_and_message_template_required")
		return
	}

	throttle := 10
	if req.ThrottlePerMinute != nil {
		if *req.ThrottlePerMinute <= 0 {
			httpx.Error(w, http.StatusBadRequest, "throttle_per_minute_must_be_positive")
			return
		}
		throttle = *req.ThrottlePerMinute
	}

	minDelay := 5
	if req.MinDelaySec != nil && *req.MinDelaySec > 0 {
		minDelay = *req.MinDelaySec
	}
	maxDelay := 15
	if req.MaxDelaySec != nil && *req.MaxDelaySec > 0 {
		maxDelay = *req.MaxDelaySec
	}
	if maxDelay < minDelay {
		maxDelay = minDelay
	}

	respectBH := true
	if req.RespectBusinessHours != nil {
		respectBH = *req.RespectBusinessHours
	}

	status := "draft"
	var scheduledAt *time.Time
	if strings.TrimSpace(req.ScheduledAt) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(req.ScheduledAt))
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_scheduled_at")
			return
		}
		scheduledAt = &t
		status = "scheduled"
	}

	if req.AudienceFilter == nil {
		req.AudienceFilter = map[string]any{}
	}
	filterJSON, _ := json.Marshal(req.AudienceFilter)

	c, err := scanCampaign(h.Pool.QueryRow(r.Context(), `
		INSERT INTO campaigns (
			organization_id, channel_session_id, name, message_template, audience_filter,
			status, throttle_per_minute, min_delay_sec, max_delay_sec, daily_cap,
			respect_business_hours, scheduled_at, created_by
		) VALUES (
			$1, NULLIF($2,'')::uuid, $3, $4, $5::jsonb,
			$6, $7, $8, $9, $10,
			$11, $12, NULLIF($13,'')::uuid
		)
		RETURNING `+campaignSelectCols,
		id.OrganizationID, strings.TrimSpace(req.ChannelSessionID), name, tmpl, string(filterJSON),
		status, throttle, minDelay, maxDelay, req.DailyCap,
		respectBH, scheduledAt, id.UserID,
	))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	if len(req.ContactIDs) > 0 {
		if _, err := MaterializeCampaignRecipients(r.Context(), h.Pool, id.OrganizationID, c.ID, req.ContactIDs); err == nil {
			_ = h.Pool.QueryRow(r.Context(), `SELECT total_count FROM campaigns WHERE id = $1`, c.ID).Scan(&c.TotalCount)
		}
	}

	h.publishCampaignEvent(id.OrganizationID, c.ID, c.Status)
	httpx.JSON(w, http.StatusCreated, c)
}

func (h *Handler) UpdateCampaign(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	campaignID := chi.URLParam(r, "id")

	var req struct {
		Name                 *string `json:"name"`
		MessageTemplate      *string `json:"message_template"`
		ChannelSessionID     *string `json:"channel_session_id"`
		ThrottlePerMinute    *int    `json:"throttle_per_minute"`
		MinDelaySec          *int    `json:"min_delay_sec"`
		MaxDelaySec          *int    `json:"max_delay_sec"`
		DailyCap             *int    `json:"daily_cap"`
		RespectBusinessHours *bool   `json:"respect_business_hours"`
		Status               *string `json:"status"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name_required")
		return
	}
	if req.MessageTemplate != nil && strings.TrimSpace(*req.MessageTemplate) == "" {
		httpx.Error(w, http.StatusBadRequest, "message_template_required")
		return
	}
	if req.ThrottlePerMinute != nil && *req.ThrottlePerMinute <= 0 {
		httpx.Error(w, http.StatusBadRequest, "throttle_per_minute_must_be_positive")
		return
	}
	if req.Status != nil && !validCampaignStatus(*req.Status) {
		httpx.Error(w, http.StatusBadRequest, "invalid_status")
		return
	}

	c, err := scanCampaign(h.Pool.QueryRow(r.Context(), `
		UPDATE campaigns
		SET name = COALESCE(NULLIF($3, ''), name),
		    message_template = COALESCE(NULLIF($4, ''), message_template),
		    channel_session_id = CASE WHEN $5::text IS NOT NULL THEN NULLIF($5, '')::uuid ELSE channel_session_id END,
		    throttle_per_minute = COALESCE($6, throttle_per_minute),
		    min_delay_sec = COALESCE($7, min_delay_sec),
		    max_delay_sec = COALESCE($8, max_delay_sec),
		    daily_cap = COALESCE($9, daily_cap),
		    respect_business_hours = COALESCE($10, respect_business_hours),
		    status = COALESCE($11, status),
		    started_at = CASE WHEN $11 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING `+campaignSelectCols,
		campaignID, id.OrganizationID,
		derefStrTrim(req.Name), derefStrTrim(req.MessageTemplate), req.ChannelSessionID,
		req.ThrottlePerMinute, req.MinDelaySec, req.MaxDelaySec, req.DailyCap,
		req.RespectBusinessHours, req.Status,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "campaign_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	if req.Status != nil && *req.Status == "running" {
		if c.TotalCount == 0 {
			_, _ = MaterializeCampaignRecipients(r.Context(), h.Pool, id.OrganizationID, c.ID, nil)
			_ = h.Pool.QueryRow(r.Context(), `SELECT total_count FROM campaigns WHERE id = $1`, c.ID).Scan(&c.TotalCount)
		}
		_ = enqueueCampaignSend(r.Context(), h.Pool, id.OrganizationID, c.ID)
	}

	h.publishCampaignEvent(id.OrganizationID, c.ID, c.Status)
	httpx.JSON(w, http.StatusOK, c)
}

func (h *Handler) DeleteCampaign(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	campaignID := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM campaigns WHERE id = $1 AND organization_id = $2`, campaignID, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "campaign_not_found")
		return
	}
	h.publishCampaignEvent(id.OrganizationID, campaignID, "deleted")
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (h *Handler) StartCampaign(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	campaignID := chi.URLParam(r, "id")

	var req struct {
		ContactIDs []string `json:"contact_ids"`
	}
	_ = httpx.Decode(r, &req)

	c, err := scanCampaign(h.Pool.QueryRow(r.Context(), `
		UPDATE campaigns
		SET status = 'running',
		    started_at = COALESCE(started_at, now()),
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING `+campaignSelectCols, campaignID, id.OrganizationID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "campaign_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	if len(req.ContactIDs) > 0 || c.TotalCount == 0 {
		_, _ = MaterializeCampaignRecipients(r.Context(), h.Pool, id.OrganizationID, c.ID, req.ContactIDs)
		_ = h.Pool.QueryRow(r.Context(), `SELECT total_count FROM campaigns WHERE id = $1`, c.ID).Scan(&c.TotalCount)
	}

	if err := enqueueCampaignSend(r.Context(), h.Pool, id.OrganizationID, c.ID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "enqueue_error")
		return
	}

	h.publishCampaignEvent(id.OrganizationID, c.ID, c.Status)
	httpx.JSON(w, http.StatusOK, c)
}

func (h *Handler) PauseCampaign(w http.ResponseWriter, r *http.Request) {
	h.setCampaignStatus(w, r, "paused")
}

func (h *Handler) CancelCampaign(w http.ResponseWriter, r *http.Request) {
	h.setCampaignStatus(w, r, "cancelled")
}

func (h *Handler) setCampaignStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, _ := auth.FromContext(r.Context())
	campaignID := chi.URLParam(r, "id")
	c, err := scanCampaign(h.Pool.QueryRow(r.Context(), `
		UPDATE campaigns
		SET status = $3, updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING `+campaignSelectCols, campaignID, id.OrganizationID, status))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "campaign_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	h.publishCampaignEvent(id.OrganizationID, c.ID, c.Status)
	httpx.JSON(w, http.StatusOK, c)
}

func derefStrTrim(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
