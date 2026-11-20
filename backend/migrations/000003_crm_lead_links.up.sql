-- M3: Lead Links, Task Plans, Lead Attachments & Product Categories

CREATE TABLE IF NOT EXISTS crm_lead_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_lead_id uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    target_lead_id uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    link_type text NOT NULL DEFAULT 'related' CHECK (link_type IN ('related', 'blocks', 'blocked_by', 'duplicate', 'ticket')),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (source_lead_id <> target_lead_id),
    UNIQUE (organization_id, source_lead_id, target_lead_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_lead_links_org_source ON crm_lead_links(organization_id, source_lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_links_org_target ON crm_lead_links(organization_id, target_lead_id);

CREATE TABLE IF NOT EXISTS crm_task_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    items jsonb NOT NULL DEFAULT '[]',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_plans_org ON crm_task_plans(organization_id);

CREATE TABLE IF NOT EXISTS crm_lead_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    mime_type text,
    size_bytes bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_attachments_org_lead ON crm_lead_attachments(organization_id, lead_id, created_at DESC);

ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general';
