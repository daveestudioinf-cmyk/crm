-- Bloque 2: AI Provider Credentials, Budgets, Agent Runs, Org Memory & Agent Tuning

ALTER TABLE ai_agents
    ADD COLUMN IF NOT EXISTS temperature double precision NOT NULL DEFAULT 0.3,
    ADD COLUMN IF NOT EXISTS max_tokens int NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS handoff_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE ai_budgets
    ADD COLUMN IF NOT EXISTS monthly_limit_cents bigint NOT NULL DEFAULT 5000,
    ADD COLUMN IF NOT EXISTS spent_cents bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS warn_at_percent int NOT NULL DEFAULT 80,
    ADD COLUMN IF NOT EXISTS hard_stop boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS period_start timestamptz NOT NULL DEFAULT date_trunc('month', now());

UPDATE ai_budgets
SET monthly_limit_cents = monthly_cap_cents
WHERE monthly_limit_cents = 5000 AND monthly_cap_cents <> 5000;

UPDATE ai_budgets b
SET spent_cents = COALESCE((
    SELECT SUM(i.cost_cents)
    FROM ai_invocations i
    WHERE i.organization_id = b.organization_id
      AND i.created_at >= date_trunc('month', now())
), 0)
WHERE b.spent_cents = 0;

CREATE TABLE IF NOT EXISTS ai_provider_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'gemini', 'openrouter', 'openai_compatible')),
    label text NOT NULL DEFAULT '',
    base_url text NOT NULL DEFAULT '',
    default_model text NOT NULL DEFAULT '',
    api_key_encrypted text NOT NULL,
    api_key_mask text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_creds_org ON ai_provider_credentials(organization_id, is_active);

CREATE TABLE IF NOT EXISTS org_memory_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category text NOT NULL DEFAULT 'general',
    content text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_memory_org ON org_memory_entries(organization_id, is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    status text NOT NULL CHECK (status IN ('completed', 'handoff', 'blocked_budget', 'failed')),
    provider text NOT NULL,
    model text NOT NULL,
    input_preview text NOT NULL DEFAULT '',
    output_preview text NOT NULL DEFAULT '',
    handoff_reason text,
    error_message text,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cost_cents int NOT NULL DEFAULT 0,
    latency_ms int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_org_created ON ai_agent_runs(organization_id, created_at DESC);

ALTER TABLE ai_invocations
    ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES ai_agent_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS error_message text;
