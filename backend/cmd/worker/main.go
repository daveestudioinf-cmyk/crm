package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/automation"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/inbox"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/whatsapp"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func main() {
	cfg := config.Load()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool, "migrations"); err != nil {
		log.Fatalf("migrations failed: %v", err)
	}

	var rdb *redis.Client
	if cfg.RedisURL != "" {
		if opt, err := redis.ParseURL(cfg.RedisURL); err == nil {
			rdb = redis.NewClient(opt)
		}
	}

	hub := realtime.NewHub(cfg.RedisURL)
	evoClient := whatsapp.NewEvolutionClient(cfg.EvolutionURL, cfg.EvolutionAPIKey)
	waThrottle := &whatsapp.Handler{RDB: rdb}

	runner := &ai.Runner{
		Pool:          pool,
		Hub:           hub,
		EncryptionKey: cfg.AIEncryptionKey,
		Throttle:      waThrottle,
	}
	if evoClient != nil {
		runner.Outbound = evoClient
	}

	log.Println("KoraCRM Worker started")

	drainTicker := time.NewTicker(2 * time.Second)
	defer drainTicker.Stop()

	stuckTicker := time.NewTicker(1 * time.Minute)
	defer stuckTicker.Stop()

	syncTicker := time.NewTicker(30 * time.Second)
	defer syncTicker.Stop()

	followupTicker := time.NewTicker(15 * time.Second)
	defer followupTicker.Stop()

	campaignTicker := time.NewTicker(15 * time.Second)
	defer campaignTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("KoraCRM Worker stopping")
			return
		case <-drainTicker.C:
			drainEvents(ctx, pool, hub, runner, evoClient, waThrottle)
		case <-stuckTicker.C:
			recoverStuckEvents(ctx, pool)
		case <-syncTicker.C:
			syncSessions(ctx, pool, hub, evoClient)
		case <-followupTicker.C:
			enqueueDueFollowups(ctx, pool)
		case <-campaignTicker.C:
			enqueueDueCampaigns(ctx, pool)
		}
	}
}

// backoffDelay returns the exponential backoff duration for a failed event attempt:
// 2^attempts * 5 seconds (capped at 1 hour).
func backoffDelay(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	if attempts > 10 {
		attempts = 10
	}
	d := time.Duration(1<<attempts) * 5 * time.Second
	if d > time.Hour {
		return time.Hour
	}
	return d
}

// stuckRecoveryStatus decides whether a stuck 'processing' event should be
// retried ('pending') or permanently failed ('failed').
func stuckRecoveryStatus(attempts, maxAttempts int) string {
	if attempts < maxAttempts {
		return "pending"
	}
	return "failed"
}

func markEventRetryOrFail(ctx context.Context, pool *pgxpool.Pool, id string, attempts, maxAttempts int, errMsg string) {
	if attempts < maxAttempts {
		delay := backoffDelay(attempts)
		_, _ = pool.Exec(ctx, `
			UPDATE event_log
			SET status = 'pending',
			    available_at = now() + ($2 * interval '1 second'),
			    last_error = $3,
			    updated_at = now()
			WHERE id = $1
		`, id, int(delay.Seconds()), errMsg)
		return
	}
	_, _ = pool.Exec(ctx, `
		UPDATE event_log
		SET status = 'failed',
		    last_error = $2,
		    updated_at = now()
		WHERE id = $1
	`, id, errMsg)
}

