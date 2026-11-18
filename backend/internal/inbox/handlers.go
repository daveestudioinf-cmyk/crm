package inbox

import (
	"context"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type OutboundSender interface {
	SendText(ctx context.Context, instanceName, phoneNumber, text string) error
}

type Handler struct {
	Pool      *pgxpool.Pool
	Hub       *realtime.Hub
	Evolution OutboundSender
}

func (h *Handler) ListConversations(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	status := r.URL.Query().Get("status")
	rows, err := h.Pool.Query(r.Context(), `
		SELECT conv.id, conv.contact_id, c.name, COALESCE(c.phone_number,''), conv.status,
		       conv.assigned_to, conv.service_revision, COALESCE(conv.last_message_preview,''),
		       conv.last_message_at, conv.last_inbound_at, conv.unread_count, c.is_blocked, c.force_human
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
		var cid, contactID, cname, cphone, st, preview string
		var assignedTo *string
		var rev, unread int
		var lastMsg, lastIn any
		var blocked, forceHuman bool
		_ = rows.Scan(&cid, &contactID, &cname, &cphone, &st, &assignedTo, &rev, &preview, &lastMsg, &lastIn, &unread, &blocked, &forceHuman)
		out = append(out, map[string]any{
			"id": cid, "contact_id": contactID, "contact_name": cname, "contact_phone": cphone,
			"status": st, "assigned_to": assignedTo, "service_revision": rev,
			"last_message_preview": preview, "last_message_at": lastMsg, "last_inbound_at": lastIn,
			"unread_count": unread, "is_blocked": blocked, "force_human": forceHuman,
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
	var newRev int
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE conversations
		SET status = 'claimed', assigned_to = $3, service_revision = service_revision + 1, unread_count = 0, updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING service_revision
	`, cid, id.OrganizationID, id.UserID).Scan(&newRev)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	h.Hub.Publish(id.OrganizationID, "conversation.updated", map[string]any{"id": cid, "status": "claimed", "assigned_to": id.UserID})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "claimed", "service_revision": newRev})
}

func (h *Handler) ResolveConversation(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		Status string `json:"status"` // "resolved" or "ai_handling"
	}
	_ = httpx.Decode(r, &req)
	if req.Status == "" {
		req.Status = "resolved"
	}
	_, err := h.Pool.Exec(r.Context(), `
		UPDATE conversations SET status = $3, service_revision = service_revision + 1, updated_at = now()
		WHERE id = $1 AND organization_id = $2
	`, cid, id.OrganizationID, req.Status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	h.Hub.Publish(id.OrganizationID, "conversation.updated", map[string]any{"id": cid, "status": req.Status})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": req.Status})
}

func (h *Handler) ListMessages(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
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
		Body        string `json:"body"`
		ContentType string `json:"content_type"` // text | note
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Body) == "" {
		httpx.Error(w, http.StatusBadRequest, "body required")
		return
	}
	if req.ContentType == "" {
		req.ContentType = "text"
	}

	var isBlocked bool
	var contactID string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT c.is_blocked, c.id FROM conversations conv
		JOIN contacts c ON c.id = conv.contact_id
		WHERE conv.id = $1 AND conv.organization_id = $2
	`, cid, id.OrganizationID).Scan(&isBlocked, &contactID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	if isBlocked && req.ContentType != "note" {
		httpx.Error(w, http.StatusUnprocessableEntity, "contact opted out (STOP)")
		return
	}

	// Chunk messages > 4096 chars per WhatsApp limits
	chunks := chunkText(req.Body, 4096)
	var lastID string
	for _, chunk := range chunks {
		_ = h.Pool.QueryRow(r.Context(), `
			INSERT INTO messages (organization_id, conversation_id, direction, sender_type, sender_user_id, content_type, body, status)
			VALUES ($1, $2, 'outbound', 'human', $3, $4, $5, 'sent') RETURNING id
		`, id.OrganizationID, cid, id.UserID, req.ContentType, chunk).Scan(&lastID)
	}

	if h.Evolution != nil && req.ContentType == "text" {
		var sname, prov, phone string
		_ = h.Pool.QueryRow(r.Context(), `
			SELECT COALESCE(cs.session_name,''), COALESCE(cs.provider,''), COALESCE(c.phone_number,'')
			FROM conversations conv
			JOIN contacts c ON c.id = conv.contact_id
			LEFT JOIN channel_sessions cs ON cs.id = conv.channel_session_id
			WHERE conv.id = $1
		`, cid).Scan(&sname, &prov, &phone)
		if prov == "evolution_go" && sname != "" && phone != "" {
			for _, chunk := range chunks {
				_ = h.Evolution.SendText(r.Context(), sname, phone, chunk)
			}
		}
	}

	preview := req.Body
	if len(preview) > 80 {
		preview = preview[:80] + "..."
	}
	_, _ = h.Pool.Exec(r.Context(), `UPDATE conversations SET last_message_at=now(), last_message_preview=$1, updated_at=now() WHERE id=$2`, preview, cid)
	h.Hub.Publish(id.OrganizationID, "message.created", map[string]any{
		"id": lastID, "conversation_id": cid, "direction": "outbound", "sender_type": "human", "content_type": req.ContentType, "body": req.Body,
	})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": lastID, "chunks": len(chunks), "status": "sent"})
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
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": tid, "shortcut": req.Shortcut, "title": req.Title, "body": req.Body})
}

func (h *Handler) Radar(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT conv.id, c.name, COALESCE(c.phone_number,''), conv.status, conv.last_message_at, COALESCE(conv.last_message_preview,'')
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
		var lastAt any
		_ = rows.Scan(&cid, &name, &phone, &status, &lastAt, &preview)
		out = append(out, map[string]any{"id": cid, "contact_name": name, "contact_phone": phone, "status": status, "last_message_at": lastAt, "last_message_preview": preview})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func chunkText(s string, max int) []string {
	if len(s) <= max {
		return []string{s}
	}
	var res []string
	for len(s) > max {
		res = append(res, s[:max])
		s = s[max:]
	}
	if len(s) > 0 {
		res = append(res, s)
	}
	return res
}
