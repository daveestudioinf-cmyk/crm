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

	// Resolve organization_id from CRM_API_TOKEN env var for stdio MCP
	tok := os.Getenv("CRM_API_TOKEN")
	var orgID string
	if tok != "" {
		_ = pool.QueryRow(ctx, `SELECT organization_id FROM api_tokens WHERE token_hash=$1 AND revoked_at IS NULL`, auth.HashToken(tok)).Scan(&orgID)
	}
	if orgID == "" {
		_ = pool.QueryRow(ctx, `SELECT id FROM organizations LIMIT 1`).Scan(&orgID)
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
