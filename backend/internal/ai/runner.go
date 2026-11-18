package ai

import (
	"context"
	"fmt"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type WhatsAppSender interface {
	SendText(ctx context.Context, instanceName, phoneNumber, text string) error
}

type OutboundThrottle interface {
	AllowOutbound(ctx context.Context, sessionID string, dailyLimit int) bool
}

type Runner struct {
	Pool          *pgxpool.Pool
	Hub           *realtime.Hub
	EncryptionKey string
	Outbound      WhatsAppSender
	Throttle      OutboundThrottle
}

type activeAgent struct {
	ID             string
	Name           string
	SystemPrompt   string
	Provider       string
	Model          string
	Temperature    float64
	MaxTokens      int
	HandoffEnabled bool
}

func (r *Runner) publish(orgID, evType string, payload any) {
	if r.Hub != nil {
		r.Hub.Publish(orgID, evType, payload)
	}
}

func (r *Runner) RunAgentTurn(ctx context.Context, orgID, convID, body string) error {
	if r.Pool == nil {
		return fmt.Errorf("runner pool is nil")
	}

	// 1. Check contact/conversation state & stage requires_human
	var forceHuman, isBlocked, stageRequiresHuman bool
	var sessionID, sessionName, sessionProvider, sessionStatus, contactPhone string
	var warmupLimit int
	err := r.Pool.QueryRow(ctx, `
		SELECT c.force_human, c.is_blocked,
		       COALESCE(st.requires_human, false),
		       COALESCE(cs.id::text, ''), COALESCE(cs.session_name, ''), COALESCE(cs.provider, ''), COALESCE(cs.status, ''), COALESCE(cs.warmup_daily_limit, 100),
		       COALESCE(c.phone_number, '')
		FROM conversations conv
		JOIN contacts c ON c.id = conv.contact_id
		LEFT JOIN crm_leads l ON l.id = conv.lead_id
		LEFT JOIN crm_stages st ON st.id = l.stage_id
		LEFT JOIN channel_sessions cs ON cs.id = conv.channel_session_id
		WHERE conv.id = $1 AND conv.organization_id = $2
	`, convID, orgID).Scan(&forceHuman, &isBlocked, &stageRequiresHuman, &sessionID, &sessionName, &sessionProvider, &sessionStatus, &warmupLimit, &contactPhone)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}

	if isBlocked {
		return nil
	}

	// 2. Load active agent (tie-break by updated_at DESC, created_at DESC)
	agent := activeAgent{
		Name:           "Asistente KoraCRM",
		SystemPrompt:   "Eres un asistente comercial amable y conciso que responde en español.",
		Provider:       "openai",
		Model:          "gpt-4o-mini",
		Temperature:    0.3,
		MaxTokens:      500,
		HandoffEnabled: true,
	}
	var dbAgent activeAgent
	err = r.Pool.QueryRow(ctx, `
		SELECT id, name, system_prompt, provider, model, temperature, max_tokens, handoff_enabled
		FROM ai_agents
		WHERE organization_id = $1 AND is_active = true
		ORDER BY updated_at DESC, created_at DESC
		LIMIT 1
	`, orgID).Scan(&dbAgent.ID, &dbAgent.Name, &dbAgent.SystemPrompt, &dbAgent.Provider, &dbAgent.Model, &dbAgent.Temperature, &dbAgent.MaxTokens, &dbAgent.HandoffEnabled)
	if err == nil {
		agent = dbAgent
	}

	// 3. Evaluate fast handoff triggers
	handoffReason := ""
	if forceHuman {
		handoffReason = "contact_force_human"
	} else if stageRequiresHuman {
		handoffReason = "stage_requires_human"
	} else if agent.HandoffEnabled {
		lower := strings.ToLower(body)
		if strings.Contains(lower, "humano") || strings.Contains(lower, "asesor") || strings.Contains(lower, "atendente") || strings.Contains(lower, "agent") || strings.Contains(lower, "persona") {
			handoffReason = "explicit_human_request"
		} else if strings.Contains(lower, "procon") || strings.Contains(lower, "demanda") || strings.Contains(lower, "lawsuit") || strings.Contains(lower, "reembolso") || strings.Contains(lower, "refund") {
			handoffReason = "guardrail_critical_topic"
		}
	}

	if handoffReason != "" {
		r.triggerHandoff(ctx, orgID, convID, agent.ID, "internal", "guardrail-v1", body, handoffReason, "handoff", "")
		return nil
	}

	// 4. Atomic monthly budget reset & 1-cent reservation (eliminates TOCTOU race)
	_, _ = r.Pool.Exec(ctx, `INSERT INTO ai_budgets (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, orgID)
	_, _ = r.Pool.Exec(ctx, `
		UPDATE ai_budgets
		SET spent_cents = 0, alert_80_sent = false, period_start = date_trunc('month', now()), updated_at = now()
		WHERE organization_id = $1 AND period_start < date_trunc('month', now())
	`, orgID)

	var limitCents, newSpent int64
	var warnPct int
	var hardStop bool
	err = r.Pool.QueryRow(ctx, `
		UPDATE ai_budgets
		SET spent_cents = spent_cents + 1, updated_at = now()
		WHERE organization_id = $1 AND (NOT hard_stop OR spent_cents < monthly_limit_cents)
		RETURNING monthly_limit_cents, spent_cents, warn_at_percent, hard_stop
	`, orgID).Scan(&limitCents, &newSpent, &warnPct, &hardStop)
	if err == pgx.ErrNoRows {
		r.triggerHandoff(ctx, orgID, convID, agent.ID, agent.Provider, agent.Model, body, "budget_exceeded", "blocked_budget", "monthly budget cap reached")
		return nil
	} else if err != nil {
		return err
	}

	// 5. Gather RAG, org memory, active products, and recent conversation history
	hits, _ := SearchRAG(ctx, r.Pool, orgID, body, 3)
	memories := r.loadOrgMemories(ctx, orgID, 5)
	products := r.loadCatalogSummary(ctx, orgID, 8)
	history := r.loadRecentHistory(ctx, orgID, convID, 6)

	// 6. Resolve active tenant LLM credential
	var credProvider, baseURL, defaultModel, encKey string
	err = r.Pool.QueryRow(ctx, `
		SELECT provider, base_url, default_model, api_key_encrypted
		FROM ai_provider_credentials
		WHERE organization_id = $1 AND is_active = true
		ORDER BY (provider = $2) DESC, updated_at DESC
		LIMIT 1
	`, orgID, agent.Provider).Scan(&credProvider, &baseURL, &defaultModel, &encKey)

	var res LLMResponse
	if err == nil && encKey != "" {
		apiKey, decErr := DecryptAPIKey(r.EncryptionKey, encKey)
		if decErr != nil {
			r.refundReservation(ctx, orgID)
			r.triggerHandoff(ctx, orgID, convID, agent.ID, credProvider, agent.Model, body, "provider_error", "failed", "credential decrypt error")
			return nil
		}
		model := agent.Model
		if defaultModel != "" && credProvider != agent.Provider {
			model = defaultModel
		}
		sysPrompt := buildSystemPrompt(agent.SystemPrompt, hits, memories, products)
		msgs := append(history, ChatMessage{Role: "user", Content: body})
		res, err = CallLLM(ctx, LLMRequest{
			Provider:     credProvider,
			BaseURL:      baseURL,
			APIKey:       apiKey,
			Model:        model,
			SystemPrompt: sysPrompt,
			Messages:     msgs,
			Temperature:  agent.Temperature,
			MaxTokens:    agent.MaxTokens,
		})
		if err != nil {
			r.refundReservation(ctx, orgID)
			r.triggerHandoff(ctx, orgID, convID, agent.ID, credProvider, model, body, "provider_error", "failed", err.Error())
			return nil
		}
	} else {
		// Deterministic local fallback when no external API key is configured
		reply := DeterministicLocalReply(hits, memories, products)
		res = LLMResponse{
			Content:          reply,
			PromptTokens:     40,
			CompletionTokens: max(len(strings.Fields(reply))*2, 10),
			CostCents:        0,
			LatencyMs:        2,
			Provider:         "internal",
			Model:            "rag-local-v1",
		}
	}

	// 7. Reconcile reserved cent with actual cost & update alert_80_sent
	delta := res.CostCents - 1
	if delta != 0 {
		_ = r.Pool.QueryRow(ctx, `
			UPDATE ai_budgets
			SET spent_cents = GREATEST(spent_cents + $2, 0),
			    alert_80_sent = alert_80_sent OR ((GREATEST(spent_cents + $2, 0) * 100) >= (monthly_limit_cents * GREATEST(warn_at_percent, 1))),
			    updated_at = now()
			WHERE organization_id = $1
			RETURNING spent_cents
		`, orgID, delta).Scan(&newSpent)
	} else if limitCents > 0 && (newSpent*100) >= (limitCents*int64(max(warnPct, 1))) {
		_, _ = r.Pool.Exec(ctx, `UPDATE ai_budgets SET alert_80_sent = true, updated_at = now() WHERE organization_id = $1`, orgID)
	}

	// 8. Record ai_agent_runs + ai_invocations
	var runID string
	var agentArg any
	if agent.ID != "" {
		agentArg = agent.ID
	}
	_ = r.Pool.QueryRow(ctx, `
		INSERT INTO ai_agent_runs (
			organization_id, agent_id, conversation_id, status, provider, model,
			input_preview, output_preview, prompt_tokens, completion_tokens, cost_cents, latency_ms
		) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id
	`, orgID, agentArg, convID, res.Provider, res.Model, truncatePreview(body, 200), truncatePreview(res.Content, 200), res.PromptTokens, res.CompletionTokens, res.CostCents, res.LatencyMs).Scan(&runID)

	var runArg any
	if runID != "" {
		runArg = runID
	}
	_, _ = r.Pool.Exec(ctx, `
		INSERT INTO ai_invocations (
			organization_id, agent_id, conversation_id, run_id, purpose, provider, model,
			prompt_tokens, completion_tokens, cost_cents, latency_ms, status
		) VALUES ($1,$2,$3,$4,'chat',$5,$6,$7,$8,$9,$10,'completed')
	`, orgID, agentArg, convID, runArg, res.Provider, res.Model, res.PromptTokens, res.CompletionTokens, res.CostCents, res.LatencyMs)

	// 9. Persist outbound message (chunked at 4096 chars) & send via Evolution Go if WORKING
	chunks := chunkReply(res.Content, 4096)
	var msgID string
	for _, ch := range chunks {
		_ = r.Pool.QueryRow(ctx, `
			INSERT INTO messages (organization_id, conversation_id, direction, sender_type, content_type, body, status)
			VALUES ($1,$2,'outbound','ai','text',$3,'sent') RETURNING id
		`, orgID, convID, ch).Scan(&msgID)
	}
	_, _ = r.Pool.Exec(ctx, `UPDATE conversations SET last_message_at=now(), last_message_preview=$1, updated_at=now() WHERE id=$2`, truncatePreview(res.Content, 120), convID)
	r.publish(orgID, "message.created", map[string]any{
		"id": msgID, "conversation_id": convID, "direction": "outbound", "sender_type": "ai", "body": res.Content,
	})

	if r.Outbound != nil && sessionProvider == "evolution_go" && sessionStatus == "WORKING" && sessionName != "" && contactPhone != "" {
		allowed := true
		if r.Throttle != nil {
			allowed = r.Throttle.AllowOutbound(ctx, sessionID, warmupLimit)
		}
		if allowed {
			for _, ch := range chunks {
				_ = r.Outbound.SendText(ctx, sessionName, contactPhone, ch)
			}
		}
	}

	return nil
}

func (r *Runner) refundReservation(ctx context.Context, orgID string) {
	_, _ = r.Pool.Exec(ctx, `
		UPDATE ai_budgets SET spent_cents = GREATEST(spent_cents - 1, 0), updated_at = now()
		WHERE organization_id = $1
	`, orgID)
}

func (r *Runner) triggerHandoff(ctx context.Context, orgID, convID, agentID, provider, model, body, reason, runStatus, errMsg string) {
	_, _ = r.Pool.Exec(ctx, `
		UPDATE conversations SET status='pending', service_revision=service_revision+1, updated_at=now()
		WHERE id=$1 AND organization_id=$2
	`, convID, orgID)

	var agentArg any
	if agentID != "" {
		agentArg = agentID
	}
	var errArg any
	if errMsg != "" {
		errArg = errMsg
	}

	var runID string
	_ = r.Pool.QueryRow(ctx, `
		INSERT INTO ai_agent_runs (
			organization_id, agent_id, conversation_id, status, provider, model,
			input_preview, handoff_reason, error_message
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id
	`, orgID, agentArg, convID, runStatus, provider, model, truncatePreview(body, 200), reason, errArg).Scan(&runID)

	var runArg any
	if runID != "" {
		runArg = runID
	}
	_, _ = r.Pool.Exec(ctx, `
		INSERT INTO ai_invocations (
			organization_id, agent_id, conversation_id, run_id, purpose, provider, model,
			handoff_triggered, handoff_reason, status, error_message
		) VALUES ($1,$2,$3,$4,'handoff',$5,$6,true,$7,$8,$9)
	`, orgID, agentArg, convID, runArg, provider, model, reason, runStatus, errArg)

	r.publish(orgID, "conversation.handoff", map[string]any{"conversation_id": convID, "reason": reason})
}

func (r *Runner) loadOrgMemories(ctx context.Context, orgID string, limit int) []string {
	rows, err := r.Pool.Query(ctx, `
		SELECT category, content FROM org_memory_entries
		WHERE organization_id = $1 AND is_active = true
		ORDER BY created_at DESC LIMIT $2
	`, orgID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var cat, content string
		if rows.Scan(&cat, &content) == nil {
			out = append(out, fmt.Sprintf("[%s] %s", cat, content))
		}
	}
	return out
}

func (r *Runner) loadCatalogSummary(ctx context.Context, orgID string, limit int) []string {
	rows, err := r.Pool.Query(ctx, `
		SELECT name, price_cents, currency FROM catalog_products
		WHERE organization_id = $1 AND is_active = true
		ORDER BY created_at DESC LIMIT $2
	`, orgID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name, curr string
		var cents int64
		if rows.Scan(&name, &cents, &curr) == nil {
			out = append(out, fmt.Sprintf("%s (%.2f %s)", name, float64(cents)/100.0, curr))
		}
	}
	return out
}

func (r *Runner) loadRecentHistory(ctx context.Context, orgID, convID string, limit int) []ChatMessage {
	rows, err := r.Pool.Query(ctx, `
		SELECT direction, body FROM messages
		WHERE organization_id = $1 AND conversation_id = $2 AND content_type = 'text'
		ORDER BY sent_at DESC LIMIT $3
	`, orgID, convID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var rev []ChatMessage
	for rows.Next() {
		var dir, body string
		if rows.Scan(&dir, &body) == nil {
			role := "user"
			if dir == "outbound" {
				role = "assistant"
			}
			rev = append(rev, ChatMessage{Role: role, Content: body})
		}
	}
	// Reverse to chronological order
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

func buildSystemPrompt(base string, hits []RAGHit, memories, products []string) string {
	var b strings.Builder
	b.WriteString(base)
	if len(hits) > 0 {
		b.WriteString("\n\nConocimiento relevante (RAG):\n")
		for _, h := range hits {
			b.WriteString("- " + h.Content + "\n")
		}
	}
	if len(memories) > 0 {
		b.WriteString("\nMemoria de la organización:\n")
		for _, m := range memories {
			b.WriteString("- " + m + "\n")
		}
	}
	if len(products) > 0 {
		b.WriteString("\nCatálogo de productos:\n")
		for _, p := range products {
			b.WriteString("- " + p + "\n")
		}
	}
	return b.String()
}

func truncatePreview(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func chunkReply(s string, limit int) []string {
	if len(s) <= limit {
		return []string{s}
	}
	var out []string
	for len(s) > limit {
		out = append(out, s[:limit])
		s = s[limit:]
	}
	if s != "" {
		out = append(out, s)
	}
	return out
}
