# W7-SC-G-01 OSV 운영 검증

Issue #394. 기준 HEAD `04ab8086` (`origin/dev`와 동일). 검증일: 2026-09-29 UTC. 이 문서는 이번 검증에서 관측한 결과와 재현 절차를 기록한다. 실제 OSV advisory 수는 조회 시점에 따라 달라진다.

## 흐름과 책임

Scanner는 npm Registry metadata·tarball을 확인하고 Evidence를 Evidence API에 저장한다. OSV 조회는 Decision DB API의 FeedSnapshot cache를 먼저 확인하며, cache miss/stale이면 OSV에 질의한다. Scanner는 Evidence와 별도 `osvFeed`를 Policy Evaluation API에 보낸다. Policy는 Feed를 검증하여 FeedLookupAttempt 및 성공 FeedSnapshot을 Decision DB API에 저장하고, 활성 Predicate/Rule·fixture LLM Judgment·TypeScript Resolver로 최종 Decision을 계산한다. LLM 감사 이력과 Decision에는 requestId·scanId를 연결한다. Decision의 `score`는 새 평가에서 `null`이다. 성공 Snapshot ID와 실제 인용한 Feed Evidence ID만 Decision에 연결한다.

PostgreSQL bootstrap `infra/postgres/init/00-bootstrap.sql`은 evidence 001→002, policy 001→004, decision 001→009 순서로 migration을 적용한다. 이 작업은 migration, Predicate Registry, Rule, Prompt, Resolver, 공개 Evidence/Decision Schema를 변경하지 않는다.

## 기본 설정과 제한 시간

| 변수 | 기본값 | 의미 |
| --- | ---: | --- |
| `POLICY_LLM_MODE` | `openai` | 운영 Provider. 이 검증은 반드시 `fixture` |
| `POLICY_LLM_TIMEOUT_MS` | 20000 | Policy의 Provider 최대 대기 |
| `POLICY_TIMEOUT_MS` | 30000 | Scanner→Policy API 최대 대기; Compose에서도 override 전달 |
| `SCANNER_PACKAGE_TIMEOUT_MS` | 240000 | Scanner package 분석 deadline |
| `SCANNER_TIMEOUT_MS` | 300000 | Gateway→Scanner 대기 |
| `FEED_CACHE_TIMEOUT_MS` | 750 | Scanner→Decision DB cache 조회 |
| `OSV_REFRESH_WORKER_ENABLED` | `true` | `false`면 자동 polling 중단; 강제 갱신 API는 사용 가능 |
| `SCANNER_ADMIN_TOKEN` | 비어 있음 | 설정 시 Admin API Bearer 인증 요구. 운영에서는 반드시 별도 Secret 주입 |

OSV 클라이언트 전체 응답 한도는 2000 ms, Worker 개별 질의는 2500 ms다. Custom Rule Semgrep 한도는 30000 ms, GuardDog 기본 한도는 60000 ms다. Scanner package deadline은 분석 단계에 걸리며 Policy 호출은 별도 30000 ms다. 따라서 전체 Scanner 응답은 최악의 경우 package deadline에 Policy 대기가 더해질 수 있어 Gateway 300000 ms보다 작다. 이 값들은 기존 20초 Policy LLM, 60초 tarball/GuardDog 한도, 10초 Registry metadata 한도와 실제 Semgrep 소형 fixture 8.08초 측정을 근거로 잡았다. 별도 override는 유지한다. 전체 npm Gateway 요청의 fetch timeout(설치하는 쪽에서 360초로 설정, npm 기본 300초)과 후속 Verdaccio 시간은 운영 부하에서 계속 관찰해야 한다.

## Scanner 이미지 문제

