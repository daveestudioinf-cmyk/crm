package internal_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/mcpserver"
)

func TestAuthTokensAndRBAC(t *testing.T) {
	secret := "test-secret-key-32-bytes-minimum!"
	id := auth.Identity{
		UserID:         "u-1",
		OrganizationID: "org-1",
		Role:           "manager",
	}
	tok, err := auth.IssueAccessToken(secret, id, time.Hour, false)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	claims, err := auth.ParseToken(secret, tok)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	if claims.OrganizationID != "org-1" || claims.Role != "manager" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	if !auth.HasRole("manager", "agent") || auth.HasRole("agent", "admin") {
		t.Fatalf("rbac check failed")
	}
}

func TestRAGEmbeddingDeterminism(t *testing.T) {
	v1 := ai.EmbedText("whatsapp crm pricing")
	v2 := ai.EmbedText("whatsapp crm pricing")
	if len(v1) != 64 || v1[0] != v2[0] {
		t.Fatalf("embedding mismatch")
	}
}

func TestMCPAndDatabaseIntegration(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable"
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dbURL)
	if err != nil {
		t.Skipf("postgres not reachable: %v", err)
	}
	defer pool.Close()

	var orgID string
	err = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Test Org', 'test-org-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	if err != nil {
		t.Fatalf("insert org: %v", err)
	}
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)

	_, err = pool.Exec(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Alice Test', '+5511999990001')`, orgID)
	if err != nil {
		t.Fatalf("insert contact: %v", err)
	}

	srv := &mcpserver.Server{Pool: pool}
	resp := srv.HandleRPC(ctx, orgID, mcpserver.RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/list",
	})
	if resp.Error != nil {
		t.Fatalf("mcp tools/list error: %v", resp.Error)
	}

	params, _ := json.Marshal(map[string]any{
		"name":      "search_contacts",
		"arguments": map[string]any{"query": "Alice"},
	})
	callResp := srv.HandleRPC(ctx, orgID, mcpserver.RPCRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "tools/call",
		Params:  params,
	})
	if callResp.Error != nil {
		t.Fatalf("mcp search_contacts error: %v", callResp.Error)
	}
}
