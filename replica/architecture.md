# Architecture: Clean-Room Decoupled CRM (Go + Postgres + Redis + MinIO + React PWA)

## 1. Stack (Non-Negotiable)

| Layer | Choice | Why |
| --- | --- | --- |
| Backend API | Go 1.27 (`net/http` + `chi` router) | Fast single-binary REST API (`/api/v1/*`), low memory, explicit middleware |
| Realtime | Go SSE/WebSocket Hub + Redis Pub/Sub | Native goroutine fan-out without Supabase Realtime |
| MCP Server | Native Go binary (`cmd/mcp`) | Exposes CRM tools over stdio & HTTP/SSE sharing `internal/` domain & auth |
| Workers | Native Go binary (`cmd/worker`) | Drains `event_log`, runs AI turns, sentiment, stuck-message recovery, LGPD |
| Database | PostgreSQL 16+ (`pgx/v5`) + `pgvector` | ACID transactions, JSONB, vector RAG; `organization_id` enforced in middleware & queries |
| Cache/Queue | Redis 7 | Anti-ban WhatsApp token-bucket rate limiting, pub/sub realtime fan-out |
| Media Storage | MinIO / S3 | Private bucket with signed/proxied media downloads |
| Frontend | React 19 + Vite + TanStack Router + Tailwind + shadcn/ui | Fast decoupled SPA + installable mobile-first PWA |

## 2. Monorepo Structure (`/home/antigravity/crm-go`)

```
crm-go/
  backend/
    cmd/api/          # REST API + SSE/WS + Webhooks
    cmd/mcp/          # Native Go MCP Server
    cmd/worker/       # Background job workers
    internal/         # Shared domain packages (auth, crm, inbox, ai, whatsapp, automation, lgpd, admin, storage, realtime)
    migrations/       # SQL migrations
  frontend/           # React + Vite + TanStack Router + Tailwind + shadcn/ui + PWA
  deploy/             # Dockerfiles, docker-compose.yml, docker-compose.prod.yml, Caddyfile
  replica/            # Recon, differentiation, architecture, design, brand deliverables
```

## 3. REST API Surface (`/api/v1/*`)

### Auth & Tenant
- `POST /api/v1/auth/signup` — Register org + admin user + default sales/support pipelines
- `POST /api/v1/auth/login` — Email/password -> JWT access + `HttpOnly` refresh cookie (or MFA challenge)
- `POST /api/v1/auth/mfa/verify` — Verify TOTP code or recovery code
- `POST /api/v1/auth/refresh` — Rotate refresh cookie -> new JWT
- `POST /api/v1/auth/logout` — Revoke refresh token & clear cookie
- `GET /api/v1/auth/me` — Current user, orgs, role, MFA status
- `POST /api/v1/auth/mfa/setup` & `POST /api/v1/auth/mfa/enable` — TOTP QR & recovery codes

### Contacts & Customer 360°
- `GET /api/v1/contacts`, `POST /api/v1/contacts` (deterministic identity resolution `cpf -> phone -> email` + `merge_queue` on conflict)
- `GET /api/v1/contacts/:id`, `PATCH /api/v1/contacts/:id`
- `GET /api/v1/contacts/:id/timeline` — Polymorphic `crm_lead_activities`
- `GET /api/v1/contacts/merge-queue`, `POST /api/v1/contacts/merge` — Atomic merge transaction

### Pipelines, Stages & Kanban Leads
- `GET /api/v1/pipelines`, `POST /api/v1/pipelines`, `PATCH /api/v1/pipelines/:id`
- `POST /api/v1/pipelines/:id/stages`, `PATCH /api/v1/stages/:id`, `DELETE /api/v1/stages/:id` (422 if has leads)
- `GET /api/v1/leads`, `POST /api/v1/leads`, `GET /api/v1/leads/:id`, `PATCH /api/v1/leads/:id` (fractional index + `version` 409 check)
- `POST /api/v1/leads/bulk` (max 50, else 422)