func drainEvents(
	ctx context.Context,
	pool *pgxpool.Pool,
	hub *realtime.Hub,
	runner *ai.Runner,
	evoClient *whatsapp.EvolutionClient,
	waThrottle *whatsapp.Handler,
) {
	rows, err := pool.Query(ctx, `
		UPDATE event_log
		SET status = 'processing', attempts = attempts + 1, updated_at = now()
		WHERE id IN (
			SELECT id FROM event_log
			WHERE status = 'pending' AND available_at <= now()
			ORDER BY created_at ASC
			LIMIT 10
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, organization_id, event_type, payload, attempts, max_attempts
	`)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var id, orgID, evType string
		var rawPayload []byte
		var attempts, maxAttempts int
		if err := rows.Scan(&id, &orgID, &evType, &rawPayload, &attempts, &maxAttempts); err != nil {
			continue
		}
		var isSuspended bool
		if err := pool.QueryRow(ctx, `SELECT is_suspended FROM organizations WHERE id = $1`, orgID).Scan(&isSuspended); err != nil || isSuspended {
			_, _ = pool.Exec(ctx, `UPDATE event_log SET status = 'failed', last_error = 'skipped_suspended', updated_at = now() WHERE id = $1`, id)
			continue
		}

		var handlerErr error
		switch evType {
		case "ai.turn":
			var p struct {
				ConversationID string `json:"conversation_id"`
				Body           string `json:"body"`
			}
			if err := json.Unmarshal(rawPayload, &p); err != nil {
				handlerErr = err
			} else {
				handlerErr = runner.RunAgentTurn(ctx, orgID, p.ConversationID, p.Body)
			}

		case "automation.evaluate":
			var payloadMap map[string]any
			if err := json.Unmarshal(rawPayload, &payloadMap); err != nil {
				handlerErr = err
			} else {
				triggerEvent, _ := payloadMap["trigger_event"].(string)
				if triggerEvent == "" {
					triggerEvent = evType
				}
				handlerErr = automation.EvaluateEvent(ctx, pool, hub, evoClient, orgID, id, triggerEvent, payloadMap)
			}

		case "sentiment.analyze":
			handlerErr = handleSentimentAnalyze(ctx, pool, hub, orgID, rawPayload)

		case "followup.dispatch":
			handlerErr = handleFollowupDispatch(ctx, pool, evoClient, waThrottle, orgID, rawPayload)

		case "campaign.send":
			handlerErr = handleCampaignSend(ctx, pool, hub, evoClient, waThrottle, orgID, rawPayload)
		}

		if handlerErr != nil {
			markEventRetryOrFail(ctx, pool, id, attempts, maxAttempts, handlerErr.Error())
			continue
		}
		_, _ = pool.Exec(ctx, `UPDATE event_log SET status = 'done', updated_at = now() WHERE id = $1`, id)
	}
}

// scoreSentiment computes a deterministic sentiment score in [-1.0, 1.0]
// for Spanish, Portuguese, and English customer messages.
func scoreSentiment(body string) float64 {
	lower := strings.ToLower(strings.TrimSpace(body))
	if lower == "" {
		return 0.0
	}

	negativeStrong := []string{
		"estafa", "fraude", "basura", "porquería", "porqueria", "horrible", "pésimo", "pesimo",
		"demanda", "abogado", "procon", "denuncia", "robo", "ladrón", "ladron", "odiar", "odio",
		"scam", "fraud", "terrible", "awful", "worst", "lawsuit", "sue", "refund now", "cancelar todo",
	}
	negativeMild := []string{
		"malo", "lento", "problema", "error", "molesto", "enojado", "frustrado", "queja",
		"no funciona", "nunca", "tarde", "caro", "decepcionado", "esperando", "reembolso",
		"bad", "slow", "broken", "angry", "upset", "issue", "complaint", "disappointed",
	}
	positiveWords := []string{
		"gracias", "excelente", "genial", "perfecto", "bueno", "rápido", "rapido", "amable",
		"encanta", "feliz", "maravilloso", "satisfecho", "recomiendo", "obrigado", "ótimo", "otimo",
		"thanks", "thank you", "great", "awesome", "love", "perfect", "helpful", "happy",
	}

	score := 0.0
	for _, w := range negativeStrong {
		if strings.Contains(lower, w) {
			score -= 0.55
		}
	}
	for _, w := range negativeMild {
		if strings.Contains(lower, w) {
			score -= 0.25
		}
	}
	for _, w := range positiveWords {
		if strings.Contains(lower, w) {
			score += 0.35
		}
	}

	if score > 1.0 {
		score = 1.0
	}
	if score < -1.0 {
		score = -1.0
	}
	return score
}

const negativeSentimentThreshold = -0.5

