package db

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 20
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

func RunMigrations(ctx context.Context, pool *pgxpool.Pool, migrationsDir string) error {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations')`).Scan(&exists)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	sqlPath := filepath.Join(migrationsDir, "000001_init_schema.up.sql")
	raw, err := os.ReadFile(sqlPath)
	if err != nil {
		return fmt.Errorf("read migration %s: %w", sqlPath, err)
	}
	_, err = pool.Exec(ctx, string(raw))
	return err
}
