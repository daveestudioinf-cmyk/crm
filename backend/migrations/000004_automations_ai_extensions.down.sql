DROP TABLE IF EXISTS ai_skills;
DROP TABLE IF EXISTS agent_inbox_items;
DROP TABLE IF EXISTS agent_cases;
DROP TABLE IF EXISTS ai_intent_routers;
DROP TABLE IF EXISTS followup_enrollments;
DROP TABLE IF EXISTS followup_flows;
DROP TABLE IF EXISTS automation_rule_runs;

ALTER TABLE automation_rules
    DROP COLUMN IF EXISTS priority,
    DROP COLUMN IF EXISTS description;

DROP INDEX IF EXISTS idx_event_log_stuck;

ALTER TABLE event_log
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS max_attempts;
