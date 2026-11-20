# TEST_INFRA.md — KoraCRM Opaque-Box E2E Test Architecture

## 1. Philosophy & Scope
This document defines the **opaque-box, requirement-driven E2E test architecture** for **KoraCRM** (`frontend/tests/`), derived strictly from:
- `PROJECT.md` (§ Architecture, § Feature Inventory, § Interface Contracts)
- `replica/recon-map.md` (Screens `S01`–`S26`, Flows `F01`–`F08`)
- `replica/features.csv` (44 features: **42 active**, 2 `skip` out-of-scope: #43 Voice/VoIP SIP/WebRTC, #44 Proprietary Brazilian ERPs)
- `replica-test` & `replica-diff` skills

Tests treat the application as an opaque box:
- **UI interactions** use accessible roles, labels, headings, and Spanish copy (`getByRole`, `getByPlaceholder`, `getByLabel`, `getByText`) rather than brittle CSS class selectors.
- **API & Webhook verification** uses the documented `/api/v1/*` REST + SSE contracts (`Authorization: Bearer`, `X-Organization-ID`, `X-Support-Session-ID`, `Idempotency-Key`).
- **Every spec enforces**:
  1. Zero uncaught `console.error` events.
  2. Zero HTTP `>= 500` responses.
  3. Zero horizontal overflow (`document.documentElement.scrollWidth <= window.innerWidth`) on both **Desktop (`1280x800`)** and **Mobile (`390x844`)**.
  4. Spanish UI (`<html lang="es">`) and **KoraCRM** brand integrity (zero `Deskcomm`, `Supabase`, or `#006bff` leaks).
  5. Accessibility audit via `@axe-core/playwright` (`violations` check on key screens).

---

## 2. Environment & Execution
- **Runner**: `@playwright/test` (`frontend/playwright.config.ts`)
- **Projects**:
  - `desktop`: `1280x800`
  - `mobile`: `390x844` (with `hasTouch: true`)
- **Target URL**: `BASE_URL` (default `http://127.0.0.1:5173`, proxying `/api` and `/healthz` to Go API `http://127.0.0.1:8080`).
- **Commands**:
  - Discover tests: `cd frontend && npx playwright test --list`
  - Typecheck tests: `cd frontend && npx tsc --noEmit` (or `npx tsc -p tsconfig.tests.json --noEmit`)
  - Run full suite: `cd frontend && npm run test:e2e`

---

## 3. 4-Tier Test Methodology

### Tier 1 — Feature Coverage (`>= 5` tests per active feature)
Every one of the **42 active features** in `PROJECT.md § Feature Inventory` (excluding #43 and #44 marked `skip`) has at least 5 dedicated verification cases covering happy-path rendering, CRUD/state transitions, API contract behavior, Spanish UI copy, and responsive desktop/mobile layout.

### Tier 2 — Boundary & Corner Cases (`>= 5` tests per active feature)
Every active feature is tested against boundary and negative conditions:
- Empty inputs, whitespace-only, max-length / >4096 char payloads, Unicode/emoji/accents (`áéíóúñ🚀`).
- Double-submit / `Idempotency-Key` deduplication.
- Optimistic concurrency `409 Conflict` (`service_revision` CAS on Inbox, `position_in_stage` on Kanban).
- RBAC `403 Forbidden` (viewer/agent/manager/admin, `support_readonly` mutation block), invalid/expired tokens (`401`), invalid CPF/E.164/email validation (`400`/`422`).
- Multi-tenant cross-org isolation (Tenant B cannot read/mutate Tenant A resources).

### Tier 3 — Cross-Feature Combinations (Pairwise Coverage)
Tests realistic pairwise interactions between subsystems (`frontend/tests/tier3-cross-feature.spec.ts`):
- Support Session (`S26`) × Inbox mutation (`403`) × Audit Log (`S24`).
- Inbound Webhook (`S23`) × Identity Resolution & Merge Queue (`S13`) × WHEN/IF/THEN Automation.
- AI Handoff (`S17`/`S21`) × Inbox Claim CAS (`S06`) × SSE Realtime (`subscribeSSE`).
- Anti-ban STOP opt-out × WhatsApp Campaigns (`S16`) × Inbox Composer block (`S06`).
- LGPD Cascade Anonymization (`S25`) × Customer 360° Timeline (`S13`) × Financial/Order preservation.
- Kanban Bulk Move (`S11`) × Support Ticket Cross-Lead Linking (`S12`) × Mobile Stage-Tabs (`390x844`).
- API Token (`S25`) × Go MCP Server (`POST /api/v1/mcp`) × AI Budget Cap 100% (`S19`).

### Tier 4 — Real-World Application Scenarios (`>= 5` end-to-end workflows)
Full user journeys mapped to `replica/recon-map.md` Flows `F01`–`F08` (`frontend/tests/tier4-real-world-scenarios.spec.ts`):
1. **Scenario 1 (`F01`)**: New Tenant Signup → Guided Onboarding Wizard (`S04`) → Pipeline Vocabulary → Inbox (`S06`).
2. **Scenario 2 (`F02` + `F03`)**: WhatsApp Channel QR Lifecycle (`S22`) → Inbound Webhook → AI Turn → Handoff → Operator Claim & Reply → Resolve (`S06`).
3. **Scenario 3 (`F04` + `F05`)**: Duplicate Contact Detection → Merge Queue Atomic Repoint (`S13`) → Kanban Drag-and-Drop (`S11`) → Lead Detail Cross-Link & Task (`S12`/`S14`).
4. **Scenario 4 (`F06`)**: Inbound Webhook Source → Test Lead → WHEN/IF/THEN Rule Builder (`S23`) → Automated Tag/Stage Execution.
5. **Scenario 5 (`F07` + `F08`)**: Platform Super-Admin Support Session (`S26`) → Read-Only Inspection → Exit → Tenant Admin LGPD Export & Cascade Redact (`S25`) → Immutable Audit Verification (`S24`).

---

## 4. Feature-to-Spec Mapping (42 Active Features)
| Feature IDs | Domain | Spec File |
|---|---|---|
| #1, #2, #3, #5, #6, #7, #42 | Auth, RBAC, Onboarding, Legal/Status, Support Sessions | `tier1-2-auth-onboarding.spec.ts` |
| #8, #9, #10, #11 | Contacts, Merge Queue, Timeline, Pipeline Vocabulary | `tier1-2-contacts-c360.spec.ts` |
| #12–#23 | WhatsApp, Webhooks, Anti-ban, Media, SSE, Inbox, Quick Replies, Routing, Radar | `tier1-2-whatsapp-inbox.spec.ts` |
| #24, #25, #26, #27 | Kanban, Support Tickets/Links, Tasks & Plans, Product Catalog | `tier1-2-crm-pipeline.spec.ts` |
| #28–#33 | AI Agents, RAG, Sentiment/Handoff, Usage/Budgets, MCP, Cases/Memory/Follow-ups | `tier1-2-ai-rag-mcp.spec.ts` |
| #4, #34–#41 | Audit Log, Worker/Event Log, Automations, LGPD, Metrics, Campaigns, Agenda, PWA, Mobile | `tier1-2-automation-lgpd-analytics.spec.ts` |
| Pairwise | Cross-Feature Combinations | `tier3-cross-feature.spec.ts` |
| F01–F08 | Real-World End-to-End Scenarios | `tier4-real-world-scenarios.spec.ts` |