func handleSentimentAnalyze(ctx context.Context, pool *pgxpool.Pool, hub *realtime.Hub, orgID string, rawPayload []byte) error {
	var p struct {
		ConversationID string `json:"conversation_id"`
		ContactID      string `json:"contact_id"`
		MessageID      string `json:"message_id"`
		Body           string `json:"body"`
	}
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return err
	}

	score := scoreSentiment(p.Body)
	if p.MessageID != "" {
		_, err := pool.Exec(ctx, `
			UPDATE messages SET sentiment_score = $1
			WHERE id = $2 AND organization_id = $3
		`, score, p.MessageID, orgID)
		if err != nil {
			return err
		}
	}

	if score <= negativeSentimentThreshold {
		severity := "high"
		if score <= -0.8 {
			severity = "critical"
		}
		title := "Sentimiento negativo detectado"
		summary := fmt.Sprintf("Score %.2f en mensaje del cliente: %s", score, truncateStr(p.Body, 180))

		var caseID string
		err := pool.QueryRow(ctx, `
			INSERT INTO agent_cases (organization_id, conversation_id, contact_id, title, summary, status)
			VALUES ($1, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, $4, $5, 'awaiting_human')
			RETURNING id
		`, orgID, p.ConversationID, p.ContactID, title, summary).Scan(&caseID)
		if err != nil {
			return err
		}

		_, err = pool.Exec(ctx, `
			INSERT INTO agent_inbox_items (organization_id, case_id, severity, category, message)
			VALUES ($1, $2, $3, 'negative_sentiment', $4)
		`, orgID, caseID, severity, summary)
		if err != nil {
			return err
		}

		if p.ConversationID != "" {
			_, _ = pool.Exec(ctx, `
				UPDATE conversations SET status = 'pending', updated_at = now()
				WHERE id = $1 AND organization_id = $2
			`, p.ConversationID, orgID)
		}

		if hub != nil {
			hub.Publish(orgID, "ai.case_created", map[string]any{
				"case_id":         caseID,
				"conversation_id": p.ConversationID,
				"contact_id":      p.ContactID,
				"sentiment_score": score,
				"severity":        severity,
			})
		}
	}

	return nil
}

func truncateStr(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func handleFollowupDispatch(
	ctx context.Context,
	pool *pgxpool.Pool,
	evoClient *whatsapp.EvolutionClient,
	waThrottle *whatsapp.Handler,
	orgID string,
	rawPayload []byte,
) error {
	var p struct {
		EnrollmentID string `json:"enrollment_id"`
	}
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return err
	}
	if p.EnrollmentID == "" {
		return fmt.Errorf("missing enrollment_id")
	}

	var contactID, convID, flowID, promptTemplate, status string
	var currentStep, attempts, maxAttempts, delayMinutes int
	var stepsRaw []byte
	var channelSessionID, sessionName, phone, contactName string
	var warmupLimit int
	var isBlocked bool

	err := pool.QueryRow(ctx, `
		SELECT e.contact_id, COALESCE(e.conversation_id::text, ''), e.flow_id, e.current_step, e.attempts, e.status,
		       f.prompt_template, f.max_attempts, f.delay_minutes, f.steps,
		       COALESCE(f.channel_session_id::text, ''),
		       COALESCE(c.phone_number, ''), c.name, c.is_blocked
		FROM followup_enrollments e
		JOIN followup_flows f ON f.id = e.flow_id
		JOIN contacts c ON c.id = e.contact_id
		WHERE e.id = $1 AND e.organization_id = $2
	`, p.EnrollmentID, orgID).Scan(
		&contactID, &convID, &flowID, &currentStep, &attempts, &status,
		&promptTemplate, &maxAttempts, &delayMinutes, &stepsRaw,
		&channelSessionID, &phone, &contactName, &isBlocked,
	)
	if err != nil {
		return err
	}

	if status != "active" {
		return nil
	}
	if isBlocked {
		_, _ = pool.Exec(ctx, `UPDATE followup_enrollments SET status = 'cancelled', updated_at = now() WHERE id = $1`, p.EnrollmentID)
		return nil
	}

	msgText := promptTemplate
	var steps []struct {
		Prompt  string `json:"prompt"`
		Message string `json:"message"`
	}
	if json.Unmarshal(stepsRaw, &steps) == nil && currentStep < len(steps) {
		if steps[currentStep].Message != "" {
			msgText = steps[currentStep].Message
		} else if steps[currentStep].Prompt != "" {
			msgText = steps[currentStep].Prompt
		}
	}
	msgText = strings.ReplaceAll(msgText, "{{name}}", contactName)
	if strings.TrimSpace(msgText) == "" {
		msgText = fmt.Sprintf("Hola %s, te damos seguimiento a tu consulta.", contactName)
	}

	if channelSessionID != "" {
		_ = pool.QueryRow(ctx, `
			SELECT session_name, warmup_daily_limit FROM channel_sessions
			WHERE id = $1 AND organization_id = $2 AND status = 'WORKING'
		`, channelSessionID, orgID).Scan(&sessionName, &warmupLimit)
	}
	if sessionName == "" {
		_ = pool.QueryRow(ctx, `
			SELECT session_name, warmup_daily_limit FROM channel_sessions
			WHERE organization_id = $1 AND status = 'WORKING'
			ORDER BY created_at ASC LIMIT 1
		`, orgID).Scan(&sessionName, &warmupLimit)
	}

	if evoClient != nil && sessionName != "" && phone != "" {
		if waThrottle == nil || waThrottle.AllowOutbound(ctx, sessionName, warmupLimit) {
			if err := evoClient.SendText(ctx, sessionName, phone, msgText); err != nil {
				return err
			}
		}
	}

	if convID != "" {
		_, _ = pool.Exec(ctx, `
			INSERT INTO messages (organization_id, conversation_id, direction, sender_type, content_type, body, status)
			VALUES ($1, $2, 'outbound', 'system', 'text', $3, 'sent')
		`, orgID, convID, msgText)
	}

	nextAttempts := attempts + 1
	nextStep := currentStep + 1
	if nextAttempts >= maxAttempts || (len(steps) > 0 && nextStep >= len(steps)) {
		_, err = pool.Exec(ctx, `
			UPDATE followup_enrollments
			SET attempts = $2, current_step = $3, status = 'completed', updated_at = now()
			WHERE id = $1
		`, p.EnrollmentID, nextAttempts, nextStep)
		return err
	}

	if delayMinutes <= 0 {
		delayMinutes = 60
	}
	_, err = pool.Exec(ctx, `
		UPDATE followup_enrollments
		SET attempts = $2, current_step = $3,
		    next_run_at = now() + ($4 * interval '1 minute'),
		    updated_at = now()
		WHERE id = $1
	`, p.EnrollmentID, nextAttempts, nextStep, delayMinutes)
	return err
}

