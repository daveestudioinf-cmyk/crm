package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type LLMRequest struct {
	Provider     string
	BaseURL      string
	APIKey       string
	Model        string
	SystemPrompt string
	Messages     []ChatMessage
	Temperature  float64
	MaxTokens    int
}

type LLMResponse struct {
	Content          string
	PromptTokens     int
	CompletionTokens int
	CostCents        int
	LatencyMs        int
	Provider         string
	Model            string
}

var (
	llmHTTPClient  = &http.Client{Timeout: 30 * time.Second}
	queryKeyRegexp = regexp.MustCompile(`([?&]key=)[^&\s"']+`)
)

func sanitizeLLMError(err error, apiKey string) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if apiKey != "" {
		msg = strings.ReplaceAll(msg, apiKey, "[REDACTED]")
	}
	msg = queryKeyRegexp.ReplaceAllString(msg, "${1}[REDACTED]")
	return msg
}

// EstimateCostCents estimates LLM call cost in USD cents (minimum 1 cent for external calls).
func EstimateCostCents(model string, promptTokens, completionTokens int) int {
	m := strings.ToLower(model)
	// Approximate blended cents per 1M tokens
	inRate := 15.0  // $0.15 / 1M
	outRate := 60.0 // $0.60 / 1M
	switch {
	case strings.Contains(m, "gpt-4o") && !strings.Contains(m, "mini"):
		inRate, outRate = 250.0, 1000.0
	case strings.Contains(m, "claude-3-5-sonnet") || strings.Contains(m, "claude-sonnet"):
		inRate, outRate = 300.0, 1500.0
	case strings.Contains(m, "gemini-1.5-pro") || strings.Contains(m, "gemini-2.5-pro"):
		inRate, outRate = 125.0, 500.0
	}
	cents := (float64(promptTokens)*inRate + float64(completionTokens)*outRate) / 1_000_000.0
	if cents < 1.0 {
		return 1
	}
	return int(cents + 0.5)
}

func CallLLM(ctx context.Context, req LLMRequest) (LLMResponse, error) {
	start := time.Now()
	if req.MaxTokens <= 0 {
		req.MaxTokens = 500
	}
	if req.Model == "" {
		req.Model = defaultModelForProvider(req.Provider)
	}

	var res LLMResponse
	var err error
	switch req.Provider {
	case "openai", "openrouter", "openai_compatible":
		res, err = callOpenAICompatible(ctx, req)
	case "anthropic":
		res, err = callAnthropic(ctx, req)
	case "gemini":
		res, err = callGemini(ctx, req)
	default:
		return LLMResponse{}, fmt.Errorf("unsupported provider: %s", req.Provider)
	}
	if err != nil {
		return LLMResponse{}, fmt.Errorf("%s", sanitizeLLMError(err, req.APIKey))
	}
	res.LatencyMs = int(time.Since(start).Milliseconds())
	if res.LatencyMs <= 0 {
		res.LatencyMs = 1
	}
	res.Provider = req.Provider
	res.Model = req.Model
	if res.PromptTokens == 0 {
		res.PromptTokens = 50
	}
	if res.CompletionTokens == 0 {
		res.CompletionTokens = max(len(strings.Fields(res.Content))*2, 10)
	}
	res.CostCents = EstimateCostCents(req.Model, res.PromptTokens, res.CompletionTokens)
	return res, nil
}

func defaultModelForProvider(provider string) string {
	switch provider {
	case "anthropic":
		return "claude-3-5-haiku-latest"
	case "gemini":
		return "gemini-2.0-flash"
	case "openrouter":
		return "openai/gpt-4o-mini"
	default:
		return "gpt-4o-mini"
	}
}

func defaultBaseURL(provider string) string {
	switch provider {
	case "openrouter":
		return "https://openrouter.ai/api/v1"
	case "anthropic":
		return "https://api.anthropic.com"
	case "gemini":
		return "https://generativelanguage.googleapis.com"
	default:
		return "https://api.openai.com/v1"
	}
}

