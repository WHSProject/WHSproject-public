-- Dashboard npm 전용 토큰 및 Gateway 권한 거부 기록 (#471)
BEGIN;
CREATE TABLE IF NOT EXISTS npm_tokens (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE npm_tokens IS '사용자당 npm 전용 토큰 1개. 원문 없이 SHA-256 해시만 저장';
ALTER TABLE download_events DROP CONSTRAINT IF EXISTS download_events_outcome_check;
ALTER TABLE download_events ADD CONSTRAINT download_events_outcome_check
    CHECK (outcome IN ('DELIVERED', 'BLOCKED', 'UNAUTHENTICATED', 'FORBIDDEN', 'ERROR'));
COMMIT;