func recoverStuckEvents(ctx context.Context, pool *pgxpool.Pool) {
	_, _ = pool.Exec(ctx, `
		UPDATE event_log
		SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
		    available_at = CASE WHEN attempts < max_attempts THEN now() ELSE available_at END,
		    last_error = CASE WHEN attempts < max_attempts THEN 'recovered_stuck' ELSE 'max_attempts_stuck' END,
		    updated_at = now()
		WHERE status = 'processing' AND updated_at < now() - interval '5 minutes'
	`)
}

func mapEvolutionStateToStatus(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "open":
		return "WORKING"
	case "connecting":
		return "SCAN_QR_CODE"
	case "close", "closed":
		return "FAILED"
	default:
		return ""
	}
}

func syncSessions(ctx context.Context, pool *pgxpool.Pool, hub *realtime.Hub, evoClient *whatsapp.EvolutionClient) {
	if evoClient == nil {
		return
	}
	rows, err := pool.Query(ctx, `
		SELECT id, organization_id, session_name, status
		FROM channel_sessions
		WHERE provider = 'evolution_go' AND status IN ('WORKING', 'SCAN_QR_CODE', 'STARTING')
	`)
	if err != nil {
		return
	}
	type sessionRow struct {
		ID, OrgID, Name, Status string
	}
	var sessions []sessionRow
	for rows.Next() {
		var s sessionRow
		if rows.Scan(&s.ID, &s.OrgID, &s.Name, &s.Status) == nil {
			sessions = append(sessions, s)
		}
	}
	rows.Close()

	for _, s := range sessions {
		state, err := evoClient.ConnectionState(ctx, s.Name)
		if err != nil || state == "" {
			continue
		}
		mapped := mapEvolutionStateToStatus(state)
		if mapped != "" && mapped != s.Status {
			_, _ = pool.Exec(ctx, `UPDATE channel_sessions SET status = $1, updated_at = now() WHERE id = $2`, mapped, s.ID)
			if hub != nil {
				hub.Publish(s.OrgID, "channel.updated", map[string]any{
					"id":           s.ID,
					"session_name": s.Name,
					"status":       mapped,
				})
			}
		}
	}
}

func enqueueDueFollowups(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := pool.Query(ctx, `
		UPDATE followup_enrollments e
		SET next_run_at = now() + interval '5 minutes', updated_at = now()
		FROM organizations o, followup_flows f
		WHERE e.organization_id = o.id
		  AND e.flow_id = f.id
		  AND o.is_suspended = false
		  AND f.is_active = true
		  AND e.status = 'active'
		  AND e.next_run_at <= now()
		RETURNING e.id, e.organization_id
	`)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var enrollmentID, orgID string
		if rows.Scan(&enrollmentID, &orgID) == nil {
			_, _ = pool.Exec(ctx, `
				INSERT INTO event_log (organization_id, event_type, payload)
				VALUES ($1, 'followup.dispatch', jsonb_build_object('enrollment_id', $2::text))
			`, orgID, enrollmentID)
		}
	}
}

