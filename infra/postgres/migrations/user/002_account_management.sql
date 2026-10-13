-- WHSProject User DB migration 002 (#384)
-- PostgreSQL: 16-alpine
--
-- 계정 관리 개편: Developer 역할 추가, 초대 명단 삭제, 다운로드 기록 테이블 추가.
-- 계정은 Admin이 만들고, 비밀번호는 Admin이 발급한 링크(1시간)로 사용자가 설정한다.
-- 링크 토큰은 Better Auth 재설정 토큰(verifications의 reset-password:<token>)을 그대로 쓴다.

BEGIN;


-- ---------------------------------------------------------------------------
-- 1. Developer 역할
--
-- 조회 + 패키지 설치(Gateway). Viewer(10)와 Editor(20) 사이에 둔다.
-- ---------------------------------------------------------------------------

INSERT INTO roles (code, name, description, rank) VALUES
    ('developer', 'Developer', '대시보드·판정·정책 조회, 패키지 설치(npm)', 15);

UPDATE roles SET description = '정책 초안 작성·게시, LLM 판단 원문 조회, 패키지 설치(npm)' WHERE code = 'editor';
UPDATE roles SET description = '사용자·권한 관리, predicate 관리, 권한 변경 이력 조회, 패키지 설치(npm)' WHERE code = 'admin';


-- ---------------------------------------------------------------------------
-- 2. 초대 명단 삭제
--
-- Admin이 계정을 직접 만들므로 초대 명단은 쓰지 않는다.
-- ---------------------------------------------------------------------------

DROP TABLE user_invitations;


-- ---------------------------------------------------------------------------
-- 3. 다운로드 기록
--
-- Gateway가 tarball 요청마다 1줄 기록하고, Dashboard가 조회한다.
-- occurred_at은 Gateway가 요청을 받은 시각을 직접 넣는다(기본값은 기록 시각).
-- 사용자가 삭제되거나 username이 바뀌어도 기록은 남도록 당시 username을 함께 저장한다.
-- 루트 패키지 추적(install_session_id, is_root)은 별도 Issue에서 추가한다.
-- ---------------------------------------------------------------------------

CREATE TABLE download_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    request_id TEXT NOT NULL,
    user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    username TEXT,
    source_ip INET,
    package_name TEXT NOT NULL,
    version TEXT NOT NULL,
    outcome TEXT NOT NULL,
    decision TEXT,
    http_status INT,

    CONSTRAINT download_events_outcome_check
        CHECK (outcome IN ('DELIVERED', 'BLOCKED', 'UNAUTHENTICATED', 'ERROR')),
    CONSTRAINT download_events_decision_check
        CHECK (decision IN ('ACCEPT', 'REJECT', 'HOLD', 'REVIEW'))
);

CREATE INDEX download_events_package_idx ON download_events (package_name, version);
CREATE INDEX download_events_user_idx ON download_events (user_id, occurred_at);
CREATE INDEX download_events_occurred_at_idx ON download_events (occurred_at);

COMMENT ON TABLE download_events IS 'Gateway tarball 요청 기록 (요청 1건 = 1행)';
COMMENT ON COLUMN download_events.request_id IS 'Gateway 요청 ID (x-request-id, Verdaccio 로그와 연결)';
COMMENT ON COLUMN download_events.username IS '요청 당시 username';
COMMENT ON COLUMN download_events.outcome IS 'DELIVERED | BLOCKED | UNAUTHENTICATED | ERROR';
COMMENT ON COLUMN download_events.decision IS 'ACCEPT | REJECT | HOLD | REVIEW, 미판정이면 NULL';


-- ---------------------------------------------------------------------------
-- 4. 테이블 설명 갱신
-- ---------------------------------------------------------------------------

COMMENT ON TABLE accounts IS '로그인 수단 1개 = 1행: 비밀번호 (Better Auth)';
COMMENT ON TABLE verifications IS '비밀번호 설정·재설정 링크 일회용 토큰 (Better Auth, Admin 발급)';

COMMIT;
