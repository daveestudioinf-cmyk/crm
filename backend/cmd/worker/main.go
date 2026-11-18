package main

import (
	"context"
	"encoding/json"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
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

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("KoraCRM Worker stopping")
			return
		case <-ticker.C:
			drainEvents(ctx, pool, runner)
		}
	}
}

func drainEvents(ctx context.Context, pool *pgxpool.Pool, runner *ai.Runner) {
	rows, err := pool.Query(ctx, `
		UPDATE event_log SET status = 'processing', attempts = attempts + 1
		WHERE id IN (
			SELECT id FROM event_log WHERE status = 'pending' AND available_at <= now() ORDER BY created_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED
		)
		RETURNING id, organization_id, event_type, payload
	`)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var id, orgID, evType string
		var rawPayload []byte
		if err := rows.Scan(&id, &orgID, &evType, &rawPayload); err != nil {
			continue
		}
		var isSuspended bool
		if err := pool.QueryRow(ctx, `SELECT is_suspended FROM organizations WHERE id = $1`, orgID).Scan(&isSuspended); err != nil || isSuspended {
			_, _ = pool.Exec(ctx, `UPDATE event_log SET status = 'failed', last_error = 'skipped_suspended' WHERE id = $1`, id)
			continue
		}
		if evType == "ai.turn" {
			var p struct {
				ConversationID string `json:"conversation_id"`
				Body           string `json:"body"`
			}
			if json.Unmarshal(rawPayload, &p) == nil {
				if err := runner.RunAgentTurn(ctx, orgID, p.ConversationID, p.Body); err != nil {
					_, _ = pool.Exec(ctx, `UPDATE event_log SET status = 'failed', last_error = $2 WHERE id = $1`, id, err.Error())
					continue
				}
			}
		}
		_, _ = pool.Exec(ctx, `UPDATE event_log SET status = 'done' WHERE id = $1`, id)
	}
}
