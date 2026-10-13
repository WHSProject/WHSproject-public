BEGIN;

CREATE TABLE IF NOT EXISTS feed_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ecosystem VARCHAR(32) NOT NULL,
    package_name TEXT NOT NULL,
    package_version VARCHAR(255) NOT NULL,
    source VARCHAR(32) NOT NULL,
    raw_advisories JSONB NOT NULL,
    validation_result JSONB NOT NULL,
    content_digest CHAR(64) NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL,
    validated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT feed_snapshots_ecosystem_check CHECK (ecosystem = 'npm'),
    CONSTRAINT feed_snapshots_source_check CHECK (source = 'OSV'),
    CONSTRAINT feed_snapshots_digest_check CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT feed_snapshots_ttl_check CHECK (expires_at = validated_at + INTERVAL '1 hour')
);

CREATE INDEX IF NOT EXISTS feed_snapshots_reuse_idx
    ON feed_snapshots (
        ecosystem,
        package_name,
        package_version,
        source,
        content_digest,
        expires_at DESC
    );

CREATE INDEX IF NOT EXISTS feed_snapshots_expiry_idx
    ON feed_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS feed_lookup_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL,
    scan_id UUID,
    ecosystem VARCHAR(32) NOT NULL,
    package_name TEXT NOT NULL,
    package_version VARCHAR(255) NOT NULL,
    source VARCHAR(32) NOT NULL,
    feed_status VARCHAR(16) NOT NULL,
    complete BOOLEAN NOT NULL,
    error_code VARCHAR(100),
    skipped_reason VARCHAR(100),
    pages_fetched INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    failure_detail TEXT,
    snapshot_id UUID REFERENCES feed_snapshots(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT feed_lookup_attempts_request_unique UNIQUE (request_id),
    CONSTRAINT feed_lookup_attempts_ecosystem_check CHECK (ecosystem = 'npm'),
    CONSTRAINT feed_lookup_attempts_source_check CHECK (source = 'OSV'),
    CONSTRAINT feed_lookup_attempts_status_check
        CHECK (feed_status IN ('SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED')),
    CONSTRAINT feed_lookup_attempts_complete_check
        CHECK (feed_status = 'SUCCESS' OR complete = FALSE),
    CONSTRAINT feed_lookup_attempts_pages_check CHECK (pages_fetched >= 0),
    CONSTRAINT feed_lookup_attempts_time_check CHECK (completed_at >= started_at),
    CONSTRAINT feed_lookup_attempts_snapshot_check CHECK (
        (feed_status = 'SUCCESS' AND complete = TRUE AND snapshot_id IS NOT NULL)
        OR ((feed_status <> 'SUCCESS' OR complete = FALSE) AND snapshot_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS feed_lookup_attempts_package_idx
    ON feed_lookup_attempts (
        ecosystem,
        package_name,
        package_version,
        source,
        completed_at DESC
    );

CREATE INDEX IF NOT EXISTS feed_lookup_attempts_scan_id_idx
    ON feed_lookup_attempts (scan_id)
    WHERE scan_id IS NOT NULL;

ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS feed_snapshot_id UUID REFERENCES feed_snapshots(id),
    ADD COLUMN IF NOT EXISTS feed_evidence_ids TEXT[];

CREATE INDEX IF NOT EXISTS decisions_feed_snapshot_id_idx
    ON decisions (feed_snapshot_id)
    WHERE feed_snapshot_id IS NOT NULL;

COMMENT ON TABLE feed_snapshots
    IS 'Successfully completed and Policy-validated OSV feed snapshots.';
COMMENT ON COLUMN feed_snapshots.raw_advisories
    IS 'Original OSV advisory payload, separate from the Policy validation result.';
COMMENT ON COLUMN feed_snapshots.validation_result
    IS 'Policy-normalized advisories, exclusions, and validation status.';
COMMENT ON COLUMN feed_snapshots.content_digest
    IS 'SHA-256 of canonical judgment-related package, advisory, and validation fields.';
COMMENT ON TABLE feed_lookup_attempts
    IS 'History of every OSV lookup result delivered to Policy.';
COMMENT ON COLUMN decisions.feed_snapshot_id
    IS 'Successful OSV feed snapshot used by this Policy Decision.';
COMMENT ON COLUMN decisions.feed_evidence_ids
    IS 'Validated Policy-local OSV evidence identifiers actually cited by the judgment.';

COMMIT;
