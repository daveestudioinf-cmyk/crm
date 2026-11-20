package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
)

type idempotencyRecorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
	wrote  bool
}

func (rec *idempotencyRecorder) WriteHeader(code int) {
	if rec.wrote {
		return
	}
	rec.status = code
	rec.wrote = true
	rec.ResponseWriter.WriteHeader(code)
}

func (rec *idempotencyRecorder) Write(b []byte) (int, error) {
	if !rec.wrote {
		rec.WriteHeader(http.StatusOK)
	}
	rec.body.Write(b)
	return rec.ResponseWriter.Write(b)
}

// Idempotency replays cached JSON responses for POST/PATCH/PUT requests carrying an Idempotency-Key header.
func (m *Middleware) Idempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodPatch && r.Method != http.MethodPut {
			next.ServeHTTP(w, r)
			return
		}
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if key == "" {
			next.ServeHTTP(w, r)
			return
		}
		id, ok := FromContext(r.Context())
		if !ok || id.OrganizationID == "" {
			next.ServeHTTP(w, r)
			return
		}

		tag, err := m.Pool.Exec(r.Context(), `
			INSERT INTO idempotency_keys (organization_id, idempotency_key, response_status, response_body)
			VALUES ($1, $2, 0, '{}'::jsonb)
			ON CONFLICT (organization_id, idempotency_key) DO NOTHING
		`, id.OrganizationID, key)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "db error")
			return
		}

		if tag.RowsAffected() == 0 {
			var storedStatus int
			var storedBody []byte
			err := m.Pool.QueryRow(r.Context(), `
				SELECT response_status, response_body
				FROM idempotency_keys
				WHERE organization_id = $1 AND idempotency_key = $2
			`, id.OrganizationID, key).Scan(&storedStatus, &storedBody)
			if err != nil || storedStatus == 0 {
				httpx.Error(w, http.StatusConflict, "idempotency_conflict_in_progress")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Idempotency-Replayed", "true")
			w.WriteHeader(storedStatus)
			_, _ = w.Write(storedBody)
			return
		}

		rec := &idempotencyRecorder{ResponseWriter: w, status: 0}
		next.ServeHTTP(rec, r)

		dbCtx := context.WithoutCancel(r.Context())
		if rec.status >= 200 && rec.status < 500 && json.Valid(rec.body.Bytes()) {
			_, _ = m.Pool.Exec(dbCtx, `
				UPDATE idempotency_keys
				SET response_status = $3, response_body = $4::jsonb
				WHERE organization_id = $1 AND idempotency_key = $2
			`, id.OrganizationID, key, rec.status, rec.body.String())
		} else {
			_, _ = m.Pool.Exec(dbCtx, `
				DELETE FROM idempotency_keys
				WHERE organization_id = $1 AND idempotency_key = $2
			`, id.OrganizationID, key)
		}
	})
}
