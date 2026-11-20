-- M4: Automations Engine, Follow-up Flows, AI Intent Routers, Agent Cases, Inbox Items & AI Skills

ALTER TABLE event_log
    ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_event_log_stuck
    ON event_log(status, updated_at)
    WHERE status = 'processing';

ALTER TABLE automation_rules
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS automation_rule_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    event_id uuid REFERENCES event_log(id) ON DELETE SET NULL,
    trigger_event text NOT NULL,
    status text NOT NULL CHECK (status IN ('matched', 'skipped', 'executed', 'failed')),
    input_payload jsonb NOT NULL DEFAULT '{}',
    actions_executed jsonb NOT NULL DEFAULT '[]',
    error_message text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_rule_runs_org ON automation_rule_runs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_rule_runs_rule ON automation_rule_runs(rule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS followup_flows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    trigger_type text NOT NULL DEFAULT 'manual',
    delay_minutes int NOT NULL DEFAULT 60,
    max_attempts int NOT NULL DEFAULT 3,
    prompt_template text NOT NULL DEFAULT '',
    channel_session_id uuid REFERENCES channel_sessions(id) ON DELETE SET NULL,
    steps jsonb NOT NULL DEFAULT '[]',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followup_flows_org ON followup_flows(organization_id, is_active);

CREATE TABLE IF NOT EXISTS followup_enrollments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    flow_id uuid NOT NULL REFERENCES followup_flows(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
    current_step int NOT NULL DEFAULT 0,
    attempts int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'failed')),
    next_run_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followup_enrollments_due ON followup_enrollments(status, next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_followup_enrollments_org ON followup_enrollments(organization_id, status);

CREATE TABLE IF NOT EXISTS ai_intent_routers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    intent_keywords text[] NOT NULL DEFAULT '{}',
    rules jsonb NOT NULL DEFAULT '[]',
    target_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
    priority int NOT NULL DEFAULT 100,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_intent_routers_org ON ai_intent_routers(organization_id, is_active, priority);

CREATE TABLE IF NOT EXISTS agent_cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
    agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
    title text NOT NULL,
    summary text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'awaiting_human' CHECK (status IN ('awaiting_human', 'approved', 'rejected', 'resolved')),
    decision_notes text,
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_cases_org ON agent_cases(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_inbox_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    case_id uuid REFERENCES agent_cases(id) ON DELETE CASCADE,
    severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    category text NOT NULL DEFAULT 'handoff',
    message text NOT NULL,
    is_read boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_inbox_items_org ON agent_inbox_items(organization_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_skills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id uuid REFERENCES ai_agents(id) ON DELETE CASCADE,
    skill_key text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    config jsonb NOT NULL DEFAULT '{}',
    is_enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_skills_org ON ai_skills(organization_id, agent_id);
