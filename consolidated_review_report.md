# Consolidated Goldfish Review Report: Bloque 2

* **Target:** `docs/designs/ai-engine-evolution-bloque-2.md`
* **Rounds:** 2 (Round 1: 2 parallel Goldfish auditors -> 4 Blockers, 10 Majors resolved; Round 2: CLEAN)

## Round 1 Findings & Resolutions

### Blockers Resolved
1. **Go Typed-`nil` Interface Panic in `ai.Runner.Outbound`**: `cmd/worker/main.go` only assigns `Outbound` when `evoClient != nil`, and `EvolutionClient.SendText` guards `if c == nil`.
2. **TOCTOU Race Condition & Non-Atomic Month Reset on `ai_budgets`**: Replaced pre-check + post-increment with atomic PostgreSQL month reset (`period_start < date_trunc('month', now())`) and atomic 1-cent reservation (`UPDATE ... WHERE NOT hard_stop OR spent_cents < monthly_limit_cents`) before external LLM calls, followed by delta adjustment or refund on failure.
3. **Unauthenticated `EvolutionWebhook`**: Added `webhook_secret` validation (`X-Webhook-Secret` / `?secret=` or `apikey` against `EvolutionClient.APIKey`), returning `401 unauthorized_webhook` on mismatch.
4. **Plaintext Gemini API Key Leakage in Errors**: Added `sanitizeLLMError` in `backend/internal/ai/llm.go` to redact API keys and `?key=` query parameters before logging or persisting `error_message` in `ai_agent_runs` / `ai_invocations`.

### Majors Resolved
5. **`db.RunMigrations` Advisory Lock & Fail-Fast**: Updated `RunMigrations` to use `pg_advisory_lock` + `schema_migrations` and called it fail-fast from both `cmd/api` and `cmd/worker`.
6. **`ai_budgets.monthly_cap_cents` vs `monthly_limit_cents` & Backfill**: Added `ai_invocations` backfill in `000002_bloque2_ai_evolution.up.sql`, kept `monthly_cap_cents` synced within `int32`, and handled `pgx.ErrNoRows` with defaults.
7. **`ChannelsPage` SSE During Support Sessions**: Replaced `EventSource` with `fetch()` + `ReadableStream` (`subscribeSSE`) sending `Authorization` and `X-Support-Session-ID` headers, listening for both `channel.updated` and `channel.deleted`.
8. **`ListAgents` & `CreateAgent` Columns + Tie-Breaking**: Updated `ListAgents`, `CreateAgent`, and `UpdateAgent` (`PATCH /ai/agents/{id}`) for `temperature`, `max_tokens`, `handoff_enabled`; added `ORDER BY updated_at DESC, created_at DESC LIMIT 1` in `RunAgentTurn`.
9. **RBAC (`auth.RequireRole("manager")`)**: Added role checks on credential, budget, agent, memory, knowledge, and channel mutations.
10. **`ai_provider_credentials` `POST` Contract & `MaskAPIKey`**: Ensured `POST` never returns `api_key_encrypted` or plaintext `api_key`, preserves existing secret when `api_key` is omitted on update, and handles short keys (`len <= 8`) safely in `MaskAPIKey`.
11. **`EvolutionWebhook` Edge Cases & `CreateChannel` Rollback**: Added `QRCODE_UPDATED`, `connecting` state, `+` phone prefix preservation, group/broadcast JID filtering (`@g.us`, `status@broadcast`), `CreateChannel` DB rollback on Evolution failure, and clear `ReconnectChannel` semantics.
12. **E2E Compatibility & Worker Error Handling**: Kept RAG accessible in `AIPage.tsx`, specified E2E test flow without breaking Bloque 1, and updated `cmd/worker` to mark `event_log` as `'failed'` on unexpected `RunAgentTurn` errors.

## Round 2 Verification
* **Status:** **CLEAN** (0 Blockers, 0 Majors).