func callOpenAICompatible(ctx context.Context, req LLMRequest) (LLMResponse, error) {
	base := strings.TrimRight(req.BaseURL, "/")
	if base == "" {
		base = defaultBaseURL(req.Provider)
	}
	msgs := make([]ChatMessage, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.SystemPrompt) != "" {
		msgs = append(msgs, ChatMessage{Role: "system", Content: req.SystemPrompt})
	}
	msgs = append(msgs, req.Messages...)

	payload := map[string]any{
		"model":       req.Model,
		"messages":    msgs,
		"temperature": req.Temperature,
		"max_tokens":  req.MaxTokens,
	}
	b, _ := json.Marshal(payload)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return LLMResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)

	resp, err := llmHTTPClient.Do(httpReq)
	if err != nil {
		return LLMResponse{}, err
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return LLMResponse{}, fmt.Errorf("llm status %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return LLMResponse{}, err
	}
	if len(parsed.Choices) == 0 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		return LLMResponse{}, fmt.Errorf("empty llm response")
	}
	return LLMResponse{
		Content:          strings.TrimSpace(parsed.Choices[0].Message.Content),
		PromptTokens:     parsed.Usage.PromptTokens,
		CompletionTokens: parsed.Usage.CompletionTokens,
	}, nil
}

func callAnthropic(ctx context.Context, req LLMRequest) (LLMResponse, error) {
	base := strings.TrimRight(req.BaseURL, "/")
	if base == "" {
		base = defaultBaseURL("anthropic")
	}
	payload := map[string]any{
		"model":       req.Model,
		"max_tokens":  req.MaxTokens,
		"temperature": req.Temperature,
		"system":      req.SystemPrompt,
		"messages":    req.Messages,
	}
	b, _ := json.Marshal(payload)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/messages", bytes.NewReader(b))
	if err != nil {
		return LLMResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", req.APIKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := llmHTTPClient.Do(httpReq)
	if err != nil {
		return LLMResponse{}, err
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return LLMResponse{}, fmt.Errorf("anthropic status %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	var parsed struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return LLMResponse{}, err
	}
	if len(parsed.Content) == 0 || strings.TrimSpace(parsed.Content[0].Text) == "" {
		return LLMResponse{}, fmt.Errorf("empty anthropic response")
	}
	return LLMResponse{
		Content:          strings.TrimSpace(parsed.Content[0].Text),
		PromptTokens:     parsed.Usage.InputTokens,
		CompletionTokens: parsed.Usage.OutputTokens,
	}, nil
}

func callGemini(ctx context.Context, req LLMRequest) (LLMResponse, error) {
	base := strings.TrimRight(req.BaseURL, "/")
	if base == "" {
		base = defaultBaseURL("gemini")
	}
	var contents []map[string]any
	for _, m := range req.Messages {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		contents = append(contents, map[string]any{
			"role":  role,
			"parts": []map[string]string{{"text": m.Content}},
		})
	}
	payload := map[string]any{
		"contents": contents,
		"generationConfig": map[string]any{
			"temperature":     req.Temperature,
			"maxOutputTokens": req.MaxTokens,
		},
	}
	if strings.TrimSpace(req.SystemPrompt) != "" {
		payload["systemInstruction"] = map[string]any{
			"parts": []map[string]string{{"text": req.SystemPrompt}},
		}
	}
	b, _ := json.Marshal(payload)
	endpoint := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", base, req.Model, req.APIKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(b))
	if err != nil {
		return LLMResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := llmHTTPClient.Do(httpReq)
	if err != nil {
		return LLMResponse{}, err
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return LLMResponse{}, fmt.Errorf("gemini status %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount     int `json:"promptTokenCount"`
			CandidatesTokenCount int `json:"candidatesTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return LLMResponse{}, err
	}
	if len(parsed.Candidates) == 0 || len(parsed.Candidates[0].Content.Parts) == 0 {
		return LLMResponse{}, fmt.Errorf("empty gemini response")
	}
	return LLMResponse{
		Content:          strings.TrimSpace(parsed.Candidates[0].Content.Parts[0].Text),
		PromptTokens:     parsed.UsageMetadata.PromptTokenCount,
		CompletionTokens: parsed.UsageMetadata.CandidatesTokenCount,
	}, nil
}

// DeterministicLocalReply builds a grounded Spanish response when no external LLM key is configured.
func DeterministicLocalReply(hits []RAGHit, memories []string, products []string) string {
	if len(hits) > 0 && hits[0].Score > 0.15 {
		return hits[0].Content
	}
	if len(products) > 0 {
		return "Con gusto te ayudo. Actualmente contamos con: " + strings.Join(products, "; ") + ". ¿Te gustaría más detalles?"
	}
	if len(memories) > 0 {
		return memories[0]
	}
	return "¡Gracias por escribirnos! Un asesor de nuestro equipo revisará tu consulta a la brevedad."
}
