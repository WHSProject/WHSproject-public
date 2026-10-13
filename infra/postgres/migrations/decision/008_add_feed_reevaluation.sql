BEGIN;

-- A package may have more than one Decision over time.  The original
-- request/package/policy constraint was correct for the first evaluation but
-- prevented immutable feed-driven lineage from being stored.
ALTER TABLE decisions
    DROP CONSTRAINT IF EXISTS decisions_request_package_policy_unique;

ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS previous_decision_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS trigger_snapshot_id UUID REFERENCES feed_snapshots(id);

ALTER TABLE decisions
    ADD CONSTRAINT decisions_previous_decision_fk
        FOREIGN KEY (previous_decision_id) REFERENCES decisions(decision_id);

CREATE INDEX IF NOT EXISTS decisions_previous_decision_idx
    ON decisions (previous_decision_id)
    WHERE previous_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS decisions_trigger_snapshot_idx
    ON decisions (trigger_snapshot_id)
    WHERE trigger_snapshot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reevaluation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ecosystem VARCHAR(32) NOT NULL,
    package_name TEXT NOT NULL,
    package_version VARCHAR(255) NOT NULL,
    artifact_hash_256 TEXT,
    artifact_hash_512 TEXT,
    scan_id UUID,
    previous_snapshot_id UUID NOT NULL REFERENCES feed_snapshots(id),
    trigger_snapshot_id UUID NOT NULL REFERENCES feed_snapshots(id),
    previous_decision_id VARCHAR(100) NOT NULL REFERENCES decisions(decision_id),
    change_reason VARCHAR(100) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    error_code VARCHAR(100),
    error_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    CONSTRAINT reevaluation_jobs_ecosystem_check CHECK (ecosystem = 'npm'),
    CONSTRAINT reevaluation_jobs_artifact_check CHECK (
        artifact_hash_256 IS NOT NULL OR artifact_hash_512 IS NOT NULL
    ),
    CONSTRAINT reevaluation_jobs_status_check CHECK (
        status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')
    ),
    CONSTRAINT reevaluation_jobs_reason_check CHECK (
        change_reason IN ('CONTENT_DIGEST_CHANGED')
    ),
    CONSTRAINT reevaluation_jobs_time_check CHECK (
        completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
    ),
    CONSTRAINT reevaluation_jobs_unique_trigger UNIQUE (
        previous_decision_id, trigger_snapshot_id
    )
);

CREATE INDEX IF NOT EXISTS reevaluation_jobs_status_idx
    ON reevaluation_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS reevaluation_jobs_package_idx
    ON reevaluation_jobs (ecosystem, package_name, package_version, created_at DESC);

CREATE INDEX IF NOT EXISTS reevaluation_jobs_previous_decision_idx
    ON reevaluation_jobs (previous_decision_id);

CREATE TABLE IF NOT EXISTS reevaluation_job_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES reevaluation_jobs(id) ON DELETE CASCADE,
    from_status VARCHAR(16),
    to_status VARCHAR(16) NOT NULL,
    error_code VARCHAR(100),
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS reevaluation_job_events_job_idx
    ON reevaluation_job_events (job_id, created_at);

COMMENT ON TABLE reevaluation_jobs
    IS 'Idempotent feed-change re-evaluation work items. Existing Decisions are immutable.';
COMMENT ON COLUMN decisions.previous_decision_id
    IS 'External Decision ID immediately preceding a feed-triggered re-evaluation.';
COMMENT ON COLUMN decisions.trigger_snapshot_id
    IS 'New Feed Snapshot that triggered this re-evaluation.';

COMMIT;
