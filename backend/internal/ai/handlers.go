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
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	Pool *pgxpool.Pool
	Hub  *realtime.Hub
}

func (h *Handler) ListAgents(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, system_prompt, provider, model, guardrails, is_active, version
		FROM ai_agents WHERE organization_id=$1 ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var aid, name, prompt, prov, model string
		var guardrails map[string]any
		var active bool
		var ver int
		_ = rows.Scan(&aid, &name, &prompt, &prov, &model, &guardrails, &active, &ver)
		out = append(out, map[string]any{
			"id": aid, "name": name, "system_prompt": prompt, "provider": prov,
			"model": model, "guardrails": guardrails, "is_active": active, "version": ver,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name         string `json:"name"`
		SystemPrompt string `json:"system_prompt"`
		Provider     string `json:"provider"`
		Model        string `json:"model"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Provider == "" {
		req.Provider = "openai"
	}
	if req.Model == "" {
		req.Model = "gpt-4o-mini"
	}
	var aid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO ai_agents (organization_id, name, system_prompt, provider, model)
		VALUES ($1,$2,$3,$4,$5) RETURNING id
	`, id.OrganizationID, req.Name, req.SystemPrompt, req.Provider, req.Model).Scan(&aid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": aid, "name": req.Name})
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

	// Chunk and embed into ai_chunks
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
	var capCents int
	_ = h.Pool.QueryRow(r.Context(), `SELECT COALESCE(monthly_cap_cents, 5000) FROM ai_budgets WHERE organization_id=$1`, id.OrganizationID).Scan(&capCents)
	var spentCents, calls int
	_ = h.Pool.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(cost_cents),0), COUNT(*)
		FROM ai_invocations
		WHERE organization_id=$1 AND created_at >= date_trunc('month', now())
	`, id.OrganizationID).Scan(&spentCents, &calls)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"monthly_cap_cents": capCents,
		"spent_cents":       spentCents,
		"calls":             calls,
		"pct":               float64(spentCents) / float64(max(capCents, 1)) * 100,
	})
}

func (h *Handler) DeleteKnowledge(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	kid := chi.URLParam(r, "id")
	_, _ = h.Pool.Exec(r.Context(), `DELETE FROM ai_knowledge_sources WHERE id=$1 AND organization_id=$2`, kid, id.OrganizationID)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
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

// RunAgentTurn evaluates a customer message, checks 4 handoff triggers, queries RAG, and replies.
func RunAgentTurn(ctx context.Context, pool *pgxpool.Pool, hub *realtime.Hub, orgID, convID, body string) {
	lower := strings.ToLower(body)
	handoffReason := ""
	if strings.Contains(lower, "humano") || strings.Contains(lower, "atendente") || strings.Contains(lower, "agent") || strings.Contains(lower, "person") {
		handoffReason = "explicit_human_request"
	} else if strings.Contains(lower, "procon") || strings.Contains(lower, "lawsuit") || strings.Contains(lower, "reembolso") || strings.Contains(lower, "refund") {
		handoffReason = "guardrail_critical_topic"
	}

	if handoffReason != "" {
		_, _ = pool.Exec(ctx, `UPDATE conversations SET status='pending', service_revision=service_revision+1, updated_at=now() WHERE id=$1 AND organization_id=$2`, convID, orgID)
		_, _ = pool.Exec(ctx, `INSERT INTO ai_invocations (organization_id, conversation_id, purpose, provider, model, handoff_triggered, handoff_reason) VALUES ($1,$2,'handoff','internal','guardrail-v1',true,$3)`, orgID, convID, handoffReason)
		hub.Publish(orgID, "conversation.handoff", map[string]any{"conversation_id": convID, "reason": handoffReason})
		return
	}

	hits, _ := SearchRAG(ctx, pool, orgID, body, 2)
	reply := "Thanks for reaching out! A team member will review your message shortly."
	if len(hits) > 0 && hits[0].Score > 0.15 {
		reply = hits[0].Content
	}

	var msgID string
	_ = pool.QueryRow(ctx, `
		INSERT INTO messages (organization_id, conversation_id, direction, sender_type, content_type, body, status)
		VALUES ($1,$2,'outbound','ai','text',$3,'sent') RETURNING id
	`, orgID, convID, reply).Scan(&msgID)
	_, _ = pool.Exec(ctx, `UPDATE conversations SET last_message_at=now(), last_message_preview=$1 WHERE id=$2`, reply, convID)
	_, _ = pool.Exec(ctx, `INSERT INTO ai_invocations (organization_id, conversation_id, purpose, provider, model, prompt_tokens, completion_tokens, cost_cents) VALUES ($1,$2,'chat','internal','rag-v1',40,30,1)`, orgID, convID)
	hub.Publish(orgID, "message.created", map[string]any{"id": msgID, "conversation_id": convID, "direction": "outbound", "sender_type": "ai", "body": reply})
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
