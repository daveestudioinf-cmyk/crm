-- Clean-Room CRM Schema (PostgreSQL 16+ with pgvector)
-- Multi-tenancy enforced via organization_id on all tenant tables + Go middleware validation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Note: pgvector is enabled in Docker (pgvector/pgvector:pg16).
-- If running on vanilla Postgres without pgvector, embedding_jsonb stores float8[] for Go-side cosine similarity.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension not available; using vector_json fallback';
END $$;

-- 1. Organizations & Auth
CREATE TABLE organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    settings jsonb NOT NULL DEFAULT '{}',
    branding jsonb NOT NULL DEFAULT '{}',
    is_suspended boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    avatar_url text,
    mfa_enabled boolean NOT NULL DEFAULT false,
    mfa_secret text,
    is_platform_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'agent' CHECK (role IN ('viewer', 'agent', 'manager', 'admin')),
    is_available boolean NOT NULL DEFAULT true,
    max_concurrent_chats int NOT NULL DEFAULT 10,
    availability_schedule jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, organization_id)
);
CREATE INDEX idx_user_orgs_org ON user_organizations(organization_id);

CREATE TABLE refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE user_recovery_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL DEFAULT 'agent' CHECK (role IN ('viewer', 'agent', 'manager', 'admin')),
    token_hash text NOT NULL UNIQUE,
    invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    scopes text[] NOT NULL DEFAULT ARRAY['crm:read', 'crm:write', 'mcp:tools'],
    last_used_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_tokens_org ON api_tokens(organization_id);

CREATE TABLE platform_support_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    mode text NOT NULL DEFAULT 'support_readonly' CHECK (mode IN ('support_readonly', 'full')),
    reason text NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    support_session_id uuid REFERENCES platform_support_sessions(id) ON DELETE SET NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    metadata jsonb NOT NULL DEFAULT '{}',
    ip_address text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_created ON api_audit_log(organization_id, created_at DESC);

-- 2. Customer 360 & CRM Core
CREATE TABLE contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    display_name text,
    phone_number text,
    email text,
    cpf text,
    tags text[] NOT NULL DEFAULT '{}',
    custom_fields jsonb NOT NULL DEFAULT '{}',
    consent jsonb NOT NULL DEFAULT '{"marketing": true, "whatsapp": true}',
    is_blocked boolean NOT NULL DEFAULT false,
    force_human boolean NOT NULL DEFAULT false,
    is_anonymized boolean NOT NULL DEFAULT false,
    is_merged_into uuid REFERENCES contacts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contacts_org_phone ON contacts(organization_id, phone_number);
CREATE INDEX idx_contacts_org_email ON contacts(organization_id, email);
CREATE INDEX idx_contacts_org_cpf ON contacts(organization_id, cpf);

CREATE TABLE contact_phones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    phone_e164 text NOT NULL,
    label text NOT NULL DEFAULT 'whatsapp',
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, phone_e164)
);

CREATE TABLE merge_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    primary_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    duplicate_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'dismissed')),
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_merge_queue_org ON merge_queue(organization_id, status);

CREATE TABLE crm_pipelines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    pipeline_type text NOT NULL DEFAULT 'sales' CHECK (pipeline_type IN ('sales', 'support', 'custom')),
    vocabulary jsonb NOT NULL DEFAULT '{"deal": "Lead", "deals": "Leads", "stage": "Etapa"}',
    fields_schema jsonb NOT NULL DEFAULT '[]',
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pipelines_org ON crm_pipelines(organization_id);

CREATE TABLE crm_stages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pipeline_id uuid NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
    name text NOT NULL,
    position double precision NOT NULL DEFAULT 1000,
    color text NOT NULL DEFAULT '#64748b',
    is_won boolean NOT NULL DEFAULT false,
    is_lost boolean NOT NULL DEFAULT false,
    requires_human boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stages_pipeline ON crm_stages(pipeline_id, position);

CREATE TABLE crm_leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    pipeline_id uuid NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
    stage_id uuid NOT NULL REFERENCES crm_stages(id) ON DELETE RESTRICT,
    title text NOT NULL,
    position_in_stage double precision NOT NULL DEFAULT 1000,
    value_cents bigint NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'USD',
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
    loss_reason text,
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    source text NOT NULL DEFAULT 'manual',
    custom_fields jsonb NOT NULL DEFAULT '{}',
    tags text[] NOT NULL DEFAULT '{}',
    version int NOT NULL DEFAULT 1,
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_org_stage ON crm_leads(organization_id, stage_id, position_in_stage);
CREATE INDEX idx_leads_contact ON crm_leads(contact_id);

CREATE TABLE crm_lead_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id uuid REFERENCES crm_leads(id) ON DELETE CASCADE,
    contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    type text NOT NULL,
    summary text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}',
    performed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_activities_org_contact ON crm_lead_activities(organization_id, contact_id, performed_at DESC);
