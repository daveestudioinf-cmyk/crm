package ai

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"math"
	"net/http"
	"sort"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	Pool          *pgxpool.Pool
	Hub           *realtime.Hub
	EncryptionKey string
}

func (h *Handler) ListAgents(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, system_prompt, provider, model, temperature, max_tokens, handoff_enabled, guardrails, is_active, version, updated_at
		FROM ai_agents WHERE organization_id=$1 ORDER BY updated_at DESC, created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var aid, name, prompt, prov, model string
		var temp float64
		var maxTok, ver int
		var handoff, active bool
		var guardrails map[string]any
		var updatedAt any
		_ = rows.Scan(&aid, &name, &prompt, &prov, &model, &temp, &maxTok, &handoff, &guardrails, &active, &ver, &updatedAt)
		out = append(out, map[string]any{
			"id": aid, "name": name, "system_prompt": prompt, "provider": prov,
			"model": model, "temperature": temp, "max_tokens": maxTok, "handoff_enabled": handoff,
			"guardrails": guardrails, "is_active": active, "version": ver, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name           string          `json:"name"`
		SystemPrompt   string          `json:"system_prompt"`
		Provider       string          `json:"provider"`
		Model          string          `json:"model"`
		Temperature    *float64        `json:"temperature"`
		MaxTokens      *int            `json:"max_tokens"`
		HandoffEnabled *bool           `json:"handoff_enabled"`
		Guardrails     json.RawMessage `json:"guardrails"`
		IsActive       *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Provider == "" {
		req.Provider = "openai"
	}
	if req.Model == "" {
		req.Model = "gpt-4o-mini"
	}
	temp := 0.3
	if req.Temperature != nil {
		temp = max(0, min(2.0, *req.Temperature))
	}
	maxTok := 500
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		maxTok = min(*req.MaxTokens, 8192)
	}
	handoff := true
	if req.HandoffEnabled != nil {
		handoff = *req.HandoffEnabled
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	guardrailsJSON := `{"blocked_topics": ["refund_promise", "legal_advice"], "handoff_on_uncertainty": true}`
	if len(req.Guardrails) > 0 && string(req.Guardrails) != "null" {
		guardrailsJSON = string(req.Guardrails)
	}

	var aid string
	var guardrailsOut map[string]any
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO ai_agents (organization_id, name, system_prompt, provider, model, temperature, max_tokens, handoff_enabled, guardrails, is_active)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id, guardrails
	`, id.OrganizationID, strings.TrimSpace(req.Name), req.SystemPrompt, req.Provider, req.Model, temp, maxTok, handoff, guardrailsJSON, active).Scan(&aid, &guardrailsOut)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_agent.create", "ai_agent", aid, map[string]any{"name": strings.TrimSpace(req.Name)})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": aid, "name": strings.TrimSpace(req.Name), "system_prompt": req.SystemPrompt,
		"provider": req.Provider, "model": req.Model, "temperature": temp, "max_tokens": maxTok,
		"handoff_enabled": handoff, "guardrails": guardrailsOut, "is_active": active, "version": 1,
	})
}

func (h *Handler) UpdateAgent(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	aid := chi.URLParam(r, "id")
	var req struct {
		Name           *string         `json:"name"`
		SystemPrompt   *string         `json:"system_prompt"`
		Provider       *string         `json:"provider"`
		Model          *string         `json:"model"`
		Temperature    *float64        `json:"temperature"`
		MaxTokens      *int            `json:"max_tokens"`
		HandoffEnabled *bool           `json:"handoff_enabled"`
		Guardrails     json.RawMessage `json:"guardrails"`
		IsActive       *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Temperature != nil {
		v := max(0, min(2.0, *req.Temperature))
		req.Temperature = &v
	}
	if req.MaxTokens != nil {
		v := max(50, min(8192, *req.MaxTokens))
		req.MaxTokens = &v
	}
	var guardrailsPtr *string
	if len(req.Guardrails) > 0 && string(req.Guardrails) != "null" {
		s := string(req.Guardrails)
		guardrailsPtr = &s
	}

	var name, prompt, prov, model string
	var temp float64
	var maxTok, ver int
	var handoff, active bool
	var guardrailsOut map[string]any
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE ai_agents
		SET name = COALESCE(NULLIF($3, ''), name),
		    system_prompt = COALESCE($4, system_prompt),
		    provider = COALESCE(NULLIF($5, ''), provider),
		    model = COALESCE(NULLIF($6, ''), model),
		    temperature = COALESCE($7, temperature),
		    max_tokens = COALESCE($8, max_tokens),
		    handoff_enabled = COALESCE($9, handoff_enabled),
		    is_active = COALESCE($10, is_active),
		    guardrails = COALESCE($11::jsonb, guardrails),
		    version = version + 1,
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING name, system_prompt, provider, model, temperature, max_tokens, handoff_enabled, guardrails, is_active, version
	`, aid, id.OrganizationID, req.Name, req.SystemPrompt, req.Provider, req.Model, req.Temperature, req.MaxTokens, req.HandoffEnabled, req.IsActive, guardrailsPtr).
		Scan(&name, &prompt, &prov, &model, &temp, &maxTok, &handoff, &guardrailsOut, &active, &ver)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "agent not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_agent.update", "ai_agent", aid, map[string]any{"version": ver})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": aid, "name": name, "system_prompt": prompt, "provider": prov, "model": model,
		"temperature": temp, "max_tokens": maxTok, "handoff_enabled": handoff,
		"guardrails": guardrailsOut, "is_active": active, "version": ver,
	})
}

