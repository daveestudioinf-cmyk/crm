# Recon map: DeskcommCRM (Web + Mobile PWA)

Scope: Full clean-room functional & UX replication of DeskcommCRM's AI Sales OS, WhatsApp Inbox, Customer 360°, Multi-Niche Kanban, RAG/AI Agents, Automation/Webhooks, LGPD compliance, and MCP Server — re-architected on a decoupled Go + PostgreSQL/pgvector + Redis + MinIO + React/Vite PWA stack.
For: SMBs and sales/support teams operating conversational commerce over WhatsApp.
Date: 2026-11-17

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Reference Repo | https://github.com/melgarafael/DeskcommCRM | Clean-room study of ARCHITECTURE.md, README.es.md, VISION.md, docs/prd/, docs/specs/, and route catalog |

## Core loop

1. **Connect Channel:** Tenant pairs WhatsApp via QR code (WAHA Plus NOWEB) or Meta Cloud API, or receives leads via inbound webhooks.
2. **Inbound & Identity Resolution:** Message arrives -> HMAC verified -> idempotency check -> deterministic identity resolution (`cpf` -> `phone_e164` -> `email`, or `merge_queue` on conflict) -> `contact` + `conversation` + `crm_lead` + `crm_lead_activities` timeline updated.
3. **AI Turn & Governance:** AI agent (with tenant-isolated RAG, org memory, skills, and MCP tools) evaluates intent, responds, qualifies, updates pipeline stage/tags, or triggers **Handoff** (explicit human request, low sentiment, AI uncertainty/guardrail, or critical stage).
4. **Human Collaboration (3-Column Inbox + Kanban):** Human operator sees Fila/Inbox, claims conversation, views Customer 360° side panel, replies with optimistic UI / quick replies, and resolves or closes the demand.
5. **Retention & Flywheel:** Radar catches cooling conversations; automated Follow-ups re-engage; resolved conversations feed back into RAG / improvement proposals.

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Landing / Entry | `/` & `/get-started` | Product entry point and CTA to login/signup | Hero, CTA, FeatureCards | Logged-out, Redirecting |
| S02 | Login & Recovery | `/login`, `/login/forgot`, `/login/reset`, `/login/mfa`, `/login/recovery` | Email/password auth, optional TOTP MFA, recovery codes, password reset | AuthForm, MfaChallengeForm, RecoveryCodeInput | Idle, Submitting, Error, MfaRequired |
| S03 | Signup & Team Invite | `/signup`, `/team/accept-invite/:token` | New org registration or accepting team invite | SignupForm, InviteAcceptCard | ValidToken, Expired, Submitting |
| S04 | Onboarding Wizard | `/onboarding/*` | Guided first-run setup: pipeline vocabulary, WhatsApp QR, AI setup, team invite | Stepper, QrScannerPoll, PipelineTemplatePicker, AiSetupForm | Step-by-step, PollingQR, Connected, Skipped |
| S05 | Legal & Status Pages | `/legal/privacy`, `/legal/terms`, `/403`, `/500`, `/oauth/mcp/consent` | Privacy/terms, access/error states, MCP OAuth consent | ErrorBoundaryCard, ConsentPrompt | Static, ConsentPending |
| S06 | Inbox (3-Column / Mobile Sheet) | `/app/inbox`, `/app/inbox/:id` | Primary operator workspace: AI & human side-by-side WhatsApp chat | ConversationList, InboxFilters, ChatThread, Composer, CRMSidePanel | Empty, Loading, Open/AI/Fila/Pending/Closed, ReconnectingBanner, BlockedUntilClaimed, 24hWindowExpired |
| S07 | Radar | `/app/radar` | Conversations cooling down / at risk without reply | CoolingLeadsTable, UrgencyBadges, QuickClaimAction | Empty, Populated, Filtered |
| S08 | Agenda & Waitlist | `/app/agenda` | Daily appointments & waitlist queue (optional module) | CalendarView, AppointmentModal, WaitlistQueue | Loading, Empty, Day/Week |
| S09 | Quick Replies | `/app/templates` | Saved agent/team message scripts consumed in Inbox Composer | TemplateList, TemplateEditorDialog, CategoryFilter | Empty, List, Editing |
| S10 | CRM Hub | `/app/crm` | Hub linking to all CRM & commercial screens | HubSectionGrid, DestinationCards | Role-filtered |
| S11 | Funnels (Kanban Board) | `/app/kanban`, `/app/pipelines/:id` | Visual deal/ticket pipeline with fractional-index drag-and-drop | PipelineSwitcher, KanbanBoard, StageColumn, LeadCard, BulkActionBar | Loading, Dragging, OptimisticUpdate, Conflict409, Empty |
| S12 | Lead / Deal Detail | `/app/leads/:id` | Full deal view, custom fields, stage history, linked records, attachments | LeadHeader, CustomFieldsEditor, TimelineView, AttachmentsList | Loading, Open/Won/Lost, Editing |
| S13 | Contacts & Customer 360° | `/app/contacts`, `/app/contacts/:id` | Customer 360° directory, merge queue, anonymization, multi-phone | ContactsTable, NewContactDialog, MergeDialog, AnonymizeDialog, TimelineView | Empty, Filtered, BulkSelect, MergeConflict, Anonymized |
| S14 | Tasks & Plans | `/app/tasks` | Assigned tasks with due dates/recurrence + reusable task plans | TaskList, TaskFilters, RecurrenceEditor | Pending/InProgress/Overdue/Done |
| S15 | Products Catalog | `/app/products` | Store product catalog & pricing queried by AI agents | ProductTable, ProductEditor | Empty, Populated |
| S16 | Campaigns | `/app/campaigns` | Outbound WhatsApp campaigns respecting channel anti-ban throttle | CampaignList, AudiencePicker, PaceSettings, CampaignMetrics | Draft, Scheduled, Running, Paused, Completed |
| S17 | AI Hub & Agents | `/app/ai`, `/app/ai/agents` | Create/edit AI agents, instructions, model, tools, guardrails, versioning | AgentEditor, SystemPromptEditor, GuardrailsEditor | Draft, Published, Inactive |
| S18 | AI Follow-ups & Routers | `/app/ai/followups`, `/app/ai/routers` | Automated re-engagement flows + intent-based routing | FollowupFlowEditor, RouterRulesList | Active, Paused |
| S19 | AI Providers & Usage | `/app/ai/providers`, `/app/ai/usage`, `/app/ai/runs` | LLM provider keys, run traces, monthly token/cost budget cap | ProviderPurposeMatrix, RunTraceViewer, UsageChart, BudgetCard | Normal, Warning80%, CapReached100% |
| S20 | Knowledge (RAG) & Memory | `/app/ai/knowledge`, `/app/ai/memory`, `/app/ai/skills` | Tenant RAG sources (FAQ, PDF/MD, catalog), org memory, agent skills | KnowledgeSourceCard, NovoMaterialDialog, MemoryList, SkillToggleList | Indexing, Ready, Error |
| S21 | AI Cases & Central Alerts | `/app/ai/cases`, `/app/ai/inbox` | AI-handled cases awaiting human, Central Alerts inbox | CaseList, AlertDecisionCard | AwaitingHuman, Approved, Rejected |
| S22 | Connections (WhatsApp) | `/app/connections` | Manage WAHA QR sessions & Meta Cloud API numbers, health, warm-up | SessionList, QrConnectModal, HealthDot, WarmupKnobs | STARTING, SCAN_QR_CODE, WORKING, STOPPED, FAILED |
| S23 | Webhooks & Automations | `/app/webhooks` | Inbound Lead Sources, WHEN/IF/THEN Rules, Activity Log | WebhookSourceForm, TestLeadButton, RuleBuilder, ExecutionTimeline | Paused, Active, FailedRetry |
| S24 | Analytics & Audit Log | `/app/metrics`, `/app/activities`, `/app/audit` | Funnel conversion, sales goals, attendant metrics, immutable 5yr audit log | FunnelChart, AttendantMetricsTable, AuditTable | Loading, Populated, Filtered |
| S25 | Settings, Team & LGPD | `/app/settings/*`, `/app/team`, `/app/lgpd/requests`, `/app/settings/api-tokens` | Profile, MFA TOTP, team/roles/availability, pipelines/tags, branding, API tokens, LGPD export/redact | TeamTable, MfaSetupDialog, PipelineStageEditor, LgpdRequestQueue, TokenCreateModal | Active, MfaEnabled, Pending/Redacted |
| S26 | Platform Admin Console | `/admin/*` | Cross-tenant governance, health, audited support sessions | TenantDirectory, SupportSessionModal, GlobalUsageKPIs | ActiveSupportSessionBanner, ReadOnlyMode |

