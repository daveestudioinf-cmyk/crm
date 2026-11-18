package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	Pool *pgxpool.Pool
}

type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type RPCResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

func ToolsList() []map[string]any {
	return []map[string]any{
		{"name": "search_contacts", "description": "Search CRM contacts by name, phone, or email", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}, "required": []string{"query"}}},
		{"name": "get_customer_360", "description": "Get full Customer 360 profile and recent activities", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"contact_id": map[string]any{"type": "string"}}, "required": []string{"contact_id"}}},
		{"name": "list_conversations", "description": "List active CRM conversations", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"status": map[string]any{"type": "string"}}}},
		{"name": "send_message", "description": "Send outbound message to a conversation", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"conversation_id": map[string]any{"type": "string"}, "body": map[string]any{"type": "string"}}, "required": []string{"conversation_id", "body"}}},
		{"name": "move_lead_stage", "description": "Move a deal/lead to a target stage", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"lead_id": map[string]any{"type": "string"}, "stage_id": map[string]any{"type": "string"}}, "required": []string{"lead_id", "stage_id"}}},
		{"name": "search_knowledge", "description": "Search tenant RAG knowledge base", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}, "required": []string{"query"}}},
		{"name": "create_task", "description": "Create a follow-up task", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"title": map[string]any{"type": "string"}, "contact_id": map[string]any{"type": "string"}}, "required": []string{"title"}}},
	}
}

func (s *Server) HandleRPC(ctx context.Context, orgID string, req RPCRequest) RPCResponse {
	switch req.Method {
	case "initialize":
		return RPCResponse{
			JSONRPC: "2.0", ID: req.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"serverInfo":      map[string]any{"name": "kora-crm-mcp", "version": "1.0.0"},
				"capabilities":    map[string]any{"tools": map[string]any{}},
			},
		}
	case "tools/list":
		return RPCResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"tools": ToolsList()}}
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &p)
		res, err := s.callTool(ctx, orgID, p.Name, p.Arguments)
		if err != nil {
			return RPCResponse{JSONRPC: "2.0", ID: req.ID, Error: map[string]any{"code": -32000, "message": err.Error()}}
		}
		b, _ := json.Marshal(res)
		return RPCResponse{
			JSONRPC: "2.0", ID: req.ID,
			Result: map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}},
		}
	default:
		return RPCResponse{JSONRPC: "2.0", ID: req.ID, Error: map[string]any{"code": -32601, "message": "method not found"}}
	}
}

func (s *Server) callTool(ctx context.Context, orgID, name string, args map[string]any) (any, error) {
	str := func(k string) string {
		if v, ok := args[k].(string); ok {
			return v
		}
		return ""
	}
	switch name {
	case "search_contacts":
		rows, err := s.Pool.Query(ctx, `SELECT id, name, COALESCE(phone_number,''), COALESCE(email,'') FROM contacts WHERE organization_id=$1 AND (name ILIKE '%'||$2||'%' OR phone_number ILIKE '%'||$2||'%') LIMIT 10`, orgID, str("query"))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, n, ph, em string
			_ = rows.Scan(&id, &n, &ph, &em)
			out = append(out, map[string]any{"id": id, "name": n, "phone_number": ph, "email": em})
		}
		return out, nil
	case "get_customer_360":
		var n, ph, em string
		err := s.Pool.QueryRow(ctx, `SELECT name, COALESCE(phone_number,''), COALESCE(email,'') FROM contacts WHERE id=$1 AND organization_id=$2`, str("contact_id"), orgID).Scan(&n, &ph, &em)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": str("contact_id"), "name": n, "phone_number": ph, "email": em}, nil
	case "list_conversations":
		rows, err := s.Pool.Query(ctx, `SELECT id, status, COALESCE(last_message_preview,'') FROM conversations WHERE organization_id=$1 ORDER BY last_message_at DESC LIMIT 20`, orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, st, prev string
			_ = rows.Scan(&id, &st, &prev)
			out = append(out, map[string]any{"id": id, "status": st, "preview": prev})
		}
		return out, nil
	case "send_message":
		var mid string
		err := s.Pool.QueryRow(ctx, `INSERT INTO messages (organization_id, conversation_id, direction, sender_type, content_type, body, status) VALUES ($1,$2,'outbound','ai','text',$3,'sent') RETURNING id`, orgID, str("conversation_id"), str("body")).Scan(&mid)
		return map[string]any{"message_id": mid}, err
	case "move_lead_stage":
		_, err := s.Pool.Exec(ctx, `UPDATE crm_leads SET stage_id=$1, version=version+1, updated_at=now() WHERE id=$2 AND organization_id=$3`, str("stage_id"), str("lead_id"), orgID)
		return map[string]any{"status": "moved"}, err
	case "search_knowledge":
		return ai.SearchRAG(ctx, s.Pool, orgID, str("query"), 3)
	case "create_task":
		var tid string
		err := s.Pool.QueryRow(ctx, `INSERT INTO crm_tasks (organization_id, title) VALUES ($1,$2) RETURNING id`, orgID, str("title")).Scan(&tid)
		return map[string]any{"task_id": tid}, err
	default:
		return map[string]any{"error": "unknown tool"}, nil
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req RPCRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	resp := s.HandleRPC(r.Context(), id.OrganizationID, req)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
