package inbox

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type OutboundSender interface {
	SendText(ctx context.Context, instanceName, phoneNumber, text string) error
}

type OutboundThrottle interface {
	AllowOutbound(ctx context.Context, sessionID string, dailyLimit int) bool
}

type Handler struct {
	Pool      *pgxpool.Pool
	Hub       *realtime.Hub
	Evolution OutboundSender
	Throttle  OutboundThrottle
	Cfg       config.Config
}

func (h *Handler) publish(orgID, evType string, payload any) {
	if h.Hub != nil {
		h.Hub.Publish(orgID, evType, payload)
	}
}

func (h *Handler) ListConversations(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	status := r.URL.Query().Get("status")
	rows, err := h.Pool.Query(r.Context(), `
		SELECT conv.id, conv.contact_id, c.name, COALESCE(c.phone_number,''), conv.status,
		       conv.assigned_to, conv.service_revision, COALESCE(conv.last_message_preview,''),
		       conv.last_message_at, conv.last_inbound_at, conv.unread_count, c.is_blocked, c.force_human,
		       COALESCE(conv.channel_session_id::text, '')
		FROM conversations conv
		JOIN contacts c ON c.id = conv.contact_id
		WHERE conv.organization_id = $1 AND ($2 = '' OR conv.status = $2)
		ORDER BY conv.last_message_at DESC LIMIT 100
	`, id.OrganizationID, status)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, contactID, cname, cphone, st, preview, chSessID string
		var assignedTo *string
		var rev, unread int
		var lastMsg, lastIn any
		var blocked, forceHuman bool
		_ = rows.Scan(&cid, &contactID, &cname, &cphone, &st, &assignedTo, &rev, &preview, &lastMsg, &lastIn, &unread, &blocked, &forceHuman, &chSessID)
		out = append(out, map[string]any{
			"id": cid, "contact_id": contactID, "contact_name": cname, "contact_phone": cphone,
			"status": st, "assigned_to": assignedTo, "service_revision": rev,
			"last_message_preview": preview, "last_message_at": lastMsg, "last_inbound_at": lastIn,
			"unread_count": unread, "is_blocked": blocked, "force_human": forceHuman,
			"channel_session_id": chSessID,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateConversation(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		ContactID string `json:"contact_id"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.ContactID == "" {
		httpx.Error(w, http.StatusBadRequest, "contact_id required")
		return
	}
	var cid string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT id FROM conversations WHERE organization_id=$1 AND contact_id=$2 AND status NOT IN ('closed','resolved') LIMIT 1
	`, id.OrganizationID, req.ContactID).Scan(&cid)
	if err == nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": cid})
		return
	}
	err = h.Pool.QueryRow(r.Context(), `
		INSERT INTO conversations (organization_id, contact_id, status) VALUES ($1, $2, 'open') RETURNING id
	`, id.OrganizationID, req.ContactID).Scan(&cid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create conversation")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": cid, "status": "open"})
}

func (h *Handler) ClaimConversation(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		ExpectedRevision *int `json:"expected_revision"`
		ServiceRevision  *int `json:"service_revision"`
	}
	if err := httpx.Decode(r, &req); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.ExpectedRevision == nil {
		req.ExpectedRevision = req.ServiceRevision
	}

	var newRev int
	var err error
	if req.ExpectedRevision != nil {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE conversations
			SET status = 'claimed', assigned_to = $3, service_revision = service_revision + 1, unread_count = 0, updated_at = now()
			WHERE id = $1 AND organization_id = $2 AND service_revision = $4
			RETURNING service_revision
		`, cid, id.OrganizationID, id.UserID, *req.ExpectedRevision).Scan(&newRev)
		if err != nil {
			var curRev int
			chkErr := h.Pool.QueryRow(r.Context(), `
				SELECT service_revision FROM conversations WHERE id = $1 AND organization_id = $2
			`, cid, id.OrganizationID).Scan(&curRev)
			if chkErr != nil {
				httpx.Error(w, http.StatusNotFound, "conversation not found")
				return
			}
			httpx.JSON(w, http.StatusConflict, map[string]any{
				"error":            "conversation_revision_conflict",
				"current_revision": curRev,
			})
			return
		}
	} else {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE conversations
			SET status = 'claimed', assigned_to = $3, service_revision = service_revision + 1, unread_count = 0, updated_at = now()
			WHERE id = $1 AND organization_id = $2
			RETURNING service_revision
		`, cid, id.OrganizationID, id.UserID).Scan(&newRev)
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "conversation not found")
			return
		}
	}

	h.publish(id.OrganizationID, "conversation.updated", map[string]any{
		"id": cid, "status": "claimed", "assigned_to": id.UserID, "service_revision": newRev,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "claimed", "assigned_to": id.UserID, "service_revision": newRev})
}

