BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE evidences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL DEFAULT '0.1',
    kind TEXT NOT NULL CHECK (kind IN ('ATOMIC', 'CORRELATED')),
    scan_run_id TEXT NOT NULL,
    ecosystem TEXT NOT NULL CHECK (ecosystem = 'npm'),
    package_name TEXT NOT NULL,
    package_version TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_category TEXT NOT NULL,
    assertion_summary TEXT NOT NULL,
    assertion_basis TEXT NOT NULL CHECK (
        assertion_basis IN (
            'PATTERN_MATCH',
            'METADATA_VALUE',
            'CO_OCCURRENCE',
            'EXECUTION_LINK',
            'DATA_FLOW',
            'TOOL_CORRELATION'
        )
    ),
    generated_by TEXT NOT NULL CHECK (
        generated_by IN ('EVIDENCE_NORMALIZER', 'EVIDENCE_CORRELATOR')
    ),
    observed_at TIMESTAMPTZ NOT NULL,
    raw_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE evidence_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
    analyzer TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    rule_id TEXT,
    rule_version TEXT,
    raw_finding_id TEXT
);

CREATE TABLE evidence_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
    location_type TEXT NOT NULL CHECK (location_type IN ('SOURCE_FILE', 'METADATA')),
    path TEXT,
    start_line INTEGER CHECK (start_line IS NULL OR start_line >= 1),
    end_line INTEGER CHECK (end_line IS NULL OR end_line >= 1),
    json_pointer TEXT,
    role TEXT CHECK (role IN ('OBSERVATION', 'SOURCE', 'SINK', 'ENTRYPOINT')),
    CHECK (start_line IS NULL OR end_line IS NULL OR end_line >= start_line)
);

CREATE TABLE evidence_derivations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
    parent_evidence_id TEXT,
    parent_finding_id TEXT
);

CREATE TABLE evidence_limitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
    limitation_code TEXT NOT NULL
);

CREATE INDEX idx_evidences_scan_run_id ON evidences(scan_run_id);
CREATE INDEX idx_evidences_subject ON evidences(package_name, package_version, artifact_hash);
CREATE INDEX idx_evidences_signal_type ON evidences(signal_type);
CREATE INDEX idx_evidence_sources_evidence_id ON evidence_sources(evidence_id);
CREATE INDEX idx_evidence_locations_evidence_id ON evidence_locations(evidence_id);
CREATE INDEX idx_evidence_derivations_evidence_id ON evidence_derivations(evidence_id);
CREATE INDEX idx_evidence_limitations_evidence_id ON evidence_limitations(evidence_id);

COMMIT;
