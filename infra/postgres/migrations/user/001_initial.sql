-- WHSProject User DB initial migration
-- PostgreSQL: 16-alpine
--
-- Dashboard 로그인·권한(Better Auth)에 쓰는 사용자 DB이다. Dashboard만 접근한다.
-- gen_random_uuid()는 PostgreSQL 13부터 기본 함수이므로 pgcrypto를 설치하지 않는다.

BEGIN;


-- ---------------------------------------------------------------------------
-- 1. 역할 목록
--
-- users.role이 참조한다. code는 Dashboard 코드(permissions.ts)의 역할 값과 같다.
-- 역할별 권한은 DB가 아니라 코드에서 정의한다.
-- rank는 역할 사이에 새 역할을 끼워 넣을 수 있도록 10 단위로 둔다.
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    rank SMALLINT NOT NULL UNIQUE
);

INSERT INTO roles (code, name, description, rank) VALUES
    ('viewer', 'Viewer', '대시보드·판정·정책 조회', 10),
    ('editor', 'Editor', '정책 초안 작성·게시, LLM 판단 원문 조회', 20),
    ('admin', 'Admin', '사용자·권한 관리, predicate 관리, 권한 변경 이력 조회', 30);


-- ---------------------------------------------------------------------------
-- 2. Better Auth 테이블
--
-- better-auth 1.7.5 CLI(npx auth@1.7.5 generate)가 생성한 SQL을 형식만 정리했다.
-- 컬럼·타입·제약은 생성 결과와 같다. 추가 제약은 3번 구역에 둔다.
-- 버전을 올리면 이 스키마에 새 버전 CLI를 실행해 변경이 필요한지 확인한다.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL,
    image TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    username TEXT UNIQUE,
    display_username TEXT,
    role TEXT,
    banned BOOLEAN,
    ban_reason TEXT,
    ban_expires TIMESTAMPTZ
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expires_at TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    impersonated_by TEXT
);

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);


-- ---------------------------------------------------------------------------
-- 3. Better Auth 테이블 보강
-- ---------------------------------------------------------------------------

-- 역할은 roles에 있는 값 하나만 허용한다. 가입 시 기본 역할은 viewer이다.
ALTER TABLE users
    ALTER COLUMN role SET DEFAULT 'viewer',
    ALTER COLUMN role SET NOT NULL,
    ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles (code);

-- 대소문자만 다른 이메일로 중복 가입하지 못하게 한다.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- 같은 외부 계정(Google·GitHub)을 두 사용자에 연결하지 못하게 한다.
CREATE UNIQUE INDEX accounts_provider_account_key ON accounts (provider_id, account_id);


-- ---------------------------------------------------------------------------
-- 4. 가입 허용 이메일 목록
--
-- Admin이 등록한 이메일만 가입할 수 있다. 역할 컬럼은 없으며 가입하면 항상 viewer이다.
-- 취소되지 않은 초대는 이메일당(대소문자 무시) 1건만 허용한다.
-- invited_by는 초대한 Admin이 삭제됐거나 DB에서 직접 등록한 경우 NULL이다.
-- ---------------------------------------------------------------------------

CREATE TABLE user_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    invited_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX user_invitations_active_email_key
    ON user_invitations (lower(email))
    WHERE revoked_at IS NULL;


-- ---------------------------------------------------------------------------
-- 5. 권한 변경 이력
--
-- users.role이 바뀌면 Trigger가 자동으로 한 줄을 남긴다.
-- 애플리케이션은 같은 Transaction에서 SET LOCAL app.actor_user_id = '<변경한 사람 id>'를 먼저 실행한다.
-- 변경한 사람이 없으면(DataGrip 등으로 직접 수정) changed_by_* 컬럼이 NULL로 남는다.
-- 가입·첫 Admin 지정처럼 처음 받는 권한은 변경이 아니므로 기록하지 않는다.
-- 이력은 추가만 허용하며, 사용자가 삭제돼도 id만 NULL이 되고 email은 남는다.
-- ---------------------------------------------------------------------------