func renderCampaignTemplate(tmpl, contactName string) string {
	name := strings.TrimSpace(contactName)
	out := strings.ReplaceAll(tmpl, "{{name}}", name)
	out = strings.ReplaceAll(out, "{{nombre}}", name)
	return out
}

func computeCampaignJitter(minDelaySec, maxDelaySec, throttlePerMinute int) int {
	if minDelaySec <= 0 {
		minDelaySec = 5
	}
	if maxDelaySec < minDelaySec {
		maxDelaySec = minDelaySec
	}
	delay := minDelaySec
	if maxDelaySec > minDelaySec {
		delay = minDelaySec + rand.Intn(maxDelaySec-minDelaySec+1)
	}
	if throttlePerMinute > 0 {
		minFromThrottle := 60 / throttlePerMinute
		if minFromThrottle < 1 {
			minFromThrottle = 1
		}
		if delay < minFromThrottle {
			delay = minFromThrottle
		}
	}
	return delay
}

func effectiveCampaignDailyLimit(warmupLimit, dailyCap int) int {
	if warmupLimit <= 0 {
		warmupLimit = 100
	}
	if dailyCap > 0 && dailyCap < warmupLimit {
		return dailyCap
	}
	return warmupLimit
}

func enqueueDueCampaigns(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := pool.Query(ctx, `
		UPDATE campaigns c
		SET status = 'running',
		    started_at = COALESCE(c.started_at, now()),
		    updated_at = now()
		FROM organizations o
		WHERE c.organization_id = o.id
		  AND o.is_suspended = false
		  AND c.status = 'scheduled'
		  AND c.scheduled_at IS NOT NULL
		  AND c.scheduled_at <= now()
		RETURNING c.id, c.organization_id, c.total_count
	`)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var campID, orgID string
		var totalCount int
		if rows.Scan(&campID, &orgID, &totalCount) == nil {
			if totalCount == 0 {
				_, _ = automation.MaterializeCampaignRecipients(ctx, pool, orgID, campID, nil)
			}
			_, _ = pool.Exec(ctx, `
				INSERT INTO event_log (organization_id, event_type, payload, status, available_at)
				VALUES ($1, 'campaign.send', jsonb_build_object('campaign_id', $2::text), 'pending', now())
			`, orgID, campID)
		}
	}
}

func scheduleNextCampaignSend(ctx context.Context, pool *pgxpool.Pool, orgID, campaignID string, delaySeconds int) {
	if delaySeconds < 0 {
		delaySeconds = 0
	}
	_, _ = pool.Exec(ctx, `
		INSERT INTO event_log (organization_id, event_type, payload, status, available_at)
		VALUES ($1, 'campaign.send', jsonb_build_object('campaign_id', $2::text), 'pending', now() + ($3 * interval '1 second'))
	`, orgID, campaignID, delaySeconds)
}

