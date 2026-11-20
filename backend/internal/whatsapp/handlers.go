package whatsapp

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Handler struct {
	Pool         *pgxpool.Pool
	Hub          *realtime.Hub
	RDB          *redis.Client
	Evolution    *EvolutionClient
	PublicAPIURL string
}

func (h *Handler) publish(orgID, evType string, payload any) {
	if h.Hub != nil {
		h.Hub.Publish(orgID, evType, payload)
	}
}

func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, session_name, provider, engine, COALESCE(phone_number,''), status, warmup_daily_limit, created_at
		FROM channel_sessions WHERE organization_id=$1 ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, sname, prov, eng, phone, status string
		var warmup int
		var created any
		_ = rows.Scan(&cid, &sname, &prov, &eng, &phone, &status, &warmup, &created)
		out = append(out, map[string]any{
			"id": cid, "session_name": sname, "provider": prov, "engine": eng,
			"phone_number": phone, "status": status, "warmup_daily_limit": warmup, "created_at": created,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		SessionName string `json:"session_name"`
		Provider    string `json:"provider"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.SessionName) == "" {
		httpx.Error(w, http.StatusBadRequest, "session_name required")
		return
	}
	if req.Provider == "" {
		req.Provider = "evolution_go"
	}
	engine := "NOWEB"
	instanceName := strings.TrimSpace(req.SessionName)
	if req.Provider == "evolution_go" {
		engine = "WHATSMEOW"
		prefix := id.OrganizationID
		if len(prefix) > 8 {
			prefix = prefix[:8]
		}
		if !strings.HasPrefix(instanceName, prefix+"_") {
			instanceName = prefix + "_" + strings.ReplaceAll(instanceName, " ", "-")
		}
	}

	secret, _ := auth.RandomToken(24)
	var cid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO channel_sessions (organization_id, session_name, provider, engine, status, webhook_secret)
		VALUES ($1, $2, $3, $4, 'SCAN_QR_CODE', $5) RETURNING id
	`, id.OrganizationID, instanceName, req.Provider, engine, secret).Scan(&cid)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "session_name already exists")
		return
	}

	if req.Provider == "evolution_go" && h.Evolution != nil {
		webhookURL := strings.TrimRight(h.PublicAPIURL, "/") + "/api/v1/webhooks/evolution/" + instanceName + "?secret=" + secret
		if err := h.Evolution.CreateInstance(r.Context(), instanceName, webhookURL, secret); err != nil {
			_, _ = h.Pool.Exec(r.Context(), `DELETE FROM channel_sessions WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID)
			httpx.Error(w, http.StatusBadGateway, "evolution create instance failed: "+err.Error())
			return
		}
	}

	h.publish(id.OrganizationID, "channel.updated", map[string]any{"id": cid, "session_name": instanceName, "status": "SCAN_QR_CODE"})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": cid, "session_name": instanceName, "provider": req.Provider, "engine": engine,
		"status": "SCAN_QR_CODE", "warmup_daily_limit": 100, "webhook_secret": secret,
	})
}

func (h *Handler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		WarmupDailyLimit int `json:"warmup_daily_limit"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.WarmupDailyLimit < 1 || req.WarmupDailyLimit > 5000 {
		httpx.Error(w, http.StatusBadRequest, "warmup_daily_limit must be between 1 and 5000")
		return
	}
	var sname, status string
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE channel_sessions SET warmup_daily_limit=$3, updated_at=now()
		WHERE id=$1 AND organization_id=$2
		RETURNING session_name, status
	`, cid, id.OrganizationID, req.WarmupDailyLimit).Scan(&sname, &status)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "channel not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	h.publish(id.OrganizationID, "channel.updated", map[string]any{"id": cid, "session_name": sname, "status": status, "warmup_daily_limit": req.WarmupDailyLimit})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid, "warmup_daily_limit": req.WarmupDailyLimit, "status": status})
}

func (h *Handler) GetQR(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var status, sname, prov string
	err := h.Pool.QueryRow(r.Context(), `SELECT session_name, provider, status FROM channel_sessions WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID).Scan(&sname, &prov, &status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "channel not found")
		return
	}

	if prov == "evolution_go" && h.Evolution != nil {
		b64, code, err := h.Evolution.ConnectQR(r.Context(), sname)
		if err == nil {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"id": cid, "session_name": sname, "status": status,
				"qr_base64": b64, "qr_payload": code,
			})
			return
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": cid, "session_name": sname, "status": status,
		"qr_payload": "kora-" + prov + "-qr://" + cid + "/" + sname,
	})
}

