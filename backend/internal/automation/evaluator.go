package automation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/jackc/pgx/v5/pgxpool"
)

type WhatsAppSender interface {
	SendText(ctx context.Context, instanceName, phoneNumber, text string) error
}

type Condition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value any    `json:"value"`
}

type Action struct {
	Type       string         `json:"type"`
	Config     map[string]any `json:"config,omitempty"`
	Title      string         `json:"title,omitempty"`
	StageID    string         `json:"stage_id,omitempty"`
	UserID     string         `json:"user_id,omitempty"`
	AgentID    string         `json:"agent_id,omitempty"`
	AssignedTo string         `json:"assigned_to,omitempty"`
	Message    string         `json:"message,omitempty"`
	Body       string         `json:"body,omitempty"`
	Text       string         `json:"text,omitempty"`
	Tag        string         `json:"tag,omitempty"`
	URL        string         `json:"url,omitempty"`
}

func (a Action) getString(keys ...string) string {
	for _, k := range keys {
		if a.Config != nil {
			if v, ok := a.Config[k]; ok && v != nil {
				if s := strings.TrimSpace(fmt.Sprintf("%v", v)); s != "" && s != "<nil>" {
					return s
				}
			}
		}
		switch k {
		case "title":
			if a.Title != "" {
				return a.Title
			}
		case "stage_id":
			if a.StageID != "" {
				return a.StageID
			}
		case "user_id":
			if a.UserID != "" {
				return a.UserID
			}
		case "agent_id":
			if a.AgentID != "" {
				return a.AgentID
			}
		case "assigned_to":
			if a.AssignedTo != "" {
				return a.AssignedTo
			}
		case "message":
			if a.Message != "" {
				return a.Message
			}
		case "body":
			if a.Body != "" {
				return a.Body
			}
		case "text":
			if a.Text != "" {
				return a.Text
			}
		case "tag":
			if a.Tag != "" {
				return a.Tag
			}
		case "url":
			if a.URL != "" {
				return a.URL
			}
		}
	}
	return ""
}

// ParseActions parses the actions JSON array into typed Action structs.
func ParseActions(actionsJSON []byte) ([]Action, error) {
	trimmed := bytes.TrimSpace(actionsJSON)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var actions []Action
	if err := json.Unmarshal(trimmed, &actions); err != nil {
		return nil, err
	}
	return actions, nil
}

// EvaluateConditions evaluates WHEN/IF condition trees against ctxData.
// Supports:
// - empty / null / {} / [] -> true
// - {"all": [...], "any": [...]} (nested)
// - [{"field": "...", "op": "...", "value": ...}]
// - {"field": "...", "op": "...", "value": ...}
// - {"key": "expectedValue"} shorthand map
func EvaluateConditions(conditionsJSON []byte, ctxData map[string]any) (bool, error) {
	trimmed := bytes.TrimSpace(conditionsJSON)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("{}")) || bytes.Equal(trimmed, []byte("[]")) {
		return true, nil
	}

	var raw any
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return false, err
	}
	return evalNode(raw, ctxData)
}

func evalNode(node any, ctxData map[string]any) (bool, error) {
	if node == nil {
		return true, nil
	}
	switch v := node.(type) {
	case []any:
		for _, item := range v {
			ok, err := evalNode(item, ctxData)
			if err != nil {
				return false, err
			}
			if !ok {
				return false, nil
			}
		}
		return true, nil

	case map[string]any:
		if len(v) == 0 {
			return true, nil
		}
		hasGroup := false
		if allRaw, ok := v["all"]; ok {
			hasGroup = true
			arr, ok := allRaw.([]any)
			if !ok {
				return false, fmt.Errorf("conditions 'all' must be an array")
			}
			for _, item := range arr {
				matched, err := evalNode(item, ctxData)
				if err != nil {
					return false, err
				}
				if !matched {
					return false, nil
				}
			}
		}
		if anyRaw, ok := v["any"]; ok {
			hasGroup = true
			arr, ok := anyRaw.([]any)
			if !ok {
				return false, fmt.Errorf("conditions 'any' must be an array")
			}
			if len(arr) > 0 {
				anyMatched := false
				for _, item := range arr {
					matched, err := evalNode(item, ctxData)
					if err != nil {
						return false, err
					}
					if matched {
						anyMatched = true
						break
					}
				}
				if !anyMatched {
					return false, nil
				}
			}
		}
		if hasGroup {
			return true, nil
		}

		// Single condition object {field, op, value}
		if fieldRaw, hasField := v["field"]; hasField {
			field, _ := fieldRaw.(string)
			op, _ := v["op"].(string)
			if op == "" {
				op = "eq"
			}
			return evalSingleCondition(field, op, v["value"], ctxData)
		}

		// Shorthand map {"key": "val"} -> all must eq
		for k, expected := range v {
			matched, err := evalSingleCondition(k, "eq", expected, ctxData)
			if err != nil {
				return false, err
			}
			if !matched {
				return false, nil
			}
		}
		return true, nil
	default:
		return false, fmt.Errorf("unsupported condition node type %T", node)
	}
}