func (h *Handler) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	aid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `DELETE FROM ai_agents WHERE id=$1 AND organization_id=$2`, aid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "agent not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_agent.delete", "ai_agent", aid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) ListProviders(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, provider, label, base_url, default_model, api_key_mask, is_active, created_at, updated_at
		FROM ai_provider_credentials
		WHERE organization_id = $1
		ORDER BY updated_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pid, prov, label, baseURL, defModel, mask string
		var active bool
		var createdAt, updatedAt any
		_ = rows.Scan(&pid, &prov, &label, &baseURL, &defModel, &mask, &active, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id": pid, "provider": prov, "label": label, "base_url": baseURL,
			"default_model": defModel, "api_key_mask": mask, "is_active": active,
			"created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) UpsertProvider(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Provider     string `json:"provider"`
		Label        string `json:"label"`
		BaseURL      string `json:"base_url"`
		DefaultModel string `json:"default_model"`
		APIKey       string `json:"api_key"`
		IsActive     *bool  `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	req.Provider = strings.TrimSpace(strings.ToLower(req.Provider))
	switch req.Provider {
	case "openai", "anthropic", "gemini", "openrouter", "openai_compatible":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid provider")
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var existingEnc, existingMask string
	errExisting := h.Pool.QueryRow(r.Context(), `
		SELECT api_key_encrypted, api_key_mask FROM ai_provider_credentials
		WHERE organization_id = $1 AND provider = $2
	`, id.OrganizationID, req.Provider).Scan(&existingEnc, &existingMask)

	encKey := existingEnc
	mask := existingMask
	if strings.TrimSpace(req.APIKey) != "" {
		var encErr error
		encKey, encErr = EncryptAPIKey(h.EncryptionKey, strings.TrimSpace(req.APIKey))
		if encErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "encryption error")
			return
		}
		mask = MaskAPIKey(req.APIKey)
	} else if errExisting != nil {
		httpx.Error(w, http.StatusBadRequest, "api_key required")
		return
	}

	var pid string
	var createdAt, updatedAt any
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO ai_provider_credentials (
			organization_id, provider, label, base_url, default_model, api_key_encrypted, api_key_mask, is_active
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (organization_id, provider) DO UPDATE SET
			label = EXCLUDED.label,
			base_url = EXCLUDED.base_url,
			default_model = EXCLUDED.default_model,
			api_key_encrypted = EXCLUDED.api_key_encrypted,
			api_key_mask = EXCLUDED.api_key_mask,
			is_active = EXCLUDED.is_active,
			updated_at = now()
		RETURNING id, created_at, updated_at
	`, id.OrganizationID, req.Provider, strings.TrimSpace(req.Label), strings.TrimSpace(req.BaseURL), strings.TrimSpace(req.DefaultModel), encKey, mask, active).
		Scan(&pid, &createdAt, &updatedAt)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": pid, "provider": req.Provider, "label": strings.TrimSpace(req.Label),
		"base_url": strings.TrimSpace(req.BaseURL), "default_model": strings.TrimSpace(req.DefaultModel),
		"api_key_mask": mask, "is_active": active, "created_at": createdAt, "updated_at": updatedAt,
	})
}