func (h *Handler) ReconnectChannel(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var sname, prov string
	err := h.Pool.QueryRow(r.Context(), `SELECT session_name, provider FROM channel_sessions WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID).Scan(&sname, &prov)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "channel not found")
		return
	}

	if prov == "evolution_go" && h.Evolution != nil {
		b64, code, err := h.Evolution.ConnectQR(r.Context(), sname)
		if err != nil {
			_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='FAILED', updated_at=now() WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID)
			h.publish(id.OrganizationID, "channel.updated", map[string]any{"id": cid, "session_name": sname, "status": "FAILED"})
			httpx.Error(w, http.StatusBadGateway, "evolution reconnect failed: "+err.Error())
			return
		}
		_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='SCAN_QR_CODE', updated_at=now() WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID)
		h.publish(id.OrganizationID, "channel.updated", map[string]any{"id": cid, "session_name": sname, "status": "SCAN_QR_CODE"})
		httpx.JSON(w, http.StatusOK, map[string]any{"id": cid, "status": "SCAN_QR_CODE", "qr_base64": b64, "qr_payload": code})
		return
	}

	_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='WORKING', updated_at=now() WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID)
	h.publish(id.OrganizationID, "channel.updated", map[string]any{"id": cid, "session_name": sname, "status": "WORKING"})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid, "status": "WORKING"})
}

func (h *Handler) DisconnectChannel(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var sname, prov string
	err := h.Pool.QueryRow(r.Context(), `SELECT session_name, provider FROM channel_sessions WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID).Scan(&sname, &prov)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "channel not found")
		return
	}
	if prov == "evolution_go" && h.Evolution != nil {
		if err := h.Evolution.LogoutInstance(r.Context(), sname); err != nil {
			httpx.Error(w, http.StatusBadGateway, "evolution logout failed: "+err.Error())
			return
		}
	}
	_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='STOPPED', updated_at=now() WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID)
	h.publish(id.OrganizationID, "channel.updated", map[string]any{"id": cid, "session_name": sname, "status": "STOPPED"})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid, "status": "STOPPED"})
}

