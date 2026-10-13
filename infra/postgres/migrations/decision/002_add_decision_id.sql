BEGIN;

ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS decision_id VARCHAR(100);

UPDATE decisions
SET decision_id = 'db-' || id::TEXT
WHERE decision_id IS NULL;

ALTER TABLE decisions
    ALTER COLUMN decision_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS decisions_decision_id_idx
    ON decisions (decision_id);

-- artifact_hash를 SHA-256과 npm Registry SRI SHA-512로 분리한다.
-- 기존 데이터가 있는 환경에서도 재실행할 수 있도록 멱등적으로 작성한다.
ALTER TABLE decisions
    DROP CONSTRAINT IF EXISTS decisions_request_package_policy_unique;

DROP INDEX IF EXISTS decisions_package_lookup_idx;

ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS artifact_hash_256 TEXT,
    ADD COLUMN IF NOT EXISTS artifact_hash_512 TEXT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'decisions'
          AND column_name = 'artifact_hash'
    ) THEN
        EXECUTE $migration$
            UPDATE decisions
            SET artifact_hash_512 = artifact_hash
            WHERE artifact_hash_512 IS NULL
              AND artifact_hash LIKE 'sha512-%'
        $migration$;

        EXECUTE $migration$
            UPDATE decisions
            SET artifact_hash_256 = artifact_hash
            WHERE artifact_hash_256 IS NULL
              AND artifact_hash LIKE 'sha256:%'
        $migration$;

        EXECUTE $migration$
            UPDATE decisions
            SET artifact_hash_256 = artifact_hash
            WHERE artifact_hash_256 IS NULL
              AND artifact_hash_512 IS NULL
        $migration$;

        EXECUTE 'ALTER TABLE decisions DROP COLUMN artifact_hash';
    END IF;
END
$$;

ALTER TABLE decisions
    DROP CONSTRAINT IF EXISTS decisions_artifact_hash_check;

ALTER TABLE decisions
    ADD CONSTRAINT decisions_artifact_hash_check
        CHECK (artifact_hash_256 IS NOT NULL OR artifact_hash_512 IS NOT NULL);

ALTER TABLE decisions
    ADD CONSTRAINT decisions_request_package_policy_unique
        UNIQUE (
            request_id,
            ecosystem,
            package_name,
            package_version,
            artifact_hash_256,
            artifact_hash_512,
            policy_key,
            policy_version
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

COMMENT ON COLUMN decisions.artifact_hash_256
    IS '분석 대상 Package의 SHA-256 해시';

COMMENT ON COLUMN decisions.artifact_hash_512
    IS 'npm Registry SRI 형식의 SHA-512 무결성 값';

COMMIT;
