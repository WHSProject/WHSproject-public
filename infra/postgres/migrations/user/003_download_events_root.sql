-- WHSProject User DB migration 003 (#461)
-- PostgreSQL: 16-alpine
--
-- 다운로드 기록에 루트 패키지 여부와 집행한 판정 id를 추가한다.
-- Dashboard Request·Overview가 루트 요청만 읽고, 판정 id로 Package 상세에 연결한다.
-- install_session_id는 npm이 세션 id를 보내지 않아 추가하지 않는다.

BEGIN;


-- ---------------------------------------------------------------------------
-- 1. 컬럼
--
-- is_root: 사용자가 설치 명령으로 직접 지정한 패키지의 요청이면 true. 판별 전·하위 의존성은 false.
-- decision_id: decision_db의 판정 id. DB가 달라 외래키는 걸지 않는다.
-- ---------------------------------------------------------------------------

ALTER TABLE download_events
    ADD COLUMN IF NOT EXISTS is_root BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS decision_id TEXT;

COMMENT ON COLUMN download_events.is_root IS '사용자가 설치 명령으로 직접 지정한 패키지의 요청이면 true, 하위 의존성 요청은 false';
COMMENT ON COLUMN download_events.decision_id IS 'Gateway가 이 요청에 집행한 판정 id (Decision 조회 FOUND의 decisionId), 판정이 없으면 NULL';


-- ---------------------------------------------------------------------------
-- 2. 인덱스
--
-- root: Request 목록·Overview 24시간 수는 루트 요청을 시각 범위로 읽는다.
-- request: Overview가 판정의 request_id로 설치를 시도한 사용자를 찾는다.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS download_events_root_idx ON download_events (occurred_at DESC) WHERE is_root;
CREATE INDEX IF NOT EXISTS download_events_request_idx ON download_events (request_id);

COMMIT;