func (h *Handler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `DELETE FROM ai_provider_credentials WHERE id=$1 AND organization_id=$2`, pid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "provider not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) GetBudget(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var limitCents, spentCents int64 = 5000, 0
	var warnPct int = 80
	var hardStop bool = true
	var alert80 bool = false

	err := h.Pool.QueryRow(r.Context(), `
		SELECT monthly_limit_cents, spent_cents, warn_at_percent, hard_stop, alert_80_sent
		FROM ai_budgets WHERE organization_id=$1
	`, id.OrganizationID).Scan(&limitCents, &spentCents, &warnPct, &hardStop, &alert80)
	if err != nil && err != pgx.ErrNoRows {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	pct := float64(spentCents) / float64(max(limitCents, 1)) * 100
	httpx.JSON(w, http.StatusOK, map[string]any{
		"monthly_limit_cents": limitCents,
		"monthly_cap_cents":   limitCents,
		"spent_cents":         spentCents,
		"warn_at_percent":     warnPct,
		"hard_stop":           hardStop,
		"alert_80_sent":       alert80,
		"pct":                 pct,
	})
}

func (h *Handler) UpdateBudget(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		MonthlyLimitCents *int64 `json:"monthly_limit_cents"`
		WarnAtPercent     *int   `json:"warn_at_percent"`
		HardStop          *bool  `json:"hard_stop"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	limitCents := int64(5000)
	if req.MonthlyLimitCents != nil {
		if *req.MonthlyLimitCents < 0 {
			httpx.Error(w, http.StatusBadRequest, "monthly_limit_cents must be >= 0")
			return
		}
		limitCents = *req.MonthlyLimitCents
	}
	warnPct := 80
	if req.WarnAtPercent != nil {
		warnPct = max(1, min(100, *req.WarnAtPercent))
	}
	hardStop := true
	if req.HardStop != nil {
		hardStop = *req.HardStop
	}

	capInt32 := min(limitCents, 2147483647)
	var spentCents int64
	var alert80 bool
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO ai_budgets (organization_id, monthly_cap_cents, monthly_limit_cents, warn_at_percent, hard_stop)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (organization_id) DO UPDATE SET
			monthly_cap_cents = EXCLUDED.monthly_cap_cents,
			monthly_limit_cents = EXCLUDED.monthly_limit_cents,
			warn_at_percent = EXCLUDED.warn_at_percent,
			hard_stop = EXCLUDED.hard_stop,
			alert_80_sent = (ai_budgets.spent_cents * 100) >= (EXCLUDED.monthly_limit_cents * GREATEST(EXCLUDED.warn_at_percent, 1)),
			updated_at = now()
		RETURNING spent_cents, alert_80_sent
	`, id.OrganizationID, capInt32, limitCents, warnPct, hardStop).Scan(&spentCents, &alert80)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	pct := float64(spentCents) / float64(max(limitCents, 1)) * 100
	httpx.JSON(w, http.StatusOK, map[string]any{
		"monthly_limit_cents": limitCents,
		"monthly_cap_cents":   limitCents,
		"spent_cents":         spentCents,
		"warn_at_percent":     warnPct,
		"hard_stop":           hardStop,
		"alert_80_sent":       alert80,
		"pct":                 pct,
	})
}