func handleCampaignSend(
	ctx context.Context,
	pool *pgxpool.Pool,
	hub *realtime.Hub,
	evoClient *whatsapp.EvolutionClient,
	waThrottle *whatsapp.Handler,
	orgID string,
	rawPayload []byte,
) error {
	var p struct {
		CampaignID string `json:"campaign_id"`
	}
	if err := json.Unmarshal(rawPayload, &p); err != nil {
		return err
	}
	if strings.TrimSpace(p.CampaignID) == "" {
		return nil
	}

	var status, channelSessionID, tmpl string
	var throttlePerMin, minDelay, maxDelay, dailyCap int
	var respectBH bool
	err := pool.QueryRow(ctx, `
		SELECT status, COALESCE(channel_session_id::text, ''), message_template,
		       throttle_per_minute, min_delay_sec, max_delay_sec, daily_cap, respect_business_hours
		FROM campaigns
		WHERE id = $1 AND organization_id = $2
	`, p.CampaignID, orgID).Scan(
		&status, &channelSessionID, &tmpl,
		&throttlePerMin, &minDelay, &maxDelay, &dailyCap, &respectBH,
	)
	if err != nil {
		return nil
	}
	if status != "running" {
		return nil
	}

	var sessionID, sessionName string
	var warmupLimit int
	var bhRaw []byte
	if channelSessionID != "" {
		_ = pool.QueryRow(ctx, `
			SELECT id::text, session_name, warmup_daily_limit, business_hours
			FROM channel_sessions
			WHERE id = $1 AND organization_id = $2 AND status = 'WORKING'
		`, channelSessionID, orgID).Scan(&sessionID, &sessionName, &warmupLimit, &bhRaw)
	}
	if sessionID == "" {
		_ = pool.QueryRow(ctx, `
			SELECT id::text, session_name, warmup_daily_limit, business_hours
			FROM channel_sessions
			WHERE organization_id = $1 AND status = 'WORKING'
			ORDER BY created_at ASC LIMIT 1
		`, orgID).Scan(&sessionID, &sessionName, &warmupLimit, &bhRaw)
	}

	if respectBH && len(bhRaw) > 0 {
		var bhMap map[string]any
		if json.Unmarshal(bhRaw, &bhMap) == nil && !inbox.CheckBusinessHours(bhMap, time.Now()) {
			scheduleNextCampaignSend(ctx, pool, orgID, p.CampaignID, 15*60)
			return nil
		}
	}

	var recID, contactID, phone, contactName string
	var isBlocked, isAnonymized, marketingConsent bool
	err = pool.QueryRow(ctx, `
		SELECT cr.id, cr.contact_id, cr.phone_number, COALESCE(c.name, ''),
		       c.is_blocked, c.is_anonymized, COALESCE((c.consent->>'marketing')::boolean, true)
		FROM campaign_recipients cr
		JOIN contacts c ON c.id = cr.contact_id
		WHERE cr.campaign_id = $1 AND cr.organization_id = $2 AND cr.status = 'pending'
		ORDER BY cr.created_at ASC
		LIMIT 1
	`, p.CampaignID, orgID).Scan(&recID, &contactID, &phone, &contactName, &isBlocked, &isAnonymized, &marketingConsent)
	if err != nil {
		_, _ = pool.Exec(ctx, `
			UPDATE campaigns
			SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
			WHERE id = $1 AND organization_id = $2 AND status = 'running'
		`, p.CampaignID, orgID)
		if hub != nil {
			hub.Publish(orgID, "campaign.updated", map[string]any{"campaign_id": p.CampaignID, "status": "completed"})
		}
		return nil
	}

	if isBlocked || isAnonymized || !marketingConsent || strings.TrimSpace(phone) == "" {
		_, _ = pool.Exec(ctx, `UPDATE campaign_recipients SET status = 'skipped', error_message = 'opted_out', updated_at = now() WHERE id = $1`, recID)
		_, _ = pool.Exec(ctx, `UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = now() WHERE id = $1`, p.CampaignID)
		scheduleNextCampaignSend(ctx, pool, orgID, p.CampaignID, 1)
		return nil
	}

	effectiveLimit := effectiveCampaignDailyLimit(warmupLimit, dailyCap)
	if waThrottle != nil && sessionID != "" && !waThrottle.AllowOutbound(ctx, sessionID, effectiveLimit) {
		scheduleNextCampaignSend(ctx, pool, orgID, p.CampaignID, 30*60)
		return nil
	}

	msgText := renderCampaignTemplate(tmpl, contactName)
	chunks := inbox.ChunkText(msgText, 4096)

	var sendErr error
	if evoClient != nil && sessionName != "" {
		for _, chunk := range chunks {
			if err := evoClient.SendText(ctx, sessionName, phone, chunk); err != nil {
				sendErr = err
				break
			}
		}
	}

	if sendErr != nil {
		_, _ = pool.Exec(ctx, `UPDATE campaign_recipients SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, recID, sendErr.Error())
		_, _ = pool.Exec(ctx, `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = now() WHERE id = $1`, p.CampaignID)
	} else {
		_, _ = pool.Exec(ctx, `UPDATE campaign_recipients SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, recID)
		_, _ = pool.Exec(ctx, `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = now() WHERE id = $1`, p.CampaignID)
	}

	var remaining int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, p.CampaignID).Scan(&remaining)
	if remaining > 0 {
		delay := computeCampaignJitter(minDelay, maxDelay, throttlePerMin)
		scheduleNextCampaignSend(ctx, pool, orgID, p.CampaignID, delay)
	} else {
		_, _ = pool.Exec(ctx, `
			UPDATE campaigns
			SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
			WHERE id = $1 AND organization_id = $2
		`, p.CampaignID, orgID)
		if hub != nil {
			hub.Publish(orgID, "campaign.updated", map[string]any{"campaign_id": p.CampaignID, "status": "completed"})
		}
	}
	return nil
}