func (h *Handler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var sname, prov string
	err := h.Pool.QueryRow(r.Context(), `SELECT session_name, provider FROM channel_sessions WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID).Scan(&sname, &prov)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "channel not found")
		return
	}
	if prov == "evolution_go" && h.Evolution != nil {
		if err := h.Evolution.DeleteInstance(r.Context(), sname); err != nil {
			httpx.Error(w, http.StatusBadGateway, "evolution delete failed: "+err.Error())
			return
		}
	}
	_, _ = h.Pool.Exec(r.Context(), `DELETE FROM channel_sessions WHERE id=$1 AND organization_id=$2`, cid, id.OrganizationID)
	h.publish(id.OrganizationID, "channel.deleted", map[string]any{"id": cid, "session_name": sname})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// AllowOutbound checks Redis token-bucket anti-ban limit for a session.
func (h *Handler) AllowOutbound(ctx context.Context, sessionID string, dailyLimit int) bool {
	if h.RDB == nil {
		return true
	}
	key := "wa:throttle:" + sessionID + ":" + time.Now().UTC().Format("2006-01-02")
	cnt, err := h.RDB.Incr(ctx, key).Result()
	if err != nil {
		return true
	}
	if cnt == 1 {
		h.RDB.Expire(ctx, key, 25*time.Hour)
	}
	return int(cnt) <= dailyLimit
}

// WAHAWebhook handles inbound WhatsApp webhooks with HMAC-SHA512 verification and idempotency.
func (h *Handler) WAHAWebhook(w http.ResponseWriter, r *http.Request) {
	sessionName := chi.URLParam(r, "session")
	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "cannot read body")
		return
	}

	var sessionID, orgID, secret string
	var isSuspended bool
	err = h.Pool.QueryRow(r.Context(), `
		SELECT cs.id, cs.organization_id, cs.webhook_secret, o.is_suspended
		FROM channel_sessions cs
		JOIN organizations o ON o.id = cs.organization_id
		WHERE cs.session_name=$1 LIMIT 1
	`, sessionName).Scan(&sessionID, &orgID, &secret, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "unknown session")
		return
	}

	if sig := r.Header.Get("X-Webhook-Hmac"); sig != "" {
		mac := hmac.New(sha512.New, []byte(secret))
		mac.Write(bodyBytes)
		expected := hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(strings.ToLower(sig)), []byte(expected)) {
			httpx.Error(w, http.StatusUnauthorized, "invalid hmac signature")
			return
		}
	}

	if isSuspended {
		httpx.Error(w, http.StatusForbidden, "tenant_suspended")
		return
	}

	var payload struct {
		ExternalID string `json:"external_id"`
		FromPhone  string `json:"from_phone"`
		FromName   string `json:"from_name"`
		Body       string `json:"body"`
	}
	if err := json.Unmarshal(bodyBytes, &payload); err != nil || payload.FromPhone == "" {
		httpx.Error(w, http.StatusBadRequest, "from_phone required")
		return
	}
	h.ingestInbound(w, r, sessionID, orgID, payload.ExternalID, payload.FromPhone, payload.FromName, payload.Body)
}

// EvolutionWebhook handles Evolution Go / Evolution API v2 instance events (connection.update + QRCODE_UPDATED + messages.upsert).
func (h *Handler) EvolutionWebhook(w http.ResponseWriter, r *http.Request) {
	sessionName := chi.URLParam(r, "session")
	var sessionID, orgID, secret string
	var isSuspended bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT cs.id, cs.organization_id, cs.webhook_secret, o.is_suspended
		FROM channel_sessions cs
		JOIN organizations o ON o.id = cs.organization_id
		WHERE cs.session_name=$1 LIMIT 1
	`, sessionName).Scan(&sessionID, &orgID, &secret, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "unknown evolution session")
		return
	}

	providedSecret := r.Header.Get("X-Webhook-Secret")
	if providedSecret == "" {
		providedSecret = r.URL.Query().Get("secret")
	}
	apiKeyHeader := r.Header.Get("apikey")
	authorized := (secret != "" && hmac.Equal([]byte(providedSecret), []byte(secret))) ||
		(h.Evolution != nil && h.Evolution.APIKey != "" && hmac.Equal([]byte(apiKeyHeader), []byte(h.Evolution.APIKey)))
	if !authorized {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized_webhook")
		return
	}

	if isSuspended {
		httpx.Error(w, http.StatusForbidden, "tenant_suspended")
		return
	}

	var ev struct {
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
	}
	if err := httpx.Decode(r, &ev); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	evLower := strings.ToLower(ev.Event)
	if strings.Contains(evLower, "qrcode") {
		_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='SCAN_QR_CODE', updated_at=now() WHERE id=$1`, sessionID)
		h.publish(orgID, "channel.updated", map[string]any{"id": sessionID, "session_name": sessionName, "status": "SCAN_QR_CODE"})
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "qr_updated"})
		return
	}

	if strings.Contains(evLower, "connection") {
		var conn struct {
			State string `json:"state"`
			WUID  string `json:"wuid"`
		}
		_ = json.Unmarshal(ev.Data, &conn)
		newStatus := ""
		switch strings.ToLower(conn.State) {
		case "open":
			newStatus = "WORKING"
			rawPhone := strings.TrimPrefix(strings.Split(conn.WUID, "@")[0], "+")
			if rawPhone != "" {
				_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='WORKING', phone_number=$1, updated_at=now() WHERE id=$2`, "+"+rawPhone, sessionID)
			} else {
				_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='WORKING', updated_at=now() WHERE id=$1`, sessionID)
			}
		case "connecting":
			newStatus = "SCAN_QR_CODE"
			_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='SCAN_QR_CODE', updated_at=now() WHERE id=$1`, sessionID)
		case "close":
			newStatus = "FAILED"
			_, _ = h.Pool.Exec(r.Context(), `UPDATE channel_sessions SET status='FAILED', updated_at=now() WHERE id=$1`, sessionID)
		}
		if newStatus != "" {
			h.publish(orgID, "channel.updated", map[string]any{"id": sessionID, "session_name": sessionName, "status": newStatus})
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "connection_updated"})
		return
	}

	if strings.Contains(evLower, "messages.upsert") || evLower == "message" {
		var msg struct {
			Key struct {
				ID        string `json:"id"`
				RemoteJID string `json:"remoteJid"`
				FromMe    bool   `json:"fromMe"`
			} `json:"key"`
			PushName string `json:"pushName"`
			Message  struct {
				Conversation        string `json:"conversation"`
				ExtendedTextMessage struct {
					Text string `json:"text"`
				} `json:"extendedTextMessage"`
			} `json:"message"`
		}
		if err := json.Unmarshal(ev.Data, &msg); err != nil || msg.Key.FromMe {
			httpx.JSON(w, http.StatusOK, map[string]string{"status": "ignored"})
			return
		}
		if strings.HasSuffix(msg.Key.RemoteJID, "@g.us") || msg.Key.RemoteJID == "status@broadcast" {
			httpx.JSON(w, http.StatusOK, map[string]string{"status": "group_ignored"})
			return
		}
		phone := "+" + strings.TrimPrefix(strings.Split(msg.Key.RemoteJID, "@")[0], "+")
		body := msg.Message.Conversation
		if body == "" {
			body = msg.Message.ExtendedTextMessage.Text
		}
		if body == "" {
			httpx.JSON(w, http.StatusOK, map[string]string{"status": "empty_ignored"})
			return
		}
		h.ingestInbound(w, r, sessionID, orgID, msg.Key.ID, phone, msg.PushName, body)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) ingestInbound(w http.ResponseWriter, r *http.Request, sessionID, orgID, extID, fromPhone, fromName, body string) {
	if fromName == "" {
		fromName = fromPhone
	}
	var contactID string
	var forceHuman, isBlocked bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT id, force_human, is_blocked FROM contacts
		WHERE organization_id=$1 AND phone_number=$2 AND is_merged_into IS NULL LIMIT 1
	`, orgID, fromPhone).Scan(&contactID, &forceHuman, &isBlocked)
	if err != nil {
		_ = h.Pool.QueryRow(r.Context(), `
			INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, $2, $3) RETURNING id
		`, orgID, fromName, fromPhone).Scan(&contactID)
	}

	upper := strings.ToUpper(strings.TrimSpace(body))
	if upper == "STOP" || upper == "SAIR" || upper == "PARAR" {
		_, _ = h.Pool.Exec(r.Context(), `UPDATE contacts SET is_blocked=true, updated_at=now() WHERE id=$1`, contactID)
		isBlocked = true
	}

	var convID, convStatus string
	err = h.Pool.QueryRow(r.Context(), `
		SELECT id, status FROM conversations
		WHERE organization_id=$1 AND contact_id=$2 AND status NOT IN ('closed','resolved')
		ORDER BY created_at DESC LIMIT 1
	`, orgID, contactID).Scan(&convID, &convStatus)
	if err != nil {
		convStatus = "ai_handling"
		if forceHuman || isBlocked {
			convStatus = "pending"
		}
		_ = h.Pool.QueryRow(r.Context(), `
			INSERT INTO conversations (organization_id, contact_id, channel_session_id, status, last_inbound_at, last_message_preview)
			VALUES ($1, $2, $3, $4, now(), $5) RETURNING id
		`, orgID, contactID, sessionID, convStatus, body).Scan(&convID)
	}

	var msgID string
	err = h.Pool.QueryRow(r.Context(), `
		INSERT INTO messages (organization_id, conversation_id, external_id, direction, sender_type, content_type, body, status)
		VALUES ($1, $2, NULLIF($3,''), 'inbound', 'customer', 'text', $4, 'delivered')
		RETURNING id
	`, orgID, convID, extID, body).Scan(&msgID)
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "duplicate_ignored"})
		return
	}

	_, _ = h.Pool.Exec(r.Context(), `
		UPDATE conversations SET last_inbound_at=now(), last_message_at=now(), last_message_preview=$1, unread_count=unread_count+1, updated_at=now()
		WHERE id=$2
	`, body, convID)

	if convStatus == "ai_handling" && !forceHuman && !isBlocked {
		_, _ = h.Pool.Exec(r.Context(), `
			INSERT INTO event_log (organization_id, event_type, payload)
			VALUES ($1, 'ai.turn', jsonb_build_object('conversation_id', $2::text, 'message_id', $3::text, 'body', $4::text))
		`, orgID, convID, msgID, body)
	}

	_, _ = h.Pool.Exec(r.Context(), `
		INSERT INTO event_log (organization_id, event_type, payload)
		VALUES
			($1, 'automation.evaluate', jsonb_build_object(
				'trigger_event', 'message.inbound',
				'conversation_id', $2::text,
				'contact_id', $3::text,
				'message_id', $4::text,
				'body', $5::text,
				'from_phone', $6::text,
				'from_name', $7::text
			)),
			($1, 'sentiment.analyze', jsonb_build_object(
				'conversation_id', $2::text,
				'contact_id', $3::text,
				'message_id', $4::text,
				'body', $5::text
			))
	`, orgID, convID, contactID, msgID, body, fromPhone, fromName)

	h.publish(orgID, "message.created", map[string]any{
		"id": msgID, "conversation_id": convID, "direction": "inbound", "sender_type": "customer", "body": body,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "received", "conversation_id": convID, "message_id": msgID})
}