### Inbox, Conversations, Messages & Realtime
- `GET /api/v1/conversations`, `GET /api/v1/conversations/:id`
- `POST /api/v1/conversations/:id/claim` — Claim & increment `service_revision`
- `POST /api/v1/conversations/:id/resolve` — Resolve/close or hand back to AI
- `GET /api/v1/conversations/:id/messages`, `POST /api/v1/conversations/:id/messages` (chunk >4096, throttle, optimistic)
- `GET /api/v1/templates`, `POST /api/v1/templates`, `DELETE /api/v1/templates/:id`
- `GET /api/v1/realtime/stream` — SSE stream scoped to `organization_id`

### Channels & Webhooks
- `GET /api/v1/channels`, `POST /api/v1/channels`, `GET /api/v1/channels/:id/qr`, `POST /api/v1/channels/:id/reconnect`
- `POST /api/v1/webhooks/waha/:session` — HMAC-SHA512 verified inbound WhatsApp webhook
- `POST /api/v1/webhooks/in/:token` — Inbound lead capture webhook
- `GET /api/v1/automations`, `POST /api/v1/automations`, `PATCH /api/v1/automations/:id`

### AI, RAG, Tasks, Products, LGPD & Settings
- `GET /api/v1/ai/agents`, `POST /api/v1/ai/agents`, `PATCH /api/v1/ai/agents/:id`
- `GET /api/v1/ai/knowledge`, `POST /api/v1/ai/knowledge`, `POST /api/v1/ai/knowledge/search`
- `GET /api/v1/ai/usage` — Monthly spend vs `ai_budgets` cap
- `GET /api/v1/tasks`, `POST /api/v1/tasks`, `PATCH /api/v1/tasks/:id`
- `GET /api/v1/products`, `POST /api/v1/products`
- `GET /api/v1/team`, `POST /api/v1/team/invite`, `PATCH /api/v1/team/:userId`
- `GET /api/v1/api-tokens`, `POST /api/v1/api-tokens`, `DELETE /api/v1/api-tokens/:id`
- `GET /api/v1/audit`, `GET /api/v1/metrics`
- `GET /api/v1/lgpd/requests`, `POST /api/v1/lgpd/requests`, `POST /api/v1/lgpd/requests/:id/execute`
- `GET /api/v1/admin/tenants`, `POST /api/v1/admin/support-sessions`

## 4. Native Go MCP Server Tools (`cmd/mcp`)
Authenticated via `Authorization: Bearer <api_token>` (SHA-256 lookup -> `organization_id`):
1. `search_contacts` — Search contacts by name, phone, email, or CPF
2. `get_customer_360` — Full contact profile, phones, open leads, recent activities
3. `list_conversations` — Filter inbox conversations by status (`open`, `pending`, `ai_handling`, `claimed`)
4. `send_message` — Send WhatsApp/internal message (respects `is_blocked`, `force_human`, and CAS)
5. `move_lead_stage` — Move deal to another stage with fractional index
6. `search_knowledge` — Vector/semantic RAG search over tenant knowledge base
7. `create_task` — Create follow-up task linked to contact/lead

## 5. Vertical Slice Build Order
1. **Slice 1 (Core):** Auth + Multi-tenancy + Contacts (Customer 360°) + Pipelines/Kanban + Realtime Inbox + Mobile-first PWA shell.
2. **Slice 2 (Channels & AI):** WAHA/WhatsApp webhook + anti-ban Redis throttle + Background Workers (`event_log`) + RAG (`pgvector`/cosine) + AI Agent turn & handoff + Native Go MCP Server.
3. **Slice 3 (Remaining Modules):** Tasks, Products, Automations (WHEN/IF/THEN), Team/RBAC, Audit Log, Metrics, LGPD Export/Redact, Platform Admin Support Sessions.