func lookupField(field string, ctxData map[string]any) (any, bool) {
	if ctxData == nil || field == "" {
		return nil, false
	}
	if val, ok := ctxData[field]; ok {
		return val, true
	}
	parts := strings.Split(field, ".")
	var cur any = ctxData
	for _, part := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		val, exists := m[part]
		if !exists {
			return nil, false
		}
		cur = val
	}
	return cur, true
}

func evalSingleCondition(field, op string, expected any, ctxData map[string]any) (bool, error) {
	actual, exists := lookupField(field, ctxData)
	op = strings.ToLower(strings.TrimSpace(op))

	switch op {
	case "exists":
		present := exists && actual != nil
		if s, ok := actual.(string); ok && strings.TrimSpace(s) == "" {
			present = false
		}
		if want, ok := expected.(bool); ok && !want {
			return !present, nil
		}
		return present, nil

	case "eq", "=":
		if !exists {
			return false, nil
		}
		return valuesEqual(actual, expected), nil

	case "neq", "!=":
		if !exists {
			return true, nil
		}
		return !valuesEqual(actual, expected), nil

	case "contains":
		if !exists || actual == nil {
			return false, nil
		}
		if rv := reflect.ValueOf(actual); rv.Kind() == reflect.Slice {
			for i := 0; i < rv.Len(); i++ {
				if valuesEqual(rv.Index(i).Interface(), expected) {
					return true, nil
				}
			}
			return false, nil
		}
		return strings.Contains(strings.ToLower(fmt.Sprintf("%v", actual)), strings.ToLower(fmt.Sprintf("%v", expected))), nil

	case "gt", ">":
		if !exists {
			return false, nil
		}
		aNum, aOk := toFloat64(actual)
		eNum, eOk := toFloat64(expected)
		if !aOk || !eOk {
			return false, nil
		}
		return aNum > eNum, nil

	case "lt", "<":
		if !exists {
			return false, nil
		}
		aNum, aOk := toFloat64(actual)
		eNum, eOk := toFloat64(expected)
		if !aOk || !eOk {
			return false, nil
		}
		return aNum < eNum, nil

	case "in":
		if !exists || expected == nil {
			return false, nil
		}
		if rv := reflect.ValueOf(expected); rv.Kind() == reflect.Slice {
			for i := 0; i < rv.Len(); i++ {
				if valuesEqual(actual, rv.Index(i).Interface()) {
					return true, nil
				}
			}
			return false, nil
		}
		if s, ok := expected.(string); ok {
			for _, part := range strings.Split(s, ",") {
				if valuesEqual(actual, strings.TrimSpace(part)) {
					return true, nil
				}
			}
		}
		return false, nil

	default:
		return false, fmt.Errorf("unsupported operator: %s", op)
	}
}

func valuesEqual(a, b any) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	if af, aOk := toFloat64(a); aOk {
		if bf, bOk := toFloat64(b); bOk {
			return af == bf
		}
	}
	if ab, aOk := a.(bool); aOk {
		if bb, bOk := b.(bool); bOk {
			return ab == bb
		}
	}
	return strings.EqualFold(strings.TrimSpace(fmt.Sprintf("%v", a)), strings.TrimSpace(fmt.Sprintf("%v", b)))
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case int32:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

type ruleRow struct {
	ID         string
	Name       string
	Conditions []byte
	Actions    []byte
}

