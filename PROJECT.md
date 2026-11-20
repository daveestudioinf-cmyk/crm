# Project: KoraCRM — Full CRM Completion

## Architecture
- **Backend (`backend/`)**: Go 1.27 (`net/http` + `chi/v5`), `pgx/v5` + `pgvector` (PostgreSQL 16+), Redis 7, MinIO/S3, Evolution Go / WAHA.
  - `backend/cmd/api/main.go`: HTTP REST API + SSE `/api/v1/realtime/stream` + HTTP MCP `/api/v1/mcp`.
  - `backend/cmd/worker/main.go`: Background worker draining `event_log` (`FOR UPDATE SKIP LOCKED`), executing `ai.turn`, WHEN/IF/THEN `automation_rules`, follow-up flows, anti-ban campaigns, async sentiment analysis, stuck recovery, and session sync.
  - `backend/cmd/mcp/main.go`: Stdio MCP server (7 CRM tools).
  - `backend/migrations/`: Sequential SQL migrations (`000001`..`000005`).
- **Frontend (`frontend/`)**: React 19 + Vite 8 + TanStack Router + Tailwind CSS v4 PWA in Spanish (`lang="es"`), Deep Teal (`#0f766e`) design tokens (`frontend/src/index.css`), zero raw hex/px values, mobile-first (`390x844` zero horizontal overflow + `BottomNav`).
- **E2E Tests (`frontend/tests/` / `e2e/`)**: Playwright (`1280x800` desktop + `390x844` mobile) + `@axe-core/playwright` + `replica/features.csv` parity check.

## Code Layout
- `backend/cmd/api/main.go` — Router & middleware wiring
- `backend/cmd/worker/main.go` — Background job loop
- `backend/internal/auth/` — Auth, JWT, MFA, RBAC, Team invites, Org settings, Idempotency
- `backend/internal/admin/` — Super-Admin console & support sessions (Bloque 1, done)
- `backend/internal/ai/` — Multi-provider LLM, RAG, memory, budgets, follow-ups, routers, cases
- `backend/internal/whatsapp/` — Evolution Go / WAHA lifecycle, webhooks, throttle
- `backend/internal/inbox/` — Conversations, messages, templates, radar, media
- `backend/internal/crm/` — Contacts, merge queue, pipelines, stages, leads, tasks, products, agenda
- `backend/internal/automation/` — Webhooks, WHEN/IF/THEN rules, campaigns, LGPD, audit, metrics
- `backend/internal/realtime/` — SSE hub + Redis pub/sub
- `backend/internal/mcpserver/` — MCP tool handlers
- `backend/migrations/` — `000001` (done), `000002` (done), `000003` (M3), `000004` (M4), `000005` (M5)
- `frontend/src/App.tsx` — TanStack Router route definitions & AuthContext
- `frontend/src/lib/api.ts` — `apiFetch`, token refresh, `X-Support-Session-ID`, `subscribeSSE`
- `frontend/src/components/shell/AppShell.tsx` — Desktop sidebar, mobile bottom nav, support banner
- `frontend/src/components/ui/primitives.tsx` — Token-based UI primitives (`Button`, `Input`, `Card`, `Badge`, `Sheet`)
- `frontend/src/pages/` — Modular page components per screen (`S01`–`S26`)

## Feature Inventory
All 44 features from `replica/features.csv` (cross-referenced with `replica/recon-map.md`):