변경 전 `docker compose build scanner`에는 target이 없어 마지막 `external-guarddog` stage가 선택됐다. 이미지 inspect는 `Entrypoint=["guarddog"]`, `Cmd=null`이고 실행은 GuardDog CLI usage 후 exit 2였다. Compose Scanner 서비스에 `build.target: runtime`을 지정했다. 변경 후 이미지 inspect는 Node 기본 Entrypoint `["docker-entrypoint.sh"]`, Cmd `["pnpm","--filter","scanner","start"]`, `/health/ready` 이미지 healthcheck다. 외부 artifact backend의 `external-guarddog` stage와 digest 사용 경로는 유지했다. CI의 Scanner 이미지 빌드도 runtime target과 inspect 검증을 사용한다. Evidence API를 Scanner와 같은 `whs` 네트워크에 추가해 기존 `EVIDENCE_DB_URL`을 실제로 연결했다.

## 격리 Compose 실행과 확인

프로젝트 이름과 환경파일을 명시하고 고유 host port·네트워크 CIDR을 사용하는 별도 override를 만든다. PostgreSQL 비밀번호와 Admin Token은 `/tmp`의 mode 0600 파일에 두고 출력하지 않는다. 기존 프로젝트나 volume을 대상으로 `down -v`를 실행하지 않는다.

```bash
docker compose --env-file /tmp/whs-w7-sc-394.env -f compose.yaml -f /tmp/whs-w7-sc-394.override.yaml -p whsw7sc394 config --quiet
docker compose --env-file /tmp/whs-w7-sc-394.env -f compose.yaml -f /tmp/whs-w7-sc-394.override.yaml -p whsw7sc394 up -d --build postgres evidence-api policy-db-api decision-db-api policy scanner
docker compose --env-file /tmp/whs-w7-sc-394.env -f compose.yaml -f /tmp/whs-w7-sc-394.override.yaml -p whsw7sc394 ps
```

이번 검증은 `whsw7sc394_postgres_data`만 생성했다. `POLICY_LLM_MODE=fixture`, `OSV_REFRESH_WORKER_ENABLED=false`로 실행했다. `/health/live`, `/health/ready`, Policy·DB API health와 Compose health를 확인한다. 격리 DB에 `feed_lookup_attempts`, `feed_snapshots`, `decisions`, `policy_llm_judgments`, `reevaluation_jobs`가 있는지 실제 schema로 확인한다.

## 실제 OSV smoke와 cache

Registry metadata에서 정확한 npm package/version과 `dist.integrity`를 확인한 다음 Scanner `POST /internal/v1/scans`에 UUID `requestId`, `packages: [{packageName, version, integrity}]`를 보낸다. 외부 smoke만 실제 npm Registry·OSV를 사용한다. 자동 Jest/Policy/Python 테스트는 고정 fixture/mock만 사용한다. GPT·Claude 실제 호출은 금지하고 `POLICY_LLM_MODE=fixture`로 둔다.

2026-09-29 08:59:29 UTC `lodash@4.17.20`: npm identity 일치, OSV Advisory 5건, 다음 페이지 없음. 08:59:30 UTC `is-number@7.0.0`: npm identity 일치, OSV Advisory 0건, 다음 페이지 없음. 09:18:33 UTC `minimist@1.2.5`: npm identity 일치, OSV Advisory 1건. 두 종류의 smoke 대상을 실제 응답에서 확인했다. 외부 호출은 이 대상들의 npm metadata와 OSV query, 후속 격리 Scanner/Worker scan의 npm·OSV 요청에 한정한다.

동일 package/version을 두 번 조회할 때 첫 성공 Attempt와 Snapshot의 `validated_at`, `expires_at`을 기록한다. Cache hit에서는 Snapshot ID가 재사용되고 두 시각이 유지되어야 한다. TTL은 1시간이며 `expires_at <= CURRENT_TIMESTAMP`이면 stale이다. 테스트는 고정 시각 또는 격리 DB 시각으로 경계를 검증한다. 성공 빈 advisory도 Snapshot이고 FAILED/TIMEOUT/SKIPPED·`complete=false`에는 Snapshot을 만들지 않는다. 실패 Attempt는 기존 성공 Snapshot을 수정·삭제하거나 TTL을 연장하지 않는다. 동일 digest 재사용과 advisory 판단 내용 변경 시 digest 변경은 Policy Feed persistence 테스트가 검사한다.