func (h *Handler) TransferConversation(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		TargetUserID     string `json:"target_user_id"`
		AgentID          string `json:"agent_id"`
		AssigneeID       string `json:"assignee_id"`
		AutoRoute        bool   `json:"auto_route"`
		ExpectedRevision *int   `json:"expected_revision"`
		ServiceRevision  *int   `json:"service_revision"`
	}
	if err := httpx.Decode(r, &req); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.ExpectedRevision == nil {
		req.ExpectedRevision = req.ServiceRevision
	}

	targetID := strings.TrimSpace(req.TargetUserID)
	if targetID == "" {
		targetID = strings.TrimSpace(req.AgentID)
	}
	if targetID == "" {
		targetID = strings.TrimSpace(req.AssigneeID)
	}

	// Verify conversation exists and check revision upfront before selecting target
	var curRev int
	if err := h.Pool.QueryRow(r.Context(), `
		SELECT service_revision FROM conversations WHERE id = $1 AND organization_id = $2
	`, cid, id.OrganizationID).Scan(&curRev); err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	if req.ExpectedRevision != nil && curRev != *req.ExpectedRevision {
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"error":            "conversation_revision_conflict",
			"current_revision": curRev,
		})
		return
	}

	if req.AutoRoute || targetID == "" {
		// Round-robin auto-routing: available agents/managers/admins under max_concurrent_chats
		err := h.Pool.QueryRow(r.Context(), `
			SELECT uo.user_id
			FROM user_organizations uo
			LEFT JOIN conversations c
				ON c.organization_id = uo.organization_id
				AND c.assigned_to = uo.user_id
				AND c.status = 'claimed'
			WHERE uo.organization_id = $1
			  AND uo.is_available = true
			  AND uo.role IN ('agent', 'manager', 'admin')
			GROUP BY uo.user_id, uo.max_concurrent_chats
			HAVING COUNT(c.id) < uo.max_concurrent_chats
			ORDER BY COUNT(c.id) ASC, MAX(c.updated_at) ASC NULLS FIRST, uo.user_id ASC
			LIMIT 1
		`, id.OrganizationID).Scan(&targetID)
		if err != nil {
			httpx.Error(w, http.StatusConflict, "no_available_agents")
			return
		}
	} else {
		var role string
		err := h.Pool.QueryRow(r.Context(), `
			SELECT role FROM user_organizations
			WHERE organization_id = $1 AND user_id = $2 AND role IN ('agent', 'manager', 'admin')
		`, id.OrganizationID, targetID).Scan(&role)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "target user is not an eligible agent in this organization")
			return
		}
	}

	var newRev int
	var err error
	if req.ExpectedRevision != nil {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE conversations
			SET status = 'claimed', assigned_to = $3, service_revision = service_revision + 1, unread_count = 0, updated_at = now()
			WHERE id = $1 AND organization_id = $2 AND service_revision = $4
			RETURNING service_revision
		`, cid, id.OrganizationID, targetID, *req.ExpectedRevision).Scan(&newRev)
	} else {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE conversations
			SET status = 'claimed', assigned_to = $3, service_revision = service_revision + 1, unread_count = 0, updated_at = now()
			WHERE id = $1 AND organization_id = $2
			RETURNING service_revision
		`, cid, id.OrganizationID, targetID).Scan(&newRev)
	}
	if err != nil {
		var latestRev int
		if chkErr := h.Pool.QueryRow(r.Context(), `SELECT service_revision FROM conversations WHERE id = $1 AND organization_id = $2`, cid, id.OrganizationID).Scan(&latestRev); chkErr == nil {
			httpx.JSON(w, http.StatusConflict, map[string]any{
				"error":            "conversation_revision_conflict",
				"current_revision": latestRev,
			})
			return
		}
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}

	h.publish(id.OrganizationID, "conversation.updated", map[string]any{
		"id": cid, "status": "claimed", "assigned_to": targetID, "service_revision": newRev,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": cid, "status": "claimed", "assigned_to": targetID, "service_revision": newRev,
	})
}

