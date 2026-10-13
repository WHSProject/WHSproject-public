-- WHSProject Decision DB initial migration
-- PostgreSQL: 16-alpine
--
-- 현재 Schema와 하단 데이터는 Gateway API 개발을 위한 임시 구성이다.
-- 최종 Decision Contract 확정 후 Column, Constraint, Index 및 Seed는
-- 별도의 Migration을 통해 변경할 수 있다.

BEGIN;

CREATE TABLE IF NOT EXISTS decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    decision_id VARCHAR(100) NOT NULL,

    request_id UUID NOT NULL,

    score NUMERIC(10, 4) NOT NULL,

    decision VARCHAR(16) NOT NULL,

    reason_code VARCHAR(100) NOT NULL,
    reason_message TEXT NOT NULL,

    matched_rule_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    evidence_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    scan_id UUID,

    policy_key VARCHAR(100) NOT NULL,
    policy_version VARCHAR(50) NOT NULL,

    ecosystem VARCHAR(32) NOT NULL DEFAULT 'npm',

    package_name TEXT NOT NULL,
    package_version VARCHAR(255) NOT NULL,
    artifact_hash_256 TEXT,
    artifact_hash_512 TEXT,

    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT decisions_decision_check
        CHECK (decision IN ('ACCEPT', 'REJECT', 'HOLD', 'REVIEW')),

    CONSTRAINT decisions_ecosystem_check
        CHECK (ecosystem = 'npm'),

    CONSTRAINT decisions_artifact_hash_check
        CHECK (artifact_hash_256 IS NOT NULL OR artifact_hash_512 IS NOT NULL),

    CONSTRAINT decisions_request_package_policy_unique
        UNIQUE (
            request_id,
            ecosystem,
            package_name,
            package_version,
            artifact_hash_256,
            artifact_hash_512,
            policy_key,
            policy_version
        )
);

CREATE INDEX IF NOT EXISTS decisions_package_lookup_idx
    ON decisions (
        ecosystem,
        package_name,
        package_version,
        artifact_hash_256,
        artifact_hash_512,
        policy_key,
        policy_version
    );

CREATE INDEX IF NOT EXISTS decisions_integrity_lookup_idx
    ON decisions (
        ecosystem,
        package_name,
        package_version,
        artifact_hash_512,
        evaluated_at DESC
    );

CREATE INDEX IF NOT EXISTS decisions_request_id_idx
    ON decisions (request_id);

CREATE INDEX IF NOT EXISTS decisions_decision_idx
    ON decisions (decision);

CREATE INDEX IF NOT EXISTS decisions_evaluated_at_idx
    ON decisions (evaluated_at DESC);

COMMENT ON TABLE decisions
    IS 'Policy Engine의 최종 Package 판단 결과';

COMMENT ON COLUMN decisions.request_id
    IS '평가 요청 식별자';

COMMENT ON COLUMN decisions.decision
    IS '최종 판단 결과: ACCEPT, REJECT, HOLD, REVIEW';

COMMENT ON COLUMN decisions.matched_rule_ids
    IS '판정에 매칭된 Policy Rule 식별자 목록';

COMMENT ON COLUMN decisions.evidence_ids
    IS '판정에 사용된 Evidence 식별자 목록';

COMMENT ON COLUMN decisions.artifact_hash_256
    IS '분석 대상 Package의 SHA-256 해시';

COMMENT ON COLUMN decisions.artifact_hash_512
    IS 'npm Registry SRI 형식의 SHA-512 무결성 값';


-- ---------------------------------------------------------------------------
-- Temporary Gateway API development data
--
-- Gateway API와 Local LRU Cache 동작을 검증하기 위한 임시 데이터이다.
-- 실제 Package에 대한 보안 판단 결과가 아니며 운영환경에서 사용하지 않는다.
-- ---------------------------------------------------------------------------

INSERT INTO decisions (
    id,
    decision_id,
    request_id,
    score,
    decision,
    reason_code,
    reason_message,
    matched_rule_ids,
    evidence_ids,
    scan_id,
    policy_key,
    policy_version,
    ecosystem,
    package_name,
    package_version,
    artifact_hash_256,
    artifact_hash_512
)
VALUES
(
    '00000000-0000-4000-8000-000000000001',
    'dec-sample-accept',
    '10000000-0000-4000-8000-000000000001',
    10.0000,
    'ACCEPT',
    'POLICY_PASSED',
    '모든 임시 보안 정책을 통과했습니다.',
    ARRAY['RULE-ALLOW-001'],
    ARRAY['EVIDENCE-SAMPLE-001'],
    '20000000-0000-4000-8000-000000000001',
    'default-npm-policy',
    '1.0.0',
    'npm',
    '@whs/sample-accept',
    '1.0.0',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
),
(
    '00000000-0000-4000-8000-000000000002',
    'dec-sample-reject',
    '10000000-0000-4000-8000-000000000001',
    95.0000,
    'REJECT',
    'MALICIOUS_PATTERN',
    '임시 악성 패턴이 탐지되었습니다.',
    ARRAY['RULE-REJECT-001'],
    ARRAY['EVIDENCE-SAMPLE-002'],
    '20000000-0000-4000-8000-000000000002',
    'default-npm-policy',
    '1.0.0',
    'npm',
    '@whs/sample-reject',
    '1.0.0',
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'sha512-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
),
(
    '00000000-0000-4000-8000-000000000003',
    'dec-sample-hold',
    '10000000-0000-4000-8000-000000000001',
    60.0000,
    'HOLD',
    'ADDITIONAL_SCAN_REQUIRED',
    '추가 분석이 필요한 임시 Package입니다.',
    ARRAY['RULE-HOLD-001'],
    ARRAY['EVIDENCE-SAMPLE-003'],
    '20000000-0000-4000-8000-000000000003',
    'default-npm-policy',
    '1.0.0',
    'npm',
    '@whs/sample-hold',
    '1.0.0',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'sha512-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
),
(
    '00000000-0000-4000-8000-000000000004',
    'dec-sample-review',
    '10000000-0000-4000-8000-000000000001',
    50.0000,
    'REVIEW',
    'MANUAL_REVIEW_REQUIRED',
    '수동 검토가 필요한 임시 Package입니다.',
    ARRAY['RULE-REVIEW-001'],
    ARRAY['EVIDENCE-SAMPLE-004'],
    '20000000-0000-4000-8000-000000000004',
    'default-npm-policy',
    '1.0.0',
    'npm',
    '@whs/sample-review',
    '1.0.0',
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'sha512-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