```sql
SELECT request_id, scan_id, package_name, package_version, feed_status, complete,
       error_code, snapshot_id FROM feed_lookup_attempts ORDER BY created_at DESC LIMIT 20;
SELECT id, package_name, package_version, jsonb_array_length(raw_advisories) AS advisory_count,
       content_digest, validated_at, expires_at FROM feed_snapshots ORDER BY created_at DESC LIMIT 20;
SELECT request_id, scan_id, package_name, package_version, decision, score,
       feed_snapshot_id, feed_evidence_ids FROM decisions ORDER BY created_at DESC LIMIT 20;
SELECT request_id, scan_id, status, failure_code FROM policy_llm_judgments ORDER BY evaluated_at DESC LIMIT 20;
```

## Worker와 Admin API

Worker 기본 polling 간격은 1시간, 최근 조회 lookback은 7일이다. Decision DB API는 최근 Attempt가 있고 아직 유효한 Snapshot이 없는 package/version을 선택한다. 프로세스 안에서는 동일 key 동시 실행을 막고, 실패 재시도는 최대 3회다. Job 상태는 QUEUED→RUNNING→SUCCEEDED/FAILED/TIMEOUT이며 현재 Job map은 메모리 기반이다. 재시작 시 과거 Job 조회는 유지되지 않지만 DB에 남은 최근 Attempt는 다음 polling에서 다시 후보가 될 수 있다. `OSV_REFRESH_WORKER_ENABLED=false`이면 자동 polling만 꺼진다. 강제 갱신은 cache hit에서 끝내지 않고 OSV live query를 실행한다.

```http
POST /internal/v1/admin/feeds/refresh
Authorization: Bearer <관리자 환경변수에서 안전하게 주입>
Content-Type: application/json

{"packageName":"is-number","packageVersion":"7.0.0"}
```

응답 HTTP 202의 `jobId`로 `GET /internal/v1/admin/feeds/refresh/{jobId}`를 조회한다. 인증이 설정된 이번 격리 실행에서 인증 누락·잘못된 값은 403, 잘못된 package 입력은 400, 정상 요청은 202, 진행 중 중복 요청은 동일 Job ID였다. 완료 상태는 `SUCCEEDED`, attemptCount 1, Snapshot ID 있음이었다. 토큰 값은 로그와 문서에 넣지 않았다.

## 장애와 복구

OSV HTTP 오류·timeout·잘못된 JSON·부분 수집·`complete=false`는 fixture transport로 만들고 성공 Snapshot이나 Policy Feed 근거를 만들지 않아야 한다. Feed DB API 오류·Policy timeout/Provider 오류·Decision DB 실패는 각 mock client와 격리 Compose에서 검사한다. Worker 실패 후 정상 query가 돌아오면 새 Job을 실행하고 기존 성공 Snapshot이 보존됐는지 확인한다. 서비스 복구는 해당 격리 서비스 상태/health 확인, DB Attempt의 `error_code` 조회, 원인 제거, 새 scan 또는 Admin 강제 갱신, 새 Attempt/Snapshot·Decision 참조 확인 순서다. Scanner나 Worker 재시작 뒤 메모리 Job은 사라지므로 이전 Job ID에 의존하지 않는다.

## 최종 E2E 관측 결과

격리 Compose에서 `lodash@4.17.20` scan은 requestId `d5d0095d-c307-42e0-8c41-ae06bef426f9`, scanId `93c416d4-ad68-41e6-bedf-c9cbaeef9e14`로 HTTP 200을 반환했다. Evidence 7건, raw advisory 5건, Decision `REVIEW`, `score=null`, 성공 FeedLookupAttempt·FeedSnapshot, Decision의 `feedSnapshotId`와 `feedEvidenceIds`(1건), Policy LLM 감사 `COMPLETED`를 확인했다. `minimist@1.2.5`(advisory 1건)와 `is-number@7.0.0`(빈 결과)도 각각 성공 Attempt/Snapshot, Decision 참조, `score=null`, fixture 감사 이력을 확인했다.

