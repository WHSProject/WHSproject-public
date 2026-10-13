BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    ecosystem TEXT NOT NULL CHECK (ecosystem = 'npm'),
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (policy_key, version)
);

CREATE TABLE policy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    rule_code TEXT NOT NULL,
    rule_kind TEXT NOT NULL CHECK (rule_kind IN ('HARD', 'CHAIN')),
    name TEXT NOT NULL,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    decision TEXT NOT NULL CHECK (decision IN ('ACCEPT', 'REJECT', 'HOLD', 'REVIEW')),
    priority INTEGER NOT NULL DEFAULT 0,
    condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason_code TEXT NOT NULL,
    reason_message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (policy_id, rule_code)
);

CREATE INDEX idx_policies_lookup ON policies(policy_key, ecosystem, status);
CREATE INDEX idx_policy_rules_policy_id ON policy_rules(policy_id);
CREATE INDEX idx_policy_rules_enabled ON policy_rules(policy_id, enabled, priority);

CREATE UNIQUE INDEX policies_one_active_policy_per_ecosystem
    ON policies (ecosystem)
    WHERE status = 'PUBLISHED';

COMMIT;