func (h *Handler) ListRuns(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, agent_id, conversation_id, status, provider, model, input_preview, output_preview,
		       COALESCE(handoff_reason,''), COALESCE(error_message,''), prompt_tokens, completion_tokens,
		       cost_cents, latency_ms, created_at
		FROM ai_agent_runs
		WHERE organization_id = $1
		ORDER BY created_at DESC
		LIMIT 50
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, status, prov, model, inPrev, outPrev, handoffReason, errMsg string
		var agentID, convID *string
		var pTok, cTok, cost, lat int
		var createdAt any
		_ = rows.Scan(&rid, &agentID, &convID, &status, &prov, &model, &inPrev, &outPrev, &handoffReason, &errMsg, &pTok, &cTok, &cost, &lat, &createdAt)
		out = append(out, map[string]any{
			"id": rid, "agent_id": agentID, "conversation_id": convID, "status": status,
			"provider": prov, "model": model, "input_preview": inPrev, "output_preview": outPrev,
			"handoff_reason": handoffReason, "error_message": errMsg,
			"prompt_tokens": pTok, "completion_tokens": cTok, "cost_cents": cost,
			"latency_ms": lat, "created_at": createdAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) ListMemory(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, category, content, is_active, created_at
		FROM org_memory_entries WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var mid, cat, content string
		var active bool
		var createdAt any
		_ = rows.Scan(&mid, &cat, &content, &active, &createdAt)
		out = append(out, map[string]any{"id": mid, "category": cat, "content": content, "is_active": active, "created_at": createdAt})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateMemory(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Category string `json:"category"`
		Content  string `json:"content"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Content) == "" {
		httpx.Error(w, http.StatusBadRequest, "content required")
		return
	}
	if strings.TrimSpace(req.Category) == "" {
		req.Category = "general"
	}
	var mid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO org_memory_entries (organization_id, category, content)
		VALUES ($1,$2,$3) RETURNING id
	`, id.OrganizationID, strings.TrimSpace(req.Category), strings.TrimSpace(req.Content)).Scan(&mid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": mid, "category": strings.TrimSpace(req.Category), "content": strings.TrimSpace(req.Content)})
}

func (h *Handler) DeleteMemory(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	mid := chi.URLParam(r, "id")
	_, _ = h.Pool.Exec(r.Context(), `DELETE FROM org_memory_entries WHERE id=$1 AND organization_id=$2`, mid, id.OrganizationID)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) ListKnowledge(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, title, source_type, raw_content, status, created_at
		FROM ai_knowledge_sources WHERE organization_id=$1 ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var kid, title, stype, content, status string
		var created any
		_ = rows.Scan(&kid, &title, &stype, &content, &status, &created)
		out = append(out, map[string]any{"id": kid, "title": title, "source_type": stype, "raw_content": content, "status": status, "created_at": created})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateKnowledge(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Title      string `json:"title"`
		SourceType string `json:"source_type"`
		Content    string `json:"content"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Title == "" || req.Content == "" {
		httpx.Error(w, http.StatusBadRequest, "title and content required")
		return
	}
	if req.SourceType == "" {
		req.SourceType = "faq"
	}
	var kid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO ai_knowledge_sources (organization_id, title, source_type, raw_content, status)
		VALUES ($1,$2,$3,$4,'ready') RETURNING id
	`, id.OrganizationID, req.Title, req.SourceType, req.Content).Scan(&kid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	chunks := splitParagraphs(req.Content, 500)
	for _, ch := range chunks {
		vec := EmbedText(ch)
		b, _ := json.Marshal(vec)
		_, _ = h.Pool.Exec(r.Context(), `
			INSERT INTO ai_chunks (organization_id, source_id, content, embedding_json) VALUES ($1,$2,$3,$4)
		`, id.OrganizationID, kid, ch, string(b))
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{"id": kid, "chunks_indexed": len(chunks)})
}

func (h *Handler) SearchKnowledge(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Query string `json:"query"`
		TopK  int    `json:"top_k"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Query == "" {
		httpx.Error(w, http.StatusBadRequest, "query required")
		return
	}
	if req.TopK <= 0 {
		req.TopK = 3
	}
	results, err := SearchRAG(r.Context(), h.Pool, id.OrganizationID, req.Query, req.TopK)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "search error")
		return
	}
	httpx.JSON(w, http.StatusOK, results)
}

func (h *Handler) GetUsage(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var limitCents, spentCents int64 = 5000, 0
	var warnPct int = 80
	var hardStop bool = true
	var alert80 bool = false

	err := h.Pool.QueryRow(r.Context(), `
		SELECT monthly_limit_cents, spent_cents, warn_at_percent, hard_stop, alert_80_sent
		FROM ai_budgets WHERE organization_id=$1
	`, id.OrganizationID).Scan(&limitCents, &spentCents, &warnPct, &hardStop, &alert80)
	if err != nil && err != pgx.ErrNoRows {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	var calls int
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM ai_invocations
		WHERE organization_id=$1 AND created_at >= date_trunc('month', now())
	`, id.OrganizationID).Scan(&calls)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"monthly_limit_cents": limitCents,
		"monthly_cap_cents":   limitCents,
		"spent_cents":         spentCents,
		"warn_at_percent":     warnPct,
		"hard_stop":           hardStop,
		"alert_80_sent":       alert80,
		"calls":               calls,
		"pct":                 float64(spentCents) / float64(max(limitCents, 1)) * 100,
	})
}

func (h *Handler) DeleteKnowledge(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	kid := chi.URLParam(r, "id")
	_, _ = h.Pool.Exec(r.Context(), `DELETE FROM ai_knowledge_sources WHERE id=$1 AND organization_id=$2`, kid, id.OrganizationID)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) UpdateKnowledge(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	kid := chi.URLParam(r, "id")
	var req struct {
		Title      *string `json:"title"`
		SourceType *string `json:"source_type"`
		Content    *string `json:"content"`
		RawContent *string `json:"raw_content"`
		Status     *string `json:"status"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	contentPtr := req.Content
	if contentPtr == nil {
		contentPtr = req.RawContent
	}

	var title, stype, rawContent, status string
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE ai_knowledge_sources
		SET title = COALESCE(NULLIF($3, ''), title),
		    source_type = COALESCE(NULLIF($4, ''), source_type),
		    raw_content = COALESCE($5, raw_content),
		    status = COALESCE(NULLIF($6, ''), status),
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING title, source_type, raw_content, status
	`, kid, id.OrganizationID, req.Title, req.SourceType, contentPtr, req.Status).
		Scan(&title, &stype, &rawContent, &status)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "knowledge source not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	chunksIndexed := 0
	if contentPtr != nil {
		_, _ = h.Pool.Exec(r.Context(), `DELETE FROM ai_chunks WHERE source_id=$1 AND organization_id=$2`, kid, id.OrganizationID)
		chunks := splitParagraphs(rawContent, 500)
		for _, ch := range chunks {
			vec := EmbedText(ch)
			b, _ := json.Marshal(vec)
			_, _ = h.Pool.Exec(r.Context(), `
				INSERT INTO ai_chunks (organization_id, source_id, content, embedding_json) VALUES ($1,$2,$3,$4)
			`, id.OrganizationID, kid, ch, string(b))
		}
		chunksIndexed = len(chunks)
	}

	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_knowledge.update", "ai_knowledge_source", kid, map[string]any{"chunks_indexed": chunksIndexed})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":             kid,
		"title":          title,
		"source_type":    stype,
		"raw_content":    rawContent,
		"status":         status,
		"chunks_indexed": chunksIndexed,
	})
}

