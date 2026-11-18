package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/mcpserver"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	// Resolve organization_id from CRM_API_TOKEN env var for stdio MCP (no fallback)
	tok := os.Getenv("CRM_API_TOKEN")
	if tok == "" {
		log.Fatal("CRM_API_TOKEN is required")
	}
	var orgID string
	var isSuspended bool
	err = pool.QueryRow(ctx, `
		SELECT t.organization_id, o.is_suspended
		FROM api_tokens t
		JOIN organizations o ON o.id = t.organization_id
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
	`, auth.HashToken(tok)).Scan(&orgID, &isSuspended)
	if err != nil || orgID == "" {
		log.Fatal("invalid or expired CRM_API_TOKEN")
	}
	if isSuspended {
		log.Fatal("tenant_suspended")
	}

	srv := &mcpserver.Server{Pool: pool}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req mcpserver.RPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		resp := srv.HandleRPC(ctx, orgID, req)
		b, _ := json.Marshal(resp)
		fmt.Println(string(b))
	}
}