초기 실제 scan에서 Evidence API가 기존 공통 필드(`taxonomy`, `action`, `derivedFrom` line range, `capabilityPreservation`)를 역직렬화하지 못하는 문제가 드러났다. 저장소에 이미 존재하는 필드를 Python/TypeScript adapter가 수용하도록 정합성을 맞췄고, 공개 Evidence 의미나 Decision 계약은 바꾸지 않았다. 이후 재실행은 정상 완료됐다.

## 실행한 검증 명령

* `docker build --target runtime -f apps/scanner/Dockerfile .` 및 image inspect: runtime Entrypoint/Cmd 확인
* 격리 Compose `config --quiet`, `up -d --build`, `ps`, Scanner `/health/live`, `/health/ready`: 정상
* Scanner Docker 전체 Jest: **74 suites, 1172 tests passed** (2026-09-30 최종 재검증)
* Scanner targeted OSV/cache/worker/admin/compose tests: **4 suites, 18 tests passed**
* Policy `pnpm typecheck`, `pnpm build`, `pnpm test`: **92 tests passed**
* Policy `python -m pytest -q`: **74 passed**; `python -m compileall -q app tests`: 성공
* TTL, stale candidate, failure preservation, Admin 인증/중복/재시작, 격리 DB 참조 SQL: 성공
* `git diff --check`: 성공

## 이번 실행에서 확인한 제한

첫 `is-number@7.0.0` Scanner scan은 Custom Rule Semgrep 10초 timeout으로 HTTP 500이었다. 실제 작은 probe도 8.08초가 걸렸고, 이에 따라 고정 Semgrep 한도를 30초로 늘렸다. 이후 재시도와 최종 E2E는 정상 완료됐다.

## 2026-09-30 Evidence Contract 최종 검토

공유 `evidence-v0.1.schema.json`에서 `taxonomy`은 선택형 9개 enum, `action`은 선택형 길이 1 이상 문자열이다. `capabilityPreservation`은 선택형 strict object이고, 존재할 때 `before`, `after`, `status`, `preserved`, `lost`, `discovered`, `comparisons`, `limitations`가 필수다. `after`만 이 필수 필드 중 null을 허용한다. 비교·관측 객체도 추가 필드를 허용하지 않는다. `locations[].derivedFrom`은 비어 있지 않은 `path`가 필수이고, 선택형 `startLine`·`endLine`은 1 이상 정수다. 둘 사이의 순서 제약은 Schema에 없다.

Policy TypeScript 타입과 parser, Python Evidence 모델을 이 정의에 맞췄다. 신규 API 입력의 명시적 null과 잘못된 enum·중첩 타입은 거부한다. 과거 JSONB의 materialized null과 누락된 nullable `after`는 조회 단계에서만 보정한다. 신규 저장과 API 응답은 생략된 선택 필드를 null로 만들지 않으며, 필수 nullable `after`는 보존한다. Tier1 및 Tier2 저장·조회와 Policy 요청 테스트가 통과했다. 공유 Schema, Policy 판단 로직, DB migration은 수정하지 않았다.

동일 digest Feed Snapshot은 `expires_at > GREATEST(validatedAt, CURRENT_TIMESTAMP)`일 때만 재사용한다. 만료된 결과는 새 성공 Snapshot으로 저장하며, 실패와 Cache hit는 기존 TTL을 갱신하지 않는다.

Scanner 전체 테스트에서 기존 Tarball 리다이렉트 fixture의 12ms 예산은 느린 파일시스템에서 요청 전에 만료됐다. 두 리다이렉트와 하나의 전체 deadline을 확인하는 기대값은 유지하고, 응답 지연을 각각 250ms, 전체 deadline을 375ms로 비례 조정했다. 최종 전체 suite는 74/74, 테스트는 1172/1172 통과했다. 이번 재검증은 Mock·Fixture만 사용했고 npm Registry·OSV·GPT·Claude에 새 외부 요청을 보내지 않았다.