// EvaluateEvent loads active automation_rules for orgID matching triggerEvent,
// evaluates IF conditions, executes THEN actions, logs to automation_rule_runs,
// and emits SSE automation.executed.
func EvaluateEvent(
	ctx context.Context,
	pool *pgxpool.Pool,
	hub *realtime.Hub,
	evo WhatsAppSender,
	orgID, eventID, triggerEvent string,
	payload map[string]any,
) error {
	if pool == nil {
		return fmt.Errorf("automation pool is nil")
	}
	if payload == nil {
		payload = map[string]any{}
	}

	rows, err := pool.Query(ctx, `
		SELECT id, name, conditions, actions
		FROM automation_rules
		WHERE organization_id = $1 AND trigger_event = $2 AND is_active = true
		ORDER BY priority ASC, created_at ASC
	`, orgID, triggerEvent)
	if err != nil {
		return err
	}
	var rules []ruleRow
	for rows.Next() {
		var r ruleRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Conditions, &r.Actions); err == nil {
			rules = append(rules, r)
		}
	}
	rows.Close()

	payloadJSON, _ := json.Marshal(payload)

	for _, rule := range rules {
		startedAt := time.Now().UTC()
		matched, condErr := EvaluateConditions(rule.Conditions, payload)
		if condErr != nil {
			recordRuleRun(ctx, pool, orgID, rule.ID, eventID, triggerEvent, "failed", payloadJSON, []byte("[]"), condErr.Error(), startedAt)
			continue
		}
		if !matched {
			recordRuleRun(ctx, pool, orgID, rule.ID, eventID, triggerEvent, "skipped", payloadJSON, []byte("[]"), "", startedAt)
			continue
		}

		actions, parseErr := ParseActions(rule.Actions)
		if parseErr != nil {
			recordRuleRun(ctx, pool, orgID, rule.ID, eventID, triggerEvent, "failed", payloadJSON, []byte("[]"), parseErr.Error(), startedAt)
			continue
		}

		executed := make([]map[string]any, 0, len(actions))
		var execErr error
		for _, act := range actions {
			res, err := executeAction(ctx, pool, evo, orgID, act, payload)
			if err != nil {
				execErr = err
				executed = append(executed, map[string]any{"type": act.Type, "status": "failed", "error": err.Error()})
				break
			}
			executed = append(executed, map[string]any{"type": act.Type, "status": "ok", "result": res})
		}

		executedJSON, _ := json.Marshal(executed)
		if execErr != nil {
			recordRuleRun(ctx, pool, orgID, rule.ID, eventID, triggerEvent, "failed", payloadJSON, executedJSON, execErr.Error(), startedAt)
			continue
		}

		recordRuleRun(ctx, pool, orgID, rule.ID, eventID, triggerEvent, "executed", payloadJSON, executedJSON, "", startedAt)
		if hub != nil {
			hub.Publish(orgID, "automation.executed", map[string]any{
				"rule_id":       rule.ID,
				"rule_name":     rule.Name,
				"trigger_event": triggerEvent,
				"event_id":      eventID,
				"actions_count": len(executed),
			})
		}
	}

	return nil
}

func recordRuleRun(
	ctx context.Context,
	pool *pgxpool.Pool,
	orgID, ruleID, eventID, triggerEvent, status string,
	inputPayload, actionsExecuted []byte,
	errMsg string,
	startedAt time.Time,
) {
	_, _ = pool.Exec(ctx, `
		INSERT INTO automation_rule_runs
			(organization_id, rule_id, event_id, trigger_event, status, input_payload, actions_executed, error_message, started_at, finished_at)
		VALUES
			($1, $2, NULLIF($3, '')::uuid, $4, $5, $6::jsonb, $7::jsonb, NULLIF($8, ''), $9, now())
	`, orgID, ruleID, eventID, triggerEvent, status, string(inputPayload), string(actionsExecuted), errMsg, startedAt)
}

