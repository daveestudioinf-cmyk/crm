# Test plan: KoraCRM

Build: HEAD  Date: 2026-11-20  Env: local (`http://127.0.0.1:5173` -> Go API `http://127.0.0.1:8080`, PostgreSQL 16 + pgvector, Redis 7)

## Flows F01–F08 Test Matrix

| case | flow | type | steps | expected | auto | result |
| --- | --- | --- | --- | --- | --- | --- |
| F01-H1 | F01 First-Run Onboarding (S01–S04, S06) | happy | Open `/get-started`, navigate to `/signup`, enter org/name/email/password, complete `/onboarding` pipeline vocabulary & steps, enter `/app/inbox` | Tenant created, JWT issued, onboarding completed, Inbox rendered in Spanish (`lang="es"`), zero overflow | e2e | |
| F01-E1 | F01 First-Run Onboarding | edge: QR expires after 60s | Start WhatsApp QR step in `/onboarding`, wait for QR TTL | QR auto-refreshes cleanly without 5xx or console error | e2e | |
| F01-E2 | F01 First-Run Onboarding | edge: skip optional steps | Skip WhatsApp QR and Team Invite steps in `/onboarding` | User lands in `/app/inbox` with default pipeline ready | e2e | |
| F01-E3 | F01 First-Run Onboarding | edge: mobile width `390x844` & keyboard navigation | Complete `/signup` and `/onboarding` at `390x844` | Zero horizontal overflow, BottomNav visible in `/app/*`, axe scan passes | e2e | |
| F01-N1 | F01 First-Run Onboarding | negative: invalid AI key or weak password | Submit `/signup` with empty/short password or invalid AI key in `/onboarding` | Inline Spanish validation error, no crash | e2e | |
| F01-N2 | F01 First-Run Onboarding | negative: duplicate email signup | Sign up with an already registered email | `409 Conflict` / clear Spanish error message | e2e | |
| F02-H1 | F02 WhatsApp QR Connection & Health Recovery (S22) | happy | Go to `/app/connections` (or `/app/channels` alias), enter session name, click `Conectar Número`, poll QR, reconnect to `WORKING` | Session transitions `STARTING -> SCAN_QR_CODE -> WORKING`, zero overflow | e2e | |
| F02-E1 | F02 WhatsApp QR Connection | edge: session disconnects (`FAILED`) | Simulate disconnected/failed channel session and open `/app/inbox` | Amber reconnect banner shown in `S06` Inbox; reconnect restores `WORKING` | e2e | |
| F02-E2 | F02 WhatsApp QR Connection | edge: warm-up daily limit update | Adjust `warmup_daily_limit` on `/app/connections` (or `/app/channels` alias) and save | Limit persisted and enforced by anti-ban throttle | e2e | |
| F02-N1 | F02 WhatsApp QR Connection | negative: duplicate session name | Create two sessions with the same `session_name` | `409 Conflict` returned, existing session unaffected | e2e | |
| F03-H1 | F03 Inbound Message -> AI Turn -> Handoff -> Human Resolution (S06, S17, S20, S21) | happy | Receive inbound message -> AI Turn (RAG + MCP) -> Handoff -> Operator claims in `/app/inbox` -> sends reply -> resolves | Conversation claimed with `service_revision` CAS, reply sent, status set to resolved | e2e | |
| F03-E1 | F03 Inbound Message -> Handoff | edge: concurrent claim CAS `409` | Two operators attempt to claim same conversation with stale `service_revision` | First succeeds; stale claim receives `409 Conflict` | e2e | |
| F03-E2 | F03 Inbound Message -> Handoff | edge: >4096 char message & >24h window | Send >4096 char message or open conversation past 24h window | Long message chunked cleanly; 24h window warning/template prompt shown | e2e | |
| F03-E3 | F03 Inbound Message -> Handoff | edge: STOP opt-out & anti-ban | Contact sends STOP or has `is_blocked=true` | Composer and Campaigns block outbound delivery | e2e | |
| F03-N1 | F03 Inbound Message -> Handoff | negative: reply before claim or AI budget 100% | Attempt reply while blocked-until-claimed or AI turn at 100% hard-stop | Composer blocked; AI budget hard-stop triggers handoff without 5xx | e2e | |
| F04-H1 | F04 Kanban Deal Management (S11, S12, S14, S15) | happy | Open `/app/kanban`, create deal, move across stages via fractional index, open `/app/leads/:id`, add task & product | Deal persisted in target stage, realtime sync, zero overflow on desktop & `390x844` mobile stage-tabs | e2e | |
| F04-E1 | F04 Kanban Deal Management | edge: concurrent drag `409` conflict | Update lead with stale `position_in_stage` / version | `409 Conflict` triggers board refetch without data corruption | e2e | |
| F04-E2 | F04 Kanban Deal Management | edge: bulk move >50 leads | `POST /api/v1/leads/bulk` with 51 lead IDs | Rejected with `400`/`422`, no partial silent failure | e2e | |
| F04-E3 | F04 Kanban Deal Management | edge: mobile stage-tabs `390x844` | Switch stage tabs on mobile Kanban with long Unicode/emoji deal titles | Zero horizontal overflow (`scrollWidth <= innerWidth`) | e2e | |
| F04-N1 | F04 Kanban Deal Management | negative: cross-tenant lead access | Tenant B attempts to read/patch Tenant A lead | `403`/`404` returned, Tenant A data invisible | e2e | |
| F05-H1 | F05 Customer 360 Identity Resolution & Merge (S13) | happy | Create/receive contact with matching `cpf`/`phone_e164`/`email`, inspect `merge_queue`, merge side-by-side in `/app/contacts` | Contacts merged atomically; conversations, leads, and timeline repointed | e2e | |
| F05-E1 | F05 Customer 360 Identity Resolution | edge: anonymized tombstone | Anonymized contact receives new inbound message | Tombstone prevents PII re-exposure or silent overwrite | e2e | |
| F05-E2 | F05 Customer 360 Identity Resolution | edge: mobile Customer 360 bottom sheet | Open Customer 360 panel at `390x844` | Renders as bottom sheet with zero horizontal overflow | e2e | |
| F05-N1 | F05 Customer 360 Identity Resolution | negative: invalid CPF or E.164 phone | Submit contact with malformed CPF or non-E.164 phone | `400`/`422` validation error in Spanish | e2e | |
| F06-H1 | F06 Webhook Capture & WHEN/IF/THEN Automation (S23) | happy | Open `/app/webhooks`, create inbound source, create WHEN/IF/THEN rule, fire `POST /api/v1/webhooks/in/:token` | Lead & contact created, `event_log` drained by worker, rule executed and logged | e2e | |
| F06-E1 | F06 Webhook Capture & Automation | edge: `Idempotency-Key` duplicate webhook | Send identical webhook payload twice with same `Idempotency-Key` | Deduplicated cleanly, single lead/event processed | e2e | |
| F06-E2 | F06 Webhook Capture & Automation | edge: outbound webhook failure & retry | Outbound action fails on target endpoint | Failure logged in execution timeline with manual retry option | e2e | |
| F06-N1 | F06 Webhook Capture & Automation | negative: invalid token / malformed JSON / SSRF URL | Post to nonexistent token, invalid JSON, or private metadata IP | `400`/`404`/`422` returned cleanly, zero 5xx | e2e | |
| F07-H1 | F07 LGPD Data Export & Redact (S25) | happy | Open `/app/lgpd/requests`, create `export` and `delete` requests, execute both | Export produces structured JSON; Delete cascades PII anonymization while preserving financial/lead records | e2e | |
| F07-E1 | F07 LGPD Data Export & Redact | edge: double execution / reject flow | Re-execute completed LGPD request or reject pending request | Re-execution idempotent or `409`; rejected request preserves contact PII | e2e | |
| F07-N1 | F07 LGPD Data Export & Redact | negative: cross-tenant LGPD execution | Tenant B attempts to execute Tenant A LGPD request | `403`/`404` returned | e2e | |
| F08-H1 | F08 Platform Admin Support Session (S26, S24) | happy | Super-Admin starts temporary 1h support session for tenant, inspects `/app/*` with top banner, exits session | Read-only banner visible, mutations blocked (`403`), actions recorded in `api_audit_log` | e2e | |
| F08-E1 | F08 Platform Admin Support Session | edge: session TTL expiry | Wait or simulate expired `X-Support-Session-ID` | Session rejected after 1h TTL, no further access | e2e | |
| F08-N1 | F08 Platform Admin Support Session | negative: tenant user accesses `/api/v1/admin/*` or mutates `api_audit_log` | Non-super-admin calls `/api/v1/admin/tenants` or `DELETE /api/v1/audit` | `403`/`405` returned; audit log remains strictly append-only | e2e | |

