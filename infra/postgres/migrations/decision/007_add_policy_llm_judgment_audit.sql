BEGIN;

CREATE TABLE IF NOT EXISTS policy_llm_judgments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_mode VARCHAR(16) NOT NULL,
    request_id UUID NOT NULL,
    scan_id UUID NOT NULL,
    policy_key VARCHAR(100) NOT NULL,
    policy_version VARCHAR(50) NOT NULL,
    policy_hash VARCHAR(64),
    judgment_id VARCHAR(100) NOT NULL,
    status VARCHAR(16) NOT NULL,
    prompt TEXT NOT NULL,
    model VARCHAR(200),
    provider_request_id VARCHAR(200),
    duration_ms NUMERIC(12, 3),
    judgment_json JSONB,
    response_json JSONB,
    failure_code TEXT,
    resolved_decision VARCHAR(16),
    resolved_reason_code VARCHAR(100),
    shadow_of_judgment_id VARCHAR(100),
    comparison_json JSONB,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT policy_llm_judgments_run_mode_check
        CHECK (run_mode IN ('PRIMARY', 'SHADOW')),
    CONSTRAINT policy_llm_judgments_status_check
        CHECK (status IN ('COMPLETED', 'FAILED')),
    CONSTRAINT policy_llm_judgments_decision_check
        CHECK (resolved_decision IS NULL OR resolved_decision IN ('ACCEPT', 'REJECT', 'HOLD', 'REVIEW')),
    CONSTRAINT policy_llm_judgments_unique_run
        UNIQUE (request_id, run_mode, judgment_id)
);

CREATE INDEX IF NOT EXISTS policy_llm_judgments_request_idx
    ON policy_llm_judgments (request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS policy_llm_judgments_judgment_idx
    ON policy_llm_judgments (judgment_id);

COMMENT ON TABLE policy_llm_judgments
    IS '원본 Policy LLM 입력·응답·검증 결과와 비권위 Shadow 실행을 보존하는 감사 이력';

COMMIT;