func payloadStr(payload map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := lookupField(k, payload); ok && v != nil {
			s := strings.TrimSpace(fmt.Sprintf("%v", v))
			if s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}

func executeAction(ctx context.Context, pool *pgxpool.Pool, evo WhatsAppSender, orgID string, act Action, payload map[string]any) (string, error) {
	actionType := strings.ToLower(strings.TrimSpace(act.Type))
	contactID := payloadStr(payload, "contact_id", "contact.id")
	leadID := payloadStr(payload, "lead_id", "lead.id")
	convID := payloadStr(payload, "conversation_id", "conversation.id")

	switch actionType {
	case "create_task":
		title := act.getString("title")
		if title == "" {
			title = "Tarea automática"
		}
		desc := act.getString("description", "body", "message")
		assignedTo := act.getString("assigned_to", "user_id")
		var taskID string
		err := pool.QueryRow(ctx, `
			INSERT INTO crm_tasks (organization_id, lead_id, contact_id, assigned_to, title, description, status)
			VALUES ($1, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid, $5, NULLIF($6,''), 'pending')
			RETURNING id
		`, orgID, leadID, contactID, assignedTo, title, desc).Scan(&taskID)
		return taskID, err

	case "move_stage":
		stageID := act.getString("stage_id")
		if stageID == "" {
			return "", fmt.Errorf("move_stage requires stage_id")
		}
		if leadID == "" {
			return "", fmt.Errorf("move_stage requires lead_id in payload")
		}
		_, err := pool.Exec(ctx, `
			UPDATE crm_leads SET stage_id = $1, updated_at = now()
			WHERE id = $2 AND organization_id = $3
		`, stageID, leadID, orgID)
		return stageID, err

	case "assign_agent":
		targetID := act.getString("user_id", "assigned_to", "agent_id")
		if targetID == "" {
			return "", fmt.Errorf("assign_agent requires user_id or agent_id")
		}
		if convID != "" {
			_, err := pool.Exec(ctx, `
				UPDATE conversations
				SET assigned_to = $1::uuid,
				    status = CASE WHEN status IN ('open', 'pending', 'ai_handling') THEN 'claimed' ELSE status END,
				    updated_at = now()
				WHERE id = $2 AND organization_id = $3
			`, targetID, convID, orgID)
			if err != nil {
				return "", err
			}
		}
		if leadID != "" {
			_, err := pool.Exec(ctx, `
				UPDATE crm_leads SET owner_user_id = $1::uuid, updated_at = now()
				WHERE id = $2 AND organization_id = $3
			`, targetID, leadID, orgID)
			if err != nil {
				return "", err
			}
		}
		return targetID, nil

	case "send_whatsapp":
		text := act.getString("message", "body", "text")
		if text == "" {
			return "", fmt.Errorf("send_whatsapp requires message text")
		}
		phone := payloadStr(payload, "phone_number", "from_phone", "contact.phone_number")
		if phone == "" && contactID != "" {
			_ = pool.QueryRow(ctx, `SELECT COALESCE(phone_number, '') FROM contacts WHERE id = $1 AND organization_id = $2`, contactID, orgID).Scan(&phone)
		}
		var sessionName string
		if convID != "" {
			_ = pool.QueryRow(ctx, `
				SELECT COALESCE(cs.session_name, ''), COALESCE(c.phone_number, '')
				FROM conversations conv
				LEFT JOIN channel_sessions cs ON cs.id = conv.channel_session_id
				LEFT JOIN contacts c ON c.id = conv.contact_id
				WHERE conv.id = $1 AND conv.organization_id = $2
			`, convID, orgID).Scan(&sessionName, &phone)
		}
		if sessionName == "" {
			_ = pool.QueryRow(ctx, `
				SELECT session_name FROM channel_sessions
				WHERE organization_id = $1 AND status = 'WORKING'
				ORDER BY created_at ASC LIMIT 1
			`, orgID).Scan(&sessionName)
		}
		if evo != nil && sessionName != "" && phone != "" {
			if err := evo.SendText(ctx, sessionName, phone, text); err != nil {
				return "", err
			}
		}
		if convID != "" {
			_, _ = pool.Exec(ctx, `
				INSERT INTO messages (organization_id, conversation_id, direction, sender_type, content_type, body, status)
				VALUES ($1, $2, 'outbound', 'system', 'text', $3, 'sent')
			`, orgID, convID, text)
		}
		return phone, nil

	case "add_tag":
		tag := act.getString("tag")
		if tag == "" {
			return "", fmt.Errorf("add_tag requires tag")
		}
		if contactID != "" {
			_, err := pool.Exec(ctx, `
				UPDATE contacts
				SET tags = array_append(tags, $1), updated_at = now()
				WHERE id = $2 AND organization_id = $3 AND NOT ($1 = ANY(tags))
			`, tag, contactID, orgID)
			if err != nil {
				return "", err
			}
		}
		if leadID != "" {
			_, err := pool.Exec(ctx, `
				UPDATE crm_leads
				SET tags = array_append(tags, $1), updated_at = now()
				WHERE id = $2 AND organization_id = $3 AND NOT ($1 = ANY(tags))
			`, tag, leadID, orgID)
			if err != nil {
				return "", err
			}
		}
		return tag, nil

	case "webhook_post":
		targetURL := act.getString("url")
		if targetURL == "" {
			return "", fmt.Errorf("webhook_post requires url")
		}
		bodyBytes, _ := json.Marshal(payload)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return "", fmt.Errorf("webhook_post status %d", resp.StatusCode)
		}
		return fmt.Sprintf("http_%d", resp.StatusCode), nil

	default:
		return "", fmt.Errorf("unsupported action type: %s", act.Type)
	}
}