func (h *Handler) UpdateMemory(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	mid := chi.URLParam(r, "id")
	var req struct {
		Category *string `json:"category"`
		Content  *string `json:"content"`
		IsActive *bool   `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var cat, content string
	var active bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE org_memory_entries
		SET category = COALESCE(NULLIF($3, ''), category),
		    content = COALESCE(NULLIF($4, ''), content),
		    is_active = COALESCE($5, is_active)
		WHERE id = $1 AND organization_id = $2
		RETURNING category, content, is_active
	`, mid, id.OrganizationID, req.Category, req.Content, req.IsActive).Scan(&cat, &content, &active)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "memory entry not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_memory.update", "org_memory_entry", mid, map[string]any{"is_active": active})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": mid, "category": cat, "content": content, "is_active": active,
	})
}

// --- S18: Follow-up Flows ---

func (h *Handler) ListFollowups(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, trigger_type, delay_minutes, max_attempts, prompt_template,
		       COALESCE(channel_session_id::text,''), steps, is_active, created_at, updated_at
		FROM followup_flows WHERE organization_id=$1 ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var fid, name, trig, prompt, chanID string
		var delayMin, maxAtt int
		var steps any
		var active bool
		var createdAt, updatedAt any
		_ = rows.Scan(&fid, &name, &trig, &delayMin, &maxAtt, &prompt, &chanID, &steps, &active, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id": fid, "name": name, "trigger_type": trig, "delay_minutes": delayMin,
			"max_attempts": maxAtt, "prompt_template": prompt, "channel_session_id": chanID,
			"steps": steps, "is_active": active, "created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateFollowup(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name             string          `json:"name"`
		TriggerType      string          `json:"trigger_type"`
		DelayMinutes     *int            `json:"delay_minutes"`
		MaxAttempts      *int            `json:"max_attempts"`
		PromptTemplate   string          `json:"prompt_template"`
		ChannelSessionID *string         `json:"channel_session_id"`
		Steps            json.RawMessage `json:"steps"`
		IsActive         *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	trig := strings.TrimSpace(req.TriggerType)
	if trig == "" {
		trig = "manual"
	}
	delayMin := 60
	if req.DelayMinutes != nil && *req.DelayMinutes >= 0 {
		delayMin = *req.DelayMinutes
	}
	maxAtt := 3
	if req.MaxAttempts != nil && *req.MaxAttempts > 0 {
		maxAtt = *req.MaxAttempts
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	stepsJSON := "[]"
	if len(req.Steps) > 0 && string(req.Steps) != "null" {
		stepsJSON = string(req.Steps)
	}
	var chanID string
	if req.ChannelSessionID != nil {
		chanID = strings.TrimSpace(*req.ChannelSessionID)
	}

	var fid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO followup_flows (organization_id, name, trigger_type, delay_minutes, max_attempts, prompt_template, channel_session_id, steps, is_active)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::uuid,$8::jsonb,$9) RETURNING id
	`, id.OrganizationID, strings.TrimSpace(req.Name), trig, delayMin, maxAtt, req.PromptTemplate, chanID, stepsJSON, active).Scan(&fid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "followup_flow.create", "followup_flow", fid, map[string]any{"name": strings.TrimSpace(req.Name)})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": fid, "name": strings.TrimSpace(req.Name), "trigger_type": trig, "delay_minutes": delayMin,
		"max_attempts": maxAtt, "prompt_template": req.PromptTemplate, "channel_session_id": chanID,
		"steps": json.RawMessage(stepsJSON), "is_active": active,
	})
}

func (h *Handler) UpdateFollowup(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	fid := chi.URLParam(r, "id")
	var req struct {
		Name             *string         `json:"name"`
		TriggerType      *string         `json:"trigger_type"`
		DelayMinutes     *int            `json:"delay_minutes"`
		MaxAttempts      *int            `json:"max_attempts"`
		PromptTemplate   *string         `json:"prompt_template"`
		ChannelSessionID *string         `json:"channel_session_id"`
		Steps            json.RawMessage `json:"steps"`
		IsActive         *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var stepsPtr *string
	if len(req.Steps) > 0 && string(req.Steps) != "null" {
		s := string(req.Steps)
		stepsPtr = &s
	}

	var name, trig, prompt, chanID string
	var delayMin, maxAtt int
	var stepsOut any
	var active bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE followup_flows
		SET name = COALESCE(NULLIF($3, ''), name),
		    trigger_type = COALESCE(NULLIF($4, ''), trigger_type),
		    delay_minutes = COALESCE($5, delay_minutes),
		    max_attempts = COALESCE($6, max_attempts),
		    prompt_template = COALESCE($7, prompt_template),
		    channel_session_id = CASE WHEN $8::text IS NULL THEN channel_session_id ELSE NULLIF($8, '')::uuid END,
		    steps = COALESCE($9::jsonb, steps),
		    is_active = COALESCE($10, is_active),
		    updated_at = now()
		WHERE id=$1 AND organization_id=$2
		RETURNING name, trigger_type, delay_minutes, max_attempts, prompt_template, COALESCE(channel_session_id::text,''), steps, is_active
	`, fid, id.OrganizationID, req.Name, req.TriggerType, req.DelayMinutes, req.MaxAttempts, req.PromptTemplate, req.ChannelSessionID, stepsPtr, req.IsActive).
		Scan(&name, &trig, &delayMin, &maxAtt, &prompt, &chanID, &stepsOut, &active)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "followup flow not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "followup_flow.update", "followup_flow", fid, map[string]any{"is_active": active})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": fid, "name": name, "trigger_type": trig, "delay_minutes": delayMin,
		"max_attempts": maxAtt, "prompt_template": prompt, "channel_session_id": chanID,
		"steps": stepsOut, "is_active": active,
	})
}

