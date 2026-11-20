CREATE TABLE IF NOT EXISTS campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel_session_id uuid REFERENCES channel_sessions(id) ON DELETE SET NULL,
    name text NOT NULL,
    message_template text NOT NULL,
    audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','running','paused','completed','cancelled')),
    throttle_per_minute int NOT NULL DEFAULT 10,
    min_delay_sec int NOT NULL DEFAULT 5,
    max_delay_sec int NOT NULL DEFAULT 15,
    daily_cap int NOT NULL DEFAULT 0,
    respect_business_hours boolean NOT NULL DEFAULT true,
    scheduled_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    total_count int NOT NULL DEFAULT 0,
    sent_count int NOT NULL DEFAULT 0,
    failed_count int NOT NULL DEFAULT 0,
    skipped_count int NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_org_status ON campaigns(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON campaigns(status, scheduled_at) WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS campaign_recipients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    phone_number text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','failed','skipped')),
    error_message text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_org_camp_status ON campaign_recipients(organization_id, campaign_id, status, created_at ASC);

CREATE TABLE IF NOT EXISTS appointments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
    lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
    assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    location text NOT NULL DEFAULT '',
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    duration_minutes int NOT NULL DEFAULT 30,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','completed','cancelled','no_show')),
    notes text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_org_starts ON appointments(organization_id, starts_at ASC);
CREATE INDEX IF NOT EXISTS idx_appointments_org_status ON appointments(organization_id, status, starts_at ASC);

CREATE TABLE IF NOT EXISTS waitlist_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
    contact_name text NOT NULL,
    contact_phone text NOT NULL DEFAULT '',
    service_name text NOT NULL DEFAULT '',
    preferred_date date,
    preferred_period text NOT NULL DEFAULT 'any' CHECK (preferred_period IN ('any','morning','afternoon','evening')),
    priority int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','scheduled','cancelled')),
    appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_org_status ON waitlist_entries(organization_id, status, priority DESC, created_at ASC);