func (h *Handler) ResolveConversation(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		Status           string `json:"status"` // "resolved" or "ai_handling"
		ExpectedRevision *int   `json:"expected_revision"`
		ServiceRevision  *int   `json:"service_revision"`
	}
	if err := httpx.Decode(r, &req); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.ExpectedRevision == nil {
		req.ExpectedRevision = req.ServiceRevision
	}
	if req.Status == "" {
		req.Status = "resolved"
	}
	switch req.Status {
	case "open", "claimed", "resolved", "ai_handling":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid status")
		return
	}

	var newRev int
	var err error
	if req.ExpectedRevision != nil {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE conversations SET status = $3, service_revision = service_revision + 1, updated_at = now()
			WHERE id = $1 AND organization_id = $2 AND service_revision = $4
			RETURNING service_revision
		`, cid, id.OrganizationID, req.Status, *req.ExpectedRevision).Scan(&newRev)
		if err != nil {
			var curRev int
			if chkErr := h.Pool.QueryRow(r.Context(), `SELECT service_revision FROM conversations WHERE id = $1 AND organization_id = $2`, cid, id.OrganizationID).Scan(&curRev); chkErr == nil {
				httpx.JSON(w, http.StatusConflict, map[string]any{
					"error":            "conversation_revision_conflict",
					"current_revision": curRev,
				})
				return
			}
			httpx.Error(w, http.StatusNotFound, "conversation not found")
			return
		}
	} else {
		err = h.Pool.QueryRow(r.Context(), `
			UPDATE conversations SET status = $3, service_revision = service_revision + 1, updated_at = now()
			WHERE id = $1 AND organization_id = $2
			RETURNING service_revision
		`, cid, id.OrganizationID, req.Status).Scan(&newRev)
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "conversation not found")
			return
		}
	}
	h.publish(id.OrganizationID, "conversation.updated", map[string]any{"id": cid, "status": req.Status, "service_revision": newRev})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": req.Status, "service_revision": newRev})
}

func (h *Handler) ListMessages(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var convExists string
	if err := h.Pool.QueryRow(r.Context(), `SELECT id FROM conversations WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID).Scan(&convExists); err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, direction, sender_type, content_type, body, COALESCE(media_url,''), status, sentiment_score, metadata, sent_at
		FROM messages WHERE organization_id=$1 AND conversation_id=$2 ORDER BY sent_at ASC LIMIT 200
	`, id.OrganizationID, cid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var mid, dir, stype, ctype, body, media, status string
		var sentScore *float64
		var meta map[string]any
		var sentAt any
		_ = rows.Scan(&mid, &dir, &stype, &ctype, &body, &media, &status, &sentScore, &meta, &sentAt)
		out = append(out, map[string]any{
			"id": mid, "direction": dir, "sender_type": stype, "content_type": ctype,
			"body": body, "media_url": media, "status": status, "sentiment_score": sentScore,
			"metadata": meta, "sent_at": sentAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		Body           string   `json:"body"`
		ContentType    string   `json:"content_type"` // text | image | audio | document | location | note | template
		MediaURL       string   `json:"media_url"`
		TemplateName   string   `json:"template_name"`
		TemplateParams []string `json:"template_params"`
	}
	if err := httpx.Decode(r, &req); err != nil || (strings.TrimSpace(req.Body) == "" && strings.TrimSpace(req.MediaURL) == "" && strings.TrimSpace(req.TemplateName) == "") {
		httpx.Error(w, http.StatusBadRequest, "body or media_url required")
		return
	}
	if req.ContentType == "" {
		req.ContentType = "text"
	}
	switch req.ContentType {
	case "text", "image", "audio", "document", "location", "note", "template":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid content_type")
		return
	}
	if req.ContentType == "template" && strings.TrimSpace(req.TemplateName) == "" {
		httpx.Error(w, http.StatusBadRequest, "template_name required")
		return
	}

	var isBlocked bool
	var contactID, channelSessionID, sname, prov, phone string
	var lastInboundAt *time.Time
	var warmupLimit int
	var businessHours map[string]any
	err := h.Pool.QueryRow(r.Context(), `
		SELECT c.is_blocked, c.id, conv.last_inbound_at,
		       COALESCE(conv.channel_session_id::text, ''), COALESCE(cs.session_name, ''),
		       COALESCE(cs.provider, ''), COALESCE(c.phone_number, ''),
		       COALESCE(cs.warmup_daily_limit, 100), cs.business_hours
		FROM conversations conv
		JOIN contacts c ON c.id = conv.contact_id
		LEFT JOIN channel_sessions cs ON cs.id = conv.channel_session_id
		WHERE conv.id = $1 AND conv.organization_id = $2
	`, cid, id.OrganizationID).Scan(&isBlocked, &contactID, &lastInboundAt, &channelSessionID, &sname, &prov, &phone, &warmupLimit, &businessHours)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}

	isNote := req.ContentType == "note"
	isTemplate := req.ContentType == "template"
	if isTemplate && strings.TrimSpace(req.Body) == "" {
		req.Body = req.TemplateName
	}
	if !isNote {
		if isBlocked {
			httpx.Error(w, http.StatusUnprocessableEntity, "contact opted out (STOP)")
			return
		}
		if channelSessionID != "" {
			if !isTemplate && (lastInboundAt == nil || time.Since(*lastInboundAt) > 24*time.Hour) {
				httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{
					"error": "whatsapp_24h_window_expired",
					"code":  "WINDOW_24H_EXPIRED",
				})
				return
			}
			if !CheckBusinessHours(businessHours, time.Now()) {
				httpx.Error(w, http.StatusUnprocessableEntity, "outside_business_hours")
				return
			}
			if h.Throttle != nil && !h.Throttle.AllowOutbound(r.Context(), channelSessionID, warmupLimit) {
				httpx.Error(w, http.StatusTooManyRequests, "daily_warmup_limit_reached")
				return
			}
		}
	}

	dbContentType := req.ContentType
	if isTemplate {
		dbContentType = "text"
	}

	// Chunk messages > 4096 chars per WhatsApp limits
	chunks := chunkText(req.Body, 4096)
	var lastID string
	for i, chunk := range chunks {
		mediaArg := ""
		if i == 0 {
			mediaArg = strings.TrimSpace(req.MediaURL)
		}
		err := h.Pool.QueryRow(r.Context(), `
			INSERT INTO messages (organization_id, conversation_id, direction, sender_type, sender_user_id, content_type, body, media_url, status)
			VALUES ($1, $2, 'outbound', 'human', $3, $4, $5, NULLIF($6, ''), 'sent') RETURNING id
		`, id.OrganizationID, cid, id.UserID, dbContentType, chunk, mediaArg).Scan(&lastID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to save message")
			return
		}
	}

	if !isNote && h.Evolution != nil && prov == "evolution_go" && sname != "" && phone != "" {
		for _, chunk := range chunks {
			if chunk != "" {
				_ = h.Evolution.SendText(r.Context(), sname, phone, chunk)
			}
		}
	}

	if !isNote {
		preview := req.Body
		if preview == "" && req.MediaURL != "" {
			preview = "[media]"
		}
		preview = TruncateRunes(preview, 80)
		_, _ = h.Pool.Exec(r.Context(), `UPDATE conversations SET last_message_at=now(), last_message_preview=$1, updated_at=now() WHERE id=$2`, preview, cid)
	} else {
		_, _ = h.Pool.Exec(r.Context(), `UPDATE conversations SET updated_at=now() WHERE id=$1`, cid)
	}

	h.publish(id.OrganizationID, "message.created", map[string]any{
		"id": lastID, "conversation_id": cid, "direction": "outbound", "sender_type": "human",
		"content_type": req.ContentType, "body": req.Body, "media_url": req.MediaURL,
	})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": lastID, "chunks": len(chunks), "status": "sent", "media_url": req.MediaURL,
	})
}

func (h *Handler) ListTemplates(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `SELECT id, shortcut, title, category, body FROM message_templates WHERE organization_id=$1 ORDER BY shortcut ASC`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tid, sc, title, cat, body string
		_ = rows.Scan(&tid, &sc, &title, &cat, &body)
		out = append(out, map[string]any{"id": tid, "shortcut": sc, "title": title, "category": cat, "body": body})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateTemplate(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Shortcut string `json:"shortcut"`
		Title    string `json:"title"`
		Category string `json:"category"`
		Body     string `json:"body"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Shortcut == "" || req.Body == "" {
		httpx.Error(w, http.StatusBadRequest, "shortcut and body required")
		return
	}
	if req.Category == "" {
		req.Category = "general"
	}
	var tid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO message_templates (organization_id, shortcut, title, category, body)
		VALUES ($1,$2,$3,$4,$5) RETURNING id
	`, id.OrganizationID, req.Shortcut, req.Title, req.Category, req.Body).Scan(&tid)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "shortcut already exists")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": tid, "shortcut": req.Shortcut, "title": req.Title, "category": req.Category, "body": req.Body})
}

func (h *Handler) UpdateTemplate(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	tid := chi.URLParam(r, "id")
	var req struct {
		Shortcut *string `json:"shortcut"`
		Title    *string `json:"title"`
		Category *string `json:"category"`
		Body     *string `json:"body"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	var sc, title, cat, body string
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE message_templates SET
			shortcut = COALESCE(NULLIF($3, ''), shortcut),
			title = COALESCE($4, title),
			category = COALESCE(NULLIF($5, ''), category),
			body = COALESCE(NULLIF($6, ''), body)
		WHERE id = $1 AND organization_id = $2
		RETURNING shortcut, title, category, body
	`, tid, id.OrganizationID, req.Shortcut, req.Title, req.Category, req.Body).Scan(&sc, &title, &cat, &body)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			httpx.Error(w, http.StatusConflict, "shortcut already exists")
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "template not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": tid, "shortcut": sc, "title": title, "category": cat, "body": body,
	})
}

func (h *Handler) DeleteTemplate(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	tid := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM message_templates WHERE id = $1 AND organization_id = $2`, tid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "template not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) Radar(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT conv.id, c.name, COALESCE(c.phone_number,''), conv.status, conv.service_revision,
		       conv.last_inbound_at, conv.last_message_at, COALESCE(conv.last_message_preview,'')
		FROM conversations conv
		JOIN contacts c ON c.id = conv.contact_id
		WHERE conv.organization_id = $1 AND conv.status IN ('open','pending','claimed')
		ORDER BY conv.last_message_at ASC LIMIT 50
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, name, phone, status, preview string
		var rev int
		var lastInbound, lastAt any
		_ = rows.Scan(&cid, &name, &phone, &status, &rev, &lastInbound, &lastAt, &preview)
		out = append(out, map[string]any{
			"id": cid, "contact_name": name, "contact_phone": phone, "status": status,
			"service_revision": rev, "last_inbound_at": lastInbound,
			"last_message_at": lastAt, "last_message_preview": preview,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

// ChunkText splits s into chunks of at most max UTF-8 runes without splitting multi-byte characters.
func ChunkText(s string, max int) []string {
	if max <= 0 {
		return []string{s}
	}
	runes := []rune(s)
	if len(runes) <= max {
		return []string{s}
	}
	var res []string
	for len(runes) > max {
		res = append(res, string(runes[:max]))
		runes = runes[max:]
	}
	if len(runes) > 0 {
		res = append(res, string(runes))
	}
	return res
}

func chunkText(s string, max int) []string {
	return ChunkText(s, max)
}

// TruncateRunes truncates s to at most max UTF-8 runes and appends "..." if truncated.
func TruncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "..."
}

// CheckBusinessHours checks whether `now` falls within business_hours {"start": "HH:MM", "end": "HH:MM", "timezone": "IANA"}.
func CheckBusinessHours(bh map[string]any, now time.Time) bool {
	if len(bh) == 0 {
		return true
	}
	startStr, _ := bh["start"].(string)
	endStr, _ := bh["end"].(string)
	if startStr == "" || endStr == "" {
		return true
	}
	startMins, ok1 := parseHHMM(startStr)
	endMins, ok2 := parseHHMM(endStr)
	if !ok1 || !ok2 {
		return true
	}

	loc := time.UTC
	if tz, _ := bh["timezone"].(string); tz != "" {
		if l, err := time.LoadLocation(tz); err == nil {
			loc = l
		}
	}
	localNow := now.In(loc)
	curMins := localNow.Hour()*60 + localNow.Minute()
	if startMins <= endMins {
		return curMins >= startMins && curMins <= endMins
	}
	// Overnight wrap (e.g. 22:00 to 06:00)
	return curMins >= startMins || curMins <= endMins
}

func parseHHMM(s string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 2 {
		return 0, false
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}