CREATE TABLE user_role_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 변경된 사람. email은 변경 당시 값을 보존한다.
    target_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    target_email TEXT NOT NULL,

    -- 변경한 사람. DB 직접 수정이면 NULL이다.
    changed_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    changed_by_email TEXT,

    previous_role TEXT NOT NULL,
    new_role TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT user_role_changes_changed_check
        CHECK (previous_role <> new_role)
);

CREATE INDEX user_role_changes_target_idx ON user_role_changes (target_user_id, changed_at DESC);
CREATE INDEX user_role_changes_changed_at_idx ON user_role_changes (changed_at DESC);

CREATE FUNCTION log_user_role_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    -- UUID가 아닌 값이 들어오면 형변환 오류로 권한 변경도 함께 취소된다.
    actor_id UUID := NULLIF(current_setting('app.actor_user_id', true), '')::uuid;
    actor_email TEXT;
BEGIN
    IF actor_id IS NOT NULL THEN
        SELECT email INTO actor_email FROM users WHERE id = actor_id;
        IF actor_email IS NULL THEN
            RAISE EXCEPTION 'app.actor_user_id % does not exist', actor_id;
        END IF;
    END IF;

    INSERT INTO user_role_changes (
        target_user_id, target_email, changed_by_user_id, changed_by_email,
        previous_role, new_role
    ) VALUES (
        NEW.id, NEW.email, actor_id, actor_email,
        OLD.role, NEW.role
    );
    RETURN NEW;
END;
$$;

-- role 값이 실제로 달라졌을 때만 실행한다.
CREATE TRIGGER users_role_change_log
    AFTER UPDATE OF role ON users
    FOR EACH ROW
    WHEN (OLD.role IS DISTINCT FROM NEW.role)
    EXECUTE FUNCTION log_user_role_change();

-- 이력의 수정·삭제는 오류로 막는다.
-- 단, 사용자 삭제 시 FK(ON DELETE SET NULL)가 id를 NULL로 바꾸는 갱신은 허용한다.
CREATE FUNCTION forbid_role_change_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND (NEW.target_user_id IS NULL OR NEW.target_user_id = OLD.target_user_id)
        AND (NEW.changed_by_user_id IS NULL OR NEW.changed_by_user_id = OLD.changed_by_user_id)
        AND (NEW.id, NEW.target_email, NEW.changed_by_email, NEW.previous_role,
             NEW.new_role, NEW.changed_at)
            IS NOT DISTINCT FROM
            (OLD.id, OLD.target_email, OLD.changed_by_email, OLD.previous_role,
             OLD.new_role, OLD.changed_at)
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'user_role_changes is append-only';
END;
$$;

CREATE TRIGGER user_role_changes_append_only
    BEFORE UPDATE OR DELETE ON user_role_changes
    FOR EACH ROW
    EXECUTE FUNCTION forbid_role_change_log_mutation();

-- TRUNCATE는 행 단위 Trigger를 거치지 않으므로 문장 단위로 따로 막는다(DataGrip Truncate 실수 방지).
CREATE TRIGGER user_role_changes_no_truncate
    BEFORE TRUNCATE ON user_role_changes
    FOR EACH STATEMENT
    EXECUTE FUNCTION forbid_role_change_log_mutation();


-- ---------------------------------------------------------------------------
-- 6. 테이블 설명 (DataGrip 등에서 표시)
-- ---------------------------------------------------------------------------

COMMENT ON TABLE roles IS '역할 목록. users.role의 허용값';
COMMENT ON TABLE users IS '사용자 1명 = 1행 (Better Auth)';
COMMENT ON TABLE accounts IS '로그인 수단 1개 = 1행: 비밀번호, Google, GitHub (Better Auth)';
COMMENT ON TABLE sessions IS '로그인 세션 (Better Auth)';
COMMENT ON TABLE verifications IS '비밀번호 재설정·OAuth state 일회용 토큰 (Better Auth)';
COMMENT ON TABLE user_invitations IS '가입 허용 이메일 목록 (Admin 등록)';
COMMENT ON TABLE user_role_changes IS '권한 변경 이력 (Trigger 자동 기록, 추가만 허용)';

COMMIT;