CREATE INDEX idx_activities_lead ON crm_lead_activities(lead_id, performed_at DESC);

CREATE TABLE crm_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
    contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
    assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
    title text NOT NULL,
    description text,
    due_at timestamptz,
    recurrence text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_org_status ON crm_tasks(organization_id, status, due_at);

CREATE TABLE catalog_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sku text,
    name text NOT NULL,
    description text,
    price_cents bigint NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'USD',
    stock_qty int NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_org ON catalog_products(organization_id);

-- 3. WhatsApp Channels, Conversations & Messages
CREATE TABLE channel_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    session_name text NOT NULL,
    provider text NOT NULL DEFAULT 'evolution_go' CHECK (provider IN ('waha', 'evolution_go', 'meta_cloud')),
    engine text NOT NULL DEFAULT 'NOWEB',
    phone_number text,
    status text NOT NULL DEFAULT 'STARTING' CHECK (status IN ('STARTING', 'SCAN_QR_CODE', 'WORKING', 'STOPPED', 'FAILED')),
    webhook_secret text NOT NULL,
    warmup_daily_limit int NOT NULL DEFAULT 100,
    business_hours jsonb NOT NULL DEFAULT '{"start": "08:00", "end": "20:00", "timezone": "UTC"}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, session_name)
);

CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel_session_id uuid REFERENCES channel_sessions(id) ON DELETE SET NULL,
    lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'ai_handling', 'claimed', 'resolved', 'closed')),
    assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
    service_revision int NOT NULL DEFAULT 1,
    last_inbound_at timestamptz,
    last_message_at timestamptz NOT NULL DEFAULT now(),
    last_message_preview text,
    unread_count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_org_status ON conversations(organization_id, status, last_message_at DESC);
CREATE INDEX idx_conversations_contact ON conversations(contact_id);

CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    external_id text,
    direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sender_type text NOT NULL CHECK (sender_type IN ('customer', 'human', 'ai', 'system')),
    sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    content_type text NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'audio', 'document', 'location', 'note')),
    body text NOT NULL DEFAULT '',
    media_url text,
    status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
    sentiment_score double precision,
    metadata jsonb NOT NULL DEFAULT '{}',
    sent_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_messages_org_ext ON messages(organization_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_messages_conv_sent ON messages(conversation_id, sent_at ASC);

CREATE TABLE message_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    shortcut text NOT NULL,
    title text NOT NULL,
    category text NOT NULL DEFAULT 'general',
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, shortcut)
);

-- 4. AI Agents, RAG, Memory & Budgets
CREATE TABLE ai_agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    system_prompt text NOT NULL,
    provider text NOT NULL DEFAULT 'openai',
    model text NOT NULL DEFAULT 'gpt-4o-mini',
    guardrails jsonb NOT NULL DEFAULT '{"blocked_topics": ["refund_promise", "legal_advice"], "handoff_on_uncertainty": true}',
    is_active boolean NOT NULL DEFAULT true,
    version int NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_agents_org ON ai_agents(organization_id);

CREATE TABLE ai_knowledge_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title text NOT NULL,
    source_type text NOT NULL CHECK (source_type IN ('faq', 'markdown', 'pdf', 'catalog')),
    raw_content text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'ready' CHECK (status IN ('indexing', 'ready', 'error')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_knowledge_org ON ai_knowledge_sources(organization_id);

CREATE TABLE ai_chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES ai_knowledge_sources(id) ON DELETE CASCADE,
    content text NOT NULL,
    embedding_json jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_chunks_org ON ai_chunks(organization_id);

CREATE TABLE ai_invocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    purpose text NOT NULL DEFAULT 'chat',
    provider text NOT NULL,
    model text NOT NULL,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cost_cents int NOT NULL DEFAULT 0,
    latency_ms int NOT NULL DEFAULT 0,
    handoff_triggered boolean NOT NULL DEFAULT false,
    handoff_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_invocations_org_created ON ai_invocations(organization_id, created_at DESC);

CREATE TABLE ai_budgets (
    organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    monthly_cap_cents int NOT NULL DEFAULT 5000,
    alert_80_sent boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Automation, Webhooks, Event Log & LGPD
CREATE TABLE webhook_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    token text NOT NULL UNIQUE,
    default_pipeline_id uuid REFERENCES crm_pipelines(id) ON DELETE SET NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    trigger_event text NOT NULL,
    conditions jsonb NOT NULL DEFAULT '{}',
    actions jsonb NOT NULL DEFAULT '[]',
    is_active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts int NOT NULL DEFAULT 0,
    last_error text,
    available_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_log_pending ON event_log(status, available_at) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    response_status int NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, idempotency_key)
);

CREATE TABLE lgpd_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    request_type text NOT NULL CHECK (request_type IN ('export', 'redact')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected')),
    export_payload jsonb,
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lgpd_org ON lgpd_requests(organization_id, status);
