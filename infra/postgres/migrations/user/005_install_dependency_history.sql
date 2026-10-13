-- WHSProject User DB migration 005
-- Root package 요청 시점의 Arborist dependency closure를 보관한다.
-- 기존 tarball별 request_id는 변경하지 않고,
-- Root tarball의 request_id를 root_request_id로 참조한다.

BEGIN;

CREATE TABLE IF NOT EXISTS install_dependency_history (
    root_request_id TEXT NOT NULL,

    root_package_name TEXT NOT NULL,
    root_package_version TEXT NOT NULL,

    package_name TEXT NOT NULL,
    package_version TEXT NOT NULL,
    integrity TEXT NOT NULL,

    captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (
        root_request_id,
        package_name,
        package_version,
        integrity
    )
);

-- 특정 패키지가 과거 어떤 Root 설치에 포함됐는지 역조회한다.
CREATE INDEX IF NOT EXISTS install_dependency_history_package_idx
    ON install_dependency_history (
        package_name,
        package_version,
        captured_at DESC
    );

-- 하나의 Root 요청에 포함된 전체 dependency 목록을 조회한다.
CREATE INDEX IF NOT EXISTS install_dependency_history_root_request_idx
    ON install_dependency_history (root_request_id);

COMMENT ON TABLE install_dependency_history
    IS 'Root npm 설치 요청 시점의 Arborist dependency closure 이력';

COMMENT ON COLUMN install_dependency_history.root_request_id
    IS 'Root tarball 요청의 Gateway request_id. 기존 개별 tarball request_id를 변경하지 않는다.';

COMMENT ON COLUMN install_dependency_history.root_package_name
    IS '사용자가 직접 설치를 요청한 Root package 이름';

COMMENT ON COLUMN install_dependency_history.root_package_version
    IS 'Root package의 해석된 실제 version';

COMMENT ON COLUMN install_dependency_history.package_name
    IS '해당 Root dependency closure에 포함된 package 이름';

COMMENT ON COLUMN install_dependency_history.package_version
    IS '해당 dependency의 해석된 실제 version';

COMMENT ON COLUMN install_dependency_history.integrity
    IS 'Arborist가 반환한 npm package integrity';

COMMIT;