## Flows

```
F01 First-Run Onboarding
    S02 Login -> S04 Welcome -> Pipeline Vocabulary -> WhatsApp QR -> AI Setup -> Team Invite -> S06 Inbox
    happy path clicks: 8
    edge: QR expires after 60s (auto-refresh), invalid AI key rejected inline, user skips optional steps

F02 WhatsApp QR Connection & Health Recovery
    S22 Connections -> Connect Number -> Poll QR -> Scan -> WORKING
    happy path clicks: 3
    edge: session disconnects (FAILED) -> amber reconnect banner in S06 Inbox; duplicate session name 409

F03 Inbound Message -> AI Turn -> Handoff -> Human Resolution
    WAHA Webhook -> Identity Resolution -> AI Turn (RAG + MCP) -> Handoff (if triggered) -> S06 Inbox Claim -> Reply -> Resolve
    happy path clicks: 3 (claim, type, send/resolve)
    edge: customer says "humano", low sentiment, >24h window warning, force_human=true, STOP opt-out

F04 Kanban Deal Management
    S11 Kanban -> Switch Pipeline -> Drag Lead Card -> Optimistic Fractional Index -> Realtime Sync
    happy path clicks: 2
    edge: concurrent drag 409 conflict + refetch, is_won/is_lost auto-status, bulk >50 returns 422

F05 Customer 360 Identity Resolution & Merge
    Inbound/Webhook matches CPF -> phone_e164 -> email -> Conflict to merge_queue -> S13 MergeDialog -> Atomic Repoint
    happy path clicks: 3
    edge: anonymized/merged tombstone prevents re-creation

F06 Webhook Capture & WHEN/IF/THEN Automation
    S23 Webhooks -> Create Inbound Source -> Test Lead -> Create WHEN/IF/THEN Rule -> Enable -> Worker Execution
    happy path clicks: 5
    edge: outbound webhook fails -> logged with manual retry

F07 LGPD Data Export & Redact
    S25 LGPD Requests -> Approve Export (JSON) or Redact (Cascade Anonymization)
    happy path clicks: 2
    edge: financial/order records preserved while PII is redacted

F08 Platform Admin Support Session
    S26 Admin Console -> Select Tenant -> Start Temporary Session (1h TTL) -> Top Banner -> Exit
    happy path clicks: 3
    edge: session expires automatically at TTL, all mutations audited with support_session_id
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| AppShell / Sidebar / BottomNav | desktop sidebar, mobile bottom nav + sheet | collapsed, expanded, badge counts | all `/app/*` |
| TopBar & Global Banners | tenant switcher, cmd palette, alerts bell, support banner | normal, reconnecting, support session | all `/app/*` |
| ConversationList & ChatThread | 3-column desktop, 2-step mobile with sheet | empty, loading, open, claimed, closed, 24h warning | S06 |
| CRMSidePanel | desktop right column, mobile bottom sheet | loading, populated | S06, S13 |
| KanbanBoard & StageColumn | horizontal scroll desktop, stage-tabs/sheet mobile | loading, dragging, conflict409 | S11 |
| DataTable & Filters | contacts, tasks, audit, team | empty, loading, filtered, bulk-selected | S13, S14, S24, S25 |
| Dialogs & Sheets | modal desktop, drawer/sheet mobile | closed, open, submitting, error | all |

## Inferred data model

- **Tenancy & Auth**: `organizations`, `users`, `user_organizations` (role: viewer/agent/manager/admin), `team_invites`, `platform_admins`, `platform_support_sessions`, `api_tokens` (SHA-256), `user_recovery_codes`, `api_audit_log` (append-only).
- **Customer 360 & CRM**: `contacts` (phone E.164, email, cpf, is_blocked, is_anonymized, force_human, consent), `contact_phones`, `merge_queue`, `crm_pipelines` (vocabulary, custom fields schema), `crm_stages` (position, is_won, is_lost, requires_human), `crm_leads` (position_in_stage numeric, value_cents, currency, status, owner_user_id, custom_fields, tags), `crm_lead_activities`, `crm_lead_links`, `crm_tasks`, `catalog_products`.
- **Channels & Inbox**: `channel_sessions` (session_name, phone_number, status, engine, webhook_secret, warmup), `conversations` (status, assigned_to, service_revision), `conversation_notes`, `messages` (external_id unique per org, direction, type, status, media_url, metadata), `message_templates`, `campaigns`, `campaign_recipients`.
- **AI, RAG & MCP**: `ai_agents`, `ai_agent_runs`, `ai_invocations` (tokens, cost_cents), `ai_budgets`, `ai_provider_credentials`, `ai_knowledge_sources`, `ai_chunks` (embedding vector), `ai_faq_items`, `org_memory_entries`, `followup_flows`, `agent_cases`, `agent_inbox_items`.
- **Automation & LGPD**: `webhook_sources`, `automation_rules`, `automation_rule_runs`, `event_log`, `idempotency_keys`, `lgpd_requests`.

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Proprietary Brazilian vertical ERPs (Amigo Clinic, HostGator kit, Nuvemshop proprietary app partner credentials)
- Voice/VoIP SIP Trunking & WebRTC UDP media server (WaCalls/Asterisk)
- Heavy optional vertical modules (Comandas POS, Honorários legal billing, Cold Call dialer, Agency multi-retainer)

## Size

Screens: 26 grouped routes (42+ sub-views), Flows: 8 core flows, Entities: ~35 core tables.
Hard parts: WhatsApp anti-ban throttle & session resilience, deterministic + ambiguous identity resolution, AI guardrails & handoff CAS, multi-tenant isolation, fractional indexing + realtime Kanban, native Go MCP server.
Size: L.