## Feature Inventory Cross-Reference (42 Active + 2 Out-of-Scope `skip`)

| Feature # | Feature Summary | Status | Covered By Spec / Cases |
| --- | --- | --- | --- |
| #1 | Multi-tenant isolation by `organization_id` | active | `tier1-2-auth-onboarding.spec.ts`, `tier1-2-automation-lgpd-analytics.spec.ts`, `tier3-cross-feature.spec.ts` (`T3-11`, `T3-12`) |
| #2 | Auth in Go (JWT + HttpOnly refresh + TOTP MFA & recovery) | active | `tier1-2-auth-onboarding.spec.ts`, `F01-H1` |
| #3 | 4-role RBAC (`viewer`, `agent`, `manager`, `admin`) + Super-Admin | active | `tier1-2-auth-onboarding.spec.ts`, `F08-N1` |
| #4 | Append-only Audit Log (`api_audit_log`, `S24` `/app/audit`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F4-T1-1`..`F4-T2-5`), `T3-01`, `T3-02`, Scenario 5 |
| #5 | API Tokens (SHA256 Bearer) & `Idempotency-Key` middleware | active | `tier1-2-auth-onboarding.spec.ts`, `T3-09`, `T3-10`, `T3-14` |
| #6 | Audited temporary Platform Support Sessions (`S26`) | active | `tier1-2-auth-onboarding.spec.ts`, `T3-01`, `F08-H1`, Scenario 5 |
| #7 | Guided tenant onboarding wizard (`S04` `/onboarding/*`) | active | `tier1-2-auth-onboarding.spec.ts`, `F01-H1`, Scenario 1 |
| #8 | Canonical contacts & deterministic identity resolution | active | `tier1-2-contacts-c360.spec.ts`, `T3-03`, `F05-H1`, Scenario 3 |
| #9 | Merge queue & side-by-side contact merge UI (`S13`) | active | `tier1-2-contacts-c360.spec.ts`, `T3-03`, `F05-H1`, Scenario 3 |
| #10 | Polymorphic event-sourced timeline (`crm_lead_activities`) | active | `tier1-2-contacts-c360.spec.ts`, `T3-07` |
| #11 | Configurable pipeline vocabulary & declarative custom fields | active | `tier1-2-contacts-c360.spec.ts`, Scenario 1 |
| #12 | Multi-number WhatsApp QR pairing & Evolution Go lifecycle (`S22`) | active | `tier1-2-whatsapp-inbox.spec.ts`, `F02-H1`, Scenario 2 |
| #13 | HMAC-SHA512 / secret inbound webhook receiver + idempotency | active | `tier1-2-whatsapp-inbox.spec.ts`, `F06-E1` |
| #14 | Optimistic outbound send + >4096 char chunking | active | `tier1-2-whatsapp-inbox.spec.ts`, `F03-E2` |
| #15 | Anti-ban defenses (throttle, jitter, business-hours, warm-up, STOP) | active | `tier1-2-whatsapp-inbox.spec.ts`, `T3-06`, `F38-T2-2` |
| #16 | Media persistence via MinIO/S3 + signed/proxied URLs | active | `tier1-2-whatsapp-inbox.spec.ts` |
| #17 | Meta Cloud API official channel + HSM template sync | active | `tier1-2-whatsapp-inbox.spec.ts` |
| #18 | Unified Go SSE Realtime Hub with Redis pub/sub fan-out | active | `tier1-2-whatsapp-inbox.spec.ts`, `T3-04`, `T3-05` |
| #19 | 3-column real-time Inbox desktop + mobile sheet (`S06`) | active | `tier1-2-whatsapp-inbox.spec.ts`, `F41-T1-3`, Scenario 2 |
| #20 | Conversation lifecycle + CAS `service_revision` | active | `tier1-2-whatsapp-inbox.spec.ts`, `T3-04`, `F03-E1` |
| #21 | Quick replies (`/`), internal notes, 24h window & block-until-claimed | active | `tier1-2-whatsapp-inbox.spec.ts`, `F03-N1` |
| #22 | Round-robin auto-routing, transfer/claim, team availability | active | `tier1-2-whatsapp-inbox.spec.ts` |
| #23 | Radar (cooling open conversations `S07`) | active | `tier1-2-whatsapp-inbox.spec.ts` |
| #24 | Multi-pipeline Kanban board with fractional indexing & bulk actions (`S11`) | active | `tier1-2-crm-pipeline.spec.ts`, `T3-08`, `F04-H1`, Scenario 3 |
| #25 | Tickets in Support pipeline & cross-lead linking (`S12`) | active | `tier1-2-crm-pipeline.spec.ts`, `T3-08` |
| #26 | Tasks with due dates, recurrence & Task Plans (`S14`) | active | `tier1-2-crm-pipeline.spec.ts`, Scenario 3 |
| #27 | Product catalog UI & CRUD (`S15`) | active | `tier1-2-crm-pipeline.spec.ts`, `T3-13` |
| #28 | Tenant-isolated AI Agents (`S17`) | active | `tier1-2-ai-rag-mcp.spec.ts`, Scenario 2 |
| #29 | Multi-source tenant RAG (FAQ, PDF/MD, catalog) (`S20`) | active | `tier1-2-ai-rag-mcp.spec.ts`, `T3-12`, `T3-13` |
| #30 | Async sentiment analysis + 4-trigger Handoff | active | `tier1-2-ai-rag-mcp.spec.ts`, `F03-H1` |
| #31 | LLM call logging, monthly org budget caps & multi-provider (`S19`) | active | `tier1-2-ai-rag-mcp.spec.ts`, `T3-09` |
| #32 | Native Go MCP Server exposing 7 CRM tools | active | `tier1-2-ai-rag-mcp.spec.ts`, `T3-09`, `T3-10` |
| #33 | AI Cases, Central Alerts (`S21`), Org Memory, Skills & Follow-ups (`S18`) | active | `tier1-2-ai-rag-mcp.spec.ts` |
| #34 | Event log queue + background Go workers (`event-drain`, `recover-stuck`, `sync-sessions`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F34-T1-1`..`F34-T2-5`), `F06-H1` |
| #35 | Inbound webhook lead capture + WHEN/IF/THEN automation builder + retry (`S23`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F35-T1-1`..`F35-T2-5`), `T3-03`, Scenario 4 |
| #36 | LGPD granular consent, export JSON & cascade anonymization (`S25`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F36-T1-1`..`F36-T2-5`), `T3-07`, Scenario 5 |
| #37 | Performance dashboard & Activities (`S24` `/app/metrics`, `/app/activities`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F37-T1-1`..`F37-T2-5`) |
| #38 | WhatsApp Campaigns (throttled anti-ban) (`S16`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F38-T1-1`..`F38-T2-5`), `T3-06` |
| #39 | Agenda & Waitlist module (`S08`) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F39-T1-1`..`F39-T2-5`) |
| #40 | Installable PWA (`manifest.webmanifest`, `sw.js`, `BottomNav`, offline shell) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F40-T1-1`..`F40-T2-5`) |
| #41 | Mobile-first Kanban stage-tabs & Customer 360 bottom sheet (`390x844` zero overflow) | active | `tier1-2-automation-lgpd-analytics.spec.ts` (`F41-T1-1`..`F41-T2-5`), `T3-08` |
| #42 | Legal & Status pages (`S05`: `/legal/*`, `/403`, `/500`, `/oauth/mcp/consent`) & CRM Hub (`S10`) | active | `tier1-2-auth-onboarding.spec.ts`, `tier1-2-crm-pipeline.spec.ts` |
| #43 | Voice/VoIP SIP Trunking & WebRTC (WaCalls/Asterisk) | `skip` (out of scope) | Excluded per `PROJECT.md` & `replica/recon-map.md` |
| #44 | Proprietary Brazilian ERPs (Amigo Clinic, Nuvemshop, HostGator) | `skip` (out of scope) | Excluded per `PROJECT.md` & `replica/recon-map.md` |