| # | Feature | Priority | Milestone | Source |
|---|---------|----------|-----------|--------|
| 1 | Multi-tenant isolation by `organization_id` in Go middleware & SQL | must | Done (Bloque 1) + M6 verify | `features.csv` |
| 2 | Auth in Go with JWT + HttpOnly refresh + TOTP MFA & recovery codes | must | M1 (`S02` sub-routes + recovery) | `features.csv` |
| 3 | 4-role RBAC (`viewer`, `agent`, `manager`, `admin`) + Platform Super-Admin | must | M1 (`S03` invite accept + `S25` team) | `features.csv` |
| 4 | Append-only Audit Log for all mutations (`api_audit_log`) | must | M4 (`S24` `/app/audit` filters) | `features.csv` |
| 5 | API Tokens (SHA256 Bearer) & `Idempotency-Key` middleware | must | M1 (`Idempotency-Key` + `S25` tokens) | `features.csv` |
| 6 | Audited temporary Platform Support Sessions (`S26`) | should | Done (Bloque 1) | `features.csv` |
| 7 | Guided tenant onboarding wizard (`S04` `/onboarding/*`) | must | M1 | `features.csv` |
| 8 | Canonical contacts (E.164, email, CPF, deterministic identity resolution) | must | M2 (`S13` CPF/multi-phone/edit) | `features.csv` |
| 9 | Merge queue & side-by-side contact merge UI with atomic repointing | must | M2 (`S13` `MergeDialog` + dismiss + full repoint) | `features.csv` |
| 10 | Polymorphic event-sourced timeline (`crm_lead_activities`) | must | M2 (`S13`) & M3 (`S12`) | `features.csv` |
| 11 | Configurable pipeline vocabulary & declarative custom fields | must | M1 (`S04`/`S25`) & M3 (`S11`/`S12`) | `features.csv` |
| 12 | Multi-number WhatsApp QR pairing & Evolution Go lifecycle (`S22`) | must | Done (Bloque 2) | `features.csv` |
| 13 | HMAC-SHA512 / secret inbound webhook receiver + idempotency | must | Done (Bloque 2) | `features.csv` |
| 14 | Optimistic outbound send + >4096 char chunking | must | Done (Bloque 2) + M2 polish | `features.csv` |
| 15 | Anti-ban defenses (Redis throttle, jitter, business-hours, warm-up, STOP) | must | M2 (enforce in Inbox) + M5 (Campaigns) | `features.csv` |
| 16 | Media persistence via MinIO/S3 + signed/proxied URLs | must | M2 | `features.csv` |
| 17 | Meta Cloud API official channel + HSM template sync | should | M5 (or M2 adapter if time permits) | `features.csv` |
| 18 | Unified Go SSE Realtime Hub with Redis pub/sub fan-out | must | Done (Bloque 2) + M2 (`S06` reconnect banner) | `features.csv` |
| 19 | 3-column real-time Inbox desktop + mobile sheet (`S06` `/app/inbox/:id`) | must | M2 | `features.csv` |
| 20 | Conversation lifecycle + CAS `service_revision` | must | M2 | `features.csv` |
| 21 | Quick replies (`/`), internal notes, file attach, 24h window & block-until-claimed | must | M2 (`S06` + `S09` `/app/templates`) | `features.csv` |
| 22 | Round-robin auto-routing, manual transfer/claim, team availability & capacity | must | M1 (team availability) + M2 (routing/transfer) | `features.csv` |
| 23 | Radar (cooling open conversations `S07`) | should | M2 | `features.csv` |
| 24 | Multi-pipeline Kanban board with fractional indexing & bulk actions (`S11`) | must | M3 | `features.csv` |
| 25 | Tickets in Support pipeline & cross-lead linking (`crm_lead_links`, `S12`) | must | M3 | `features.csv` |
| 26 | Tasks with due dates, recurrence & Task Plans (`S14`) | should | M3 | `features.csv` |
| 27 | Product catalog UI & CRUD (`S15`) | should | M3 | `features.csv` |
| 28 | Tenant-isolated AI Agents (`S17`) | must | Done (Bloque 2) + M4 (`DELETE` + sub-routes) | `features.csv` |
| 29 | Multi-source tenant RAG (FAQ, PDF/MD, catalog) (`S20`) | must | Done (Bloque 2) + M4 (sub-routes/PDF) | `features.csv` |
| 30 | Async sentiment analysis + 4-trigger Handoff | must | M4 (`cmd/worker` sentiment) | `features.csv` |
| 31 | LLM call logging, monthly org budget caps & multi-provider config (`S19`) | must | Done (Bloque 2) + M4 (`UsageChart`) | `features.csv` |
| 32 | Native Go MCP Server exposing 7 CRM tools | must | Done (Bloque 1/2) | `features.csv` |
| 33 | AI Cases, Central Alerts (`S21`), Org Memory, Skills & Follow-ups (`S18`) | should | M4 | `features.csv` |
| 34 | Event log queue + background Go workers (`event-drain`, `recover-stuck`, `sync-sessions`) | must | M4 | `features.csv` |
| 35 | Inbound webhook lead capture + WHEN/IF/THEN automation builder + retry (`S23`) | must | M4 | `features.csv` |
| 36 | LGPD granular consent, export & cascade anonymization (`S25`) | must | M1 (`S25` `/app/lgpd/requests`) | `features.csv` |
| 37 | Performance dashboard (funnel, sales goals, attendant metrics) & Activities (`S24`) | should | M4 | `features.csv` |
| 38 | WhatsApp Campaigns (throttled anti-ban) (`S16`) | could | M5 | `features.csv` |
| 39 | Agenda & Waitlist module (`S08`) | could | M5 | `features.csv` |
| 40 | Installable PWA with mobile bottom nav & offline shell | must | M5 (verify/polish) + M6 E2E | `features.csv` |
| 41 | Mobile-first Kanban stage-tabs & Customer 360 bottom sheet (zero overflow) | must | M2/M3 + M6 E2E | `features.csv` |
| 42 | Legal & Status pages (`S05`: `/legal/*`, `/403`, `/500`, `/oauth/mcp/consent`) & CRM Hub (`S10`) | must/should | M1 (`S05`), M3 (`S10`) | `recon-map.md` |
| 43 | Voice/VoIP SIP Trunking & WebRTC (WaCalls/Asterisk) | skip | Out of scope (`skip`) | `features.csv` |
| 44 | Proprietary Brazilian ERPs (Amigo Clinic, Nuvemshop, HostGator) | skip | Out of scope (`skip`) | `features.csv` |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Auth, Team, Onboarding & Legal/Settings | `S01` (`/get-started`), `S02` (forgot/reset/mfa/recovery), `S03` (`/team/accept-invite/:token`), `S04` (`/onboarding/*`), `S05` (legal/403/500/mcp consent), `S25` (MFA setup, team CRUD, API tokens, org settings, LGPD), `Idempotency-Key` middleware | none | DONE (Gate PASSED Iter 3) |
| M2 | Inbox Polish, Quick Replies & Customer 360° | `S06` (`/app/inbox/:id`, CAS claim, transfer/auto-route, 24h window, throttle/hours, MinIO media, notes, reconnect banner), `S07` (Radar polish), `S09` (`/app/templates` CRUD), `S13` (`/app/contacts/:id`, CPF, multi-phone, anonymize, merge dismiss & full repoint) | M1 | DONE (Gate PASSED Iter 2) |
| M3 | CRM Hub, Funnels, Lead Detail, Tasks & Products | Migration `000003` (`crm_lead_links`), `S10` (`/app/crm`), `S11` (`/app/pipelines/:id`, pipeline/stage CRUD, fractional index, 409, bulk bar), `S12` (`/app/leads/:id`, links, activities), `S14` (`due_at`/`recurrence`/delete), `S15` (`/app/products` full CRUD) | M2 | DONE (Gate PASSED Iter 2) |
| M4 | Automations Engine, AI Extensions & Analytics | Migration `000004` (`automation_rule_runs`, `followup_flows`, `agent_cases`, `agent_inbox_items`), `cmd/worker` (WHEN/IF/THEN, follow-ups, sentiment, recover-stuck, sync-sessions), `S23` (`RuleBuilder`, `ExecutionTimeline`, `TestLeadButton`), `S18` (`/app/ai/followups`, `routers`), `S21` (`/app/ai/cases`, `inbox`), `S17`/`S19`/`S20` sub-routes, `S24` (`/app/activities`, `/app/audit`, `FunnelChart`, `AttendantMetricsTable`) | M3 | DONE (Gate PASSED Iter 2) |
| M5 | Campaigns, Agenda & Brand/PWA Polish | Migration `000005` (`campaigns`, `campaign_recipients`, `appointments`, `waitlist_entries`), `S16` (`/app/campaigns` + worker anti-ban sender), `S08` (`/app/agenda` + waitlist), brand sweep (zero `Deskcomm`/`Supabase`/`#006bff`), Spanish copy & mobile `390x844` overflow polish, `features.csv` update | M4 | DONE (Gate PASSED Iter 3) |
| E2E | E2E Testing Track (Parallel) | `TEST_INFRA.md` + Playwright opaque-box E2E suite (Tiers 1–4) + `@axe-core/playwright` + `TEST_READY.md` | none (parallel) | DONE (`TEST_READY.md`, 880 Playwright tests across desktop/mobile) |
| M6 | Final Milestone: E2E Pass & Tier 5 Hardening | Phase 1: Pass 100% of E2E Tiers 1–4; Phase 2: Tier 5 adversarial coverage hardening + `replica-diff` parity check (`>= 80`, all `must` done, zero S1/S2) + whole-project Forensic Audit | M5 + E2E (`TEST_READY.md`) | IN_PROGRESS |

## Interface Contracts
### Backend REST API (`/api/v1/*`) ↔ Frontend (`frontend/src/lib/api.ts`)
- All tenant endpoints require `Authorization: Bearer <jwt|crm_token>`, optional `X-Organization-ID`, optional `X-Support-Session-ID` (readonly blocks mutations with `403`).
- Standard JSON error shape: `{ "error": "<code_or_message>" }`.
- `Idempotency-Key` header supported on POST/PATCH/PUT mutations via `idempotency_keys` table.
- SSE `/api/v1/realtime/stream` emits `{ type, payload }` events for `message.created`, `conversation.updated`, `channel.updated`, `lead.updated`, `automation.executed`, `ai.case_created`.

### Worker (`cmd/worker`) ↔ Event Log (`event_log`)
- Event types: `ai.turn`, `automation.evaluate`, `sentiment.analyze`, `followup.dispatch`, `campaign.send`.
- Worker claims rows via `FOR UPDATE SKIP LOCKED`, skips suspended orgs, retries with exponential backoff up to `max_attempts`, and records `automation_rule_runs` for rule executions.