func (h *Handler) DeleteFollowup(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	fid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `DELETE FROM followup_flows WHERE id=$1 AND organization_id=$2`, fid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "followup flow not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "followup_flow.delete", "followup_flow", fid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- S18: AI Intent Routers ---

func (h *Handler) ListRouters(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, description, intent_keywords, rules, COALESCE(target_agent_id::text,''), priority, is_active, created_at, updated_at
		FROM ai_intent_routers WHERE organization_id=$1 ORDER BY priority ASC, created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var rid, name, desc, targetAgentID string
		var keywords []string
		var rules any
		var prio int
		var active bool
		var createdAt, updatedAt any
		_ = rows.Scan(&rid, &name, &desc, &keywords, &rules, &targetAgentID, &prio, &active, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id": rid, "name": name, "description": desc, "intent_keywords": keywords,
			"rules": rules, "target_agent_id": targetAgentID, "priority": prio,
			"is_active": active, "created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateRouter(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name           string          `json:"name"`
		Description    string          `json:"description"`
		IntentKeywords []string        `json:"intent_keywords"`
		Rules          json.RawMessage `json:"rules"`
		TargetAgentID  *string         `json:"target_agent_id"`
		Priority       *int            `json:"priority"`
		IsActive       *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	if req.IntentKeywords == nil {
		req.IntentKeywords = []string{}
	}
	rulesJSON := "[]"
	if len(req.Rules) > 0 && string(req.Rules) != "null" {
		rulesJSON = string(req.Rules)
	}
	prio := 100
	if req.Priority != nil {
		prio = *req.Priority
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	var targetAgent string
	if req.TargetAgentID != nil {
		targetAgent = strings.TrimSpace(*req.TargetAgentID)
	}

	var rid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO ai_intent_routers (organization_id, name, description, intent_keywords, rules, target_agent_id, priority, is_active)
		VALUES ($1,$2,$3,$4,$5::jsonb,NULLIF($6,'')::uuid,$7,$8) RETURNING id
	`, id.OrganizationID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description), req.IntentKeywords, rulesJSON, targetAgent, prio, active).Scan(&rid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_router.create", "ai_intent_router", rid, map[string]any{"name": strings.TrimSpace(req.Name)})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": rid, "name": strings.TrimSpace(req.Name), "description": strings.TrimSpace(req.Description),
		"intent_keywords": req.IntentKeywords, "rules": json.RawMessage(rulesJSON),
		"target_agent_id": targetAgent, "priority": prio, "is_active": active,
	})
}

func (h *Handler) UpdateRouter(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rid := chi.URLParam(r, "id")
	var req struct {
		Name           *string         `json:"name"`
		Description    *string         `json:"description"`
		IntentKeywords []string        `json:"intent_keywords"`
		Rules          json.RawMessage `json:"rules"`
		TargetAgentID  *string         `json:"target_agent_id"`
		Priority       *int            `json:"priority"`
		IsActive       *bool           `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var rulesPtr *string
	if len(req.Rules) > 0 && string(req.Rules) != "null" {
		s := string(req.Rules)
		rulesPtr = &s
	}

	var name, desc, targetAgent string
	var keywords []string
	var rulesOut any
	var prio int
	var active bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE ai_intent_routers
		SET name = COALESCE(NULLIF($3, ''), name),
		    description = COALESCE($4, description),
		    intent_keywords = COALESCE($5, intent_keywords),
		    rules = COALESCE($6::jsonb, rules),
		    target_agent_id = CASE WHEN $7::text IS NULL THEN target_agent_id ELSE NULLIF($7, '')::uuid END,
		    priority = COALESCE($8, priority),
		    is_active = COALESCE($9, is_active),
		    updated_at = now()
		WHERE id=$1 AND organization_id=$2
		RETURNING name, description, intent_keywords, rules, COALESCE(target_agent_id::text,''), priority, is_active
	`, rid, id.OrganizationID, req.Name, req.Description, req.IntentKeywords, rulesPtr, req.TargetAgentID, req.Priority, req.IsActive).
		Scan(&name, &desc, &keywords, &rulesOut, &targetAgent, &prio, &active)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "intent router not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_router.update", "ai_intent_router", rid, map[string]any{"is_active": active})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": rid, "name": name, "description": desc, "intent_keywords": keywords,
		"rules": rulesOut, "target_agent_id": targetAgent, "priority": prio, "is_active": active,
	})
}

func (h *Handler) DeleteRouter(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `DELETE FROM ai_intent_routers WHERE id=$1 AND organization_id=$2`, rid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "intent router not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_router.delete", "ai_intent_router", rid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- S20: AI Skills ---

var defaultOrgSkills = []struct {
	Key         string
	Name        string
	Description string
}{
	{"crm_lookup", "Consulta CRM 360", "Busca datos del contacto, leads activos y tareas recientes."},
	{"lead_create", "Crear Oportunidad", "Crea un nuevo lead en el embudo configurado."},
	{"schedule_followup", "Programar Seguimiento", "Inscribe al contacto en un flujo de seguimiento automático."},
	{"handoff_human", "Derivar a Humano", "Transfiere la conversación a un agente humano cuando detecta baja confianza."},
	{"catalog_search", "Buscar Catálogo", "Consulta productos, precios y disponibilidad en el catálogo."},
}

func (h *Handler) ListSkills(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	agentID := strings.TrimSpace(r.URL.Query().Get("agent_id"))

	if agentID == "" {
		var count int
		if err := h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM ai_skills WHERE organization_id=$1`, id.OrganizationID).Scan(&count); err == nil && count == 0 {
			for _, sk := range defaultOrgSkills {
				_, _ = h.Pool.Exec(r.Context(), `
					INSERT INTO ai_skills (organization_id, skill_key, name, description, config, is_enabled)
					VALUES ($1, $2, $3, $4, '{}'::jsonb, true)
				`, id.OrganizationID, sk.Key, sk.Name, sk.Description)
			}
		}
	}

	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, COALESCE(agent_id::text,''), skill_key, name, description, config, is_enabled, created_at, updated_at
		FROM ai_skills
		WHERE organization_id=$1 AND ($2 = '' OR agent_id::text = $2)
		ORDER BY created_at ASC
	`, id.OrganizationID, agentID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, aID, key, name, desc string
		var cfg any
		var enabled bool
		var createdAt, updatedAt any
		_ = rows.Scan(&sid, &aID, &key, &name, &desc, &cfg, &enabled, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id": sid, "agent_id": aID, "skill_key": key, "name": name,
			"description": desc, "config": cfg, "is_enabled": enabled,
			"created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) UpdateSkill(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	sid := chi.URLParam(r, "id")
	var req struct {
		Name        *string         `json:"name"`
		Description *string         `json:"description"`
		Config      json.RawMessage `json:"config"`
		IsEnabled   *bool           `json:"is_enabled"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	var cfgPtr *string
	if len(req.Config) > 0 && string(req.Config) != "null" {
		s := string(req.Config)
		cfgPtr = &s
	}

	var aID, key, name, desc string
	var cfgOut any
	var enabled bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE ai_skills
		SET name = COALESCE(NULLIF($3, ''), name),
		    description = COALESCE($4, description),
		    config = COALESCE($5::jsonb, config),
		    is_enabled = COALESCE($6, is_enabled),
		    updated_at = now()
		WHERE id=$1 AND organization_id=$2
		RETURNING COALESCE(agent_id::text,''), skill_key, name, description, config, is_enabled
	`, sid, id.OrganizationID, req.Name, req.Description, cfgPtr, req.IsEnabled).
		Scan(&aID, &key, &name, &desc, &cfgOut, &enabled)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "skill not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_skill.update", "ai_skill", sid, map[string]any{"is_enabled": enabled})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": sid, "agent_id": aID, "skill_key": key, "name": name,
		"description": desc, "config": cfgOut, "is_enabled": enabled,
	})
}

// --- S21: Agent Cases & Central Alerts Inbox ---

func (h *Handler) ListCases(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, COALESCE(conversation_id::text,''), COALESCE(contact_id::text,''), COALESCE(agent_id::text,''),
		       title, summary, status, COALESCE(decision_notes,''), COALESCE(decided_by::text,''), decided_at, created_at, updated_at
		FROM agent_cases
		WHERE organization_id=$1 AND ($2 = '' OR status = $2)
		ORDER BY created_at DESC LIMIT 100
	`, id.OrganizationID, status)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var cid, convID, contID, agID, title, summary, st, notes, decidedBy string
		var decidedAt, createdAt, updatedAt any
		_ = rows.Scan(&cid, &convID, &contID, &agID, &title, &summary, &st, &notes, &decidedBy, &decidedAt, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id": cid, "conversation_id": convID, "contact_id": contID, "agent_id": agID,
			"title": title, "summary": summary, "status": st, "decision_notes": notes,
			"decided_by": decidedBy, "decided_at": decidedAt, "created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) decideCase(w http.ResponseWriter, r *http.Request, targetStatus string) {
	id, _ := auth.FromContext(r.Context())
	cid := chi.URLParam(r, "id")
	var req struct {
		DecisionNotes string `json:"decision_notes"`
	}
	_ = httpx.Decode(r, &req)

	var notes, decidedBy string
	var decidedAt any
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE agent_cases
		SET status = $3,
		    decision_notes = $4,
		    decided_by = NULLIF($5,'')::uuid,
		    decided_at = now(),
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING COALESCE(decision_notes,''), COALESCE(decided_by::text,''), decided_at
	`, cid, id.OrganizationID, targetStatus, strings.TrimSpace(req.DecisionNotes), id.UserID).
		Scan(&notes, &decidedBy, &decidedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			httpx.Error(w, http.StatusNotFound, "case not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}

	if h.Hub != nil {
		h.Hub.Publish(id.OrganizationID, "ai.case_updated", map[string]any{
			"case_id":    cid,
			"status":     targetStatus,
			"decided_by": decidedBy,
		})
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_case."+targetStatus, "agent_case", cid, map[string]any{"decision_notes": notes})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":             cid,
		"status":         targetStatus,
		"decision_notes": notes,
		"decided_by":     decidedBy,
		"decided_at":     decidedAt,
	})
}

func (h *Handler) ApproveCase(w http.ResponseWriter, r *http.Request) {
	h.decideCase(w, r, "approved")
}

func (h *Handler) RejectCase(w http.ResponseWriter, r *http.Request) {
	h.decideCase(w, r, "rejected")
}

func (h *Handler) ListInbox(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	unreadOnly := strings.EqualFold(r.URL.Query().Get("unread_only"), "true")
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, COALESCE(case_id::text,''), severity, category, message, is_read, created_at
		FROM agent_inbox_items
		WHERE organization_id=$1 AND ($2 = false OR is_read = false)
		ORDER BY created_at DESC LIMIT 100
	`, id.OrganizationID, unreadOnly)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var iid, caseID, sev, cat, msg string
		var isRead bool
		var createdAt any
		_ = rows.Scan(&iid, &caseID, &sev, &cat, &msg, &isRead, &createdAt)
		out = append(out, map[string]any{
			"id": iid, "case_id": caseID, "severity": sev, "category": cat,
			"message": msg, "is_read": isRead, "created_at": createdAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) MarkInboxRead(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	iid := chi.URLParam(r, "id")
	res, err := h.Pool.Exec(r.Context(), `
		UPDATE agent_inbox_items SET is_read = true WHERE id=$1 AND organization_id=$2
	`, iid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	if res.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "inbox item not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "ai_inbox.read", "agent_inbox_item", iid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": iid, "is_read": true})
}

type RAGHit struct {
	Content string  `json:"content"`
	Score   float64 `json:"score"`
}

func SearchRAG(ctx context.Context, pool *pgxpool.Pool, orgID, query string, topK int) ([]RAGHit, error) {
	qVec := EmbedText(query)
	rows, err := pool.Query(ctx, `SELECT content, embedding_json FROM ai_chunks WHERE organization_id=$1 LIMIT 500`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []RAGHit
	for rows.Next() {
		var content string
		var vec []float64
		_ = rows.Scan(&content, &vec)
		hits = append(hits, RAGHit{Content: content, Score: cosine(qVec, vec)})
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > topK {
		hits = hits[:topK]
	}
	return hits, nil
}

// EmbedText produces a deterministic 64-dim normalized hashed n-gram vector for fast local/pgvector RAG.
func EmbedText(text string) []float64 {
	const dims = 64
	vec := make([]float64, dims)
	words := strings.Fields(strings.ToLower(text))
	for _, w := range words {
		h := fnv.New32a()
		_, _ = h.Write([]byte(w))
		idx := int(h.Sum32()) % dims
		vec[idx] += 1.0
	}
	var norm float64
	for _, v := range vec {
		norm += v * v
	}
	norm = math.Sqrt(norm)
	if norm > 0 {
		for i := range vec {
			vec[i] /= norm
		}
	}
	return vec
}

func cosine(a, b []float64) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot float64
	for i := range a {
		dot += a[i] * b[i]
	}
	return dot
}

func splitParagraphs(s string, maxLen int) []string {
	parts := strings.Split(s, "\n\n")
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			if len(p) > maxLen {
				out = append(out, p[:maxLen])
			} else {
				out = append(out, p)
			}
		}
	}
	if len(out) == 0 && strings.TrimSpace(s) != "" {
		out = append(out, strings.TrimSpace(s))
	}
	return out
}
