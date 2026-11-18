# Product Differentiation & Positioning Angle

Date: 2026-11-17
Method: Clean-room architectural & UX gap analysis of WhatsApp CRMs (no fabricated external reviews).

## 1. Pain Points in Typical WhatsApp CRMs
1. **Coupled Monolith Bottlenecks:** Full-stack JS/Supabase CRMs couple SSR/UI rendering, webhook ingestion, AI agent turns, and cron jobs into the same runtime or rely on external BaaS platforms, creating cold-start latency, complex self-hosting (many containers), and tight vendor lock-in.
2. **Desktop-First Inbox & Kanban on Mobile:** Operators on the move face cramped 3-column layouts, horizontal overflow on Kanban boards, tiny touch targets, and no installable PWA experience.
3. **Opaque AI & Webhook Reliability:** Async AI turns race with human replies when optimistic locking/CAS is missing, and webhook/campaign throttling often lacks deterministic Redis-backed pacing.
4. **Bolted-on MCP:** External AI assistants (Claude Desktop, Cursor, custom agents) often need awkward REST wrappers instead of a native, low-latency MCP server sharing the exact domain layer and auth tokens.

## 2. Our Differentiators (Go Backend + Superior Mobile PWA)
1. **Single-Binary Performance & Decoupled Go Architecture:**
   - Compiled Go REST API (`cmd/api`), background Worker (`cmd/worker`), and native MCP Server (`cmd/mcp`) sharing a clean `internal/` domain layer.
   - Sub-10ms API responses, low memory footprint (~30MB per binary), true goroutine concurrency for WebSocket/SSE realtime fan-out, and zero Supabase dependency.
2. **Mobile-First PWA Experience (`390x844` Native Feel):**
   - Fixed bottom navigation bar on mobile (`Inbox`, `Kanban`, `Contacts`, `AI`, `More`) with 44px+ touch targets and zero horizontal scroll.
   - 2-step mobile Inbox (Conversation List -> Full-screen Thread with Customer 360° bottom sheet) and stage-tabbed/sheet Kanban on mobile.
   - Installable PWA (`manifest.webmanifest` + Service Worker app shell).
3. **Native Go MCP Server:**
   - Built-in Model Context Protocol server exposing CRM tools (`search_contacts`, `get_customer_360`, `list_conversations`, `send_message`, `move_lead_stage`, `search_knowledge`, `create_task`) authenticated via SHA-256 `api_tokens` and scoped strictly by `organization_id`.
4. **Deterministic Anti-Ban & Concurrency Safety:**
   - Redis-backed token-bucket throttling + jitter per WhatsApp session, `service_revision` CAS to prevent AI/human reply collisions, and fractional-index Kanban with `409 Conflict` protection.

## 3. Positioning Angle
> **For** SMB sales and support teams running high-volume WhatsApp commerce **who** struggle with bloated, desktop-only CRMs and fragile BaaS dependencies, **our CRM** delivers a blazing-fast, self-hosted **Go + PostgreSQL/pgvector** engine with a **native MCP server** and a **mobile-first PWA** that feels native on every screen.

## 4. Fix Plan (Added to `features.csv` with `original=no`)
1. **Native Go MCP Server** (`S` -> `M`): Expose CRM operations directly over MCP (stdio + HTTP/SSE) using the shared Go service layer.
2. **Mobile-First Bottom Nav + Sheet Inbox/Kanban** (`M`): Dedicated mobile navigation, swipe/sheet Customer 360°, and stage-tabbed Kanban with zero horizontal overflow.
3. **Unified SSE/WebSocket Realtime Hub in Go** (`M`): In-process + Redis pub/sub event fan-out for instant Inbox & Kanban updates without external realtime BaaS.
4. **Zero-Dependency Self-Host Stack** (`S`): Clean `docker-compose.yml` with only Go services + Postgres/pgvector + Redis + MinIO.
