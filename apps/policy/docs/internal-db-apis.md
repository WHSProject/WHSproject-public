# Internal DB API

Gateway와 Scanner 구현 전 단계에서 Policy 평가 흐름을 검증하기 위한 내부 API입니다.
Evidence DB API, Policy DB API, Decision DB API의 코드는 모두 `apps/policy` Component
내부에 위치합니다. 실행 시에는 Database별 환경변수와 포트를 분리한 Compose Service로
구동하며, DB API별 별도 디렉터리는 사용하지 않습니다.

## API 구성

| Service | Port | Database | Endpoint |
| --- | ---: | --- | --- |
| Evidence DB API (`apps/policy/app/evidence_api.py`) | 8100 | `evidence_db` | `POST/GET /internal/v1/evidences`, artifact lookup |
| Policy DB API (`apps/policy/app/policy_db_api.py`) | 9000 | `policy_db` | active policy, version CRUD/publish, atomic dashboard apply, predicate registry |
| Policy Engine | 8000 | 없음 | `GET /health`, `POST /internal/v1/evaluations` |
| Decision DB API (`apps/policy/app/decision_db_api.py`) | 9100 | `decision_db` | `POST/GET /internal/v1/decisions`, `POST /internal/v1/feed-lookups`, `POST/GET /internal/v1/llm-judgments` |

## Evidence DB API

### `POST /internal/v1/evidences`

Policy Evaluation의 Evidence Contract를 받아 `evidences`와 하위 테이블에 저장합니다.
응답은 저장된 `EvidenceV0_1`이며, 중복 `evidenceId`는 `409 EVIDENCE_ALREADY_EXISTS`입니다.

### `GET /internal/v1/evidences/{evidenceId}`

Evidence를 원본 Contract 형태로 조회합니다. 없으면 `404 EVIDENCE_NOT_FOUND`입니다.

### `GET /internal/v1/evidences/by-artifact`

`ecosystem`, `packageName`, `packageVersion`, `artifactHash`와 선택적 `scanId`가 모두
일치하는 기존 Evidence를 조회합니다. Feed 재평가는 이 결과만 사용하며 Evidence를
임의 생성하지 않습니다. Decision이 참조한 ID를 재구성할 수 없으면 해당 Job을 실패
처리하고 기존 Decision을 유지합니다.

## Policy DB API

### `GET /internal/v1/predicates`

활성 predicate registry를 정책 적용 여부와 무관하게 반환합니다. 응답은 `{ "predicates": [...] }`이며
각 항목은 `code`, `description`, `category`, `requiresFeedEvidence`, `rejectAllowed`를 포함합니다.

### `POST /internal/v1/policies/{policyKey}/versions`

Dashboard Rule 형식으로 새 버전을 만들고 활성화합니다. `baseVersion` 확인, 현재 버전 보관,
새 `PUBLISHED` 버전과 Rule 저장이 하나의 PostgreSQL transaction에서 실행됩니다. 동시 적용은
직렬화되며 base가 바뀌면 `409 POLICY_CHANGED`, 중복 버전이면 `409 POLICY_VERSION_ALREADY_EXISTS`,
미등록 조건이면 `422 UNKNOWN_POLICY_PREDICATE`, 나머지 Rule 검증 오류면
`422 INVALID_POLICY_RULE`을 반환합니다. Rule priority는 1~100이며 중복될 수 없습니다.

기존 `POST /internal/v1/policies`와 `POST …/versions/{version}/publish`도 호환성을 유지합니다.
요청의 `createdByUserId`, `updatedByUserId`는 선택 UUID입니다. 버전 목록·상세도 같은 필드를
반환합니다. `policies.created_by_user_id`, `updated_by_user_id`는 nullable이며 Dashboard DB와
다른 데이터베이스이므로 외래 키를 두지 않습니다. 새 DB는 compose bootstrap에서 migration 006을
적용합니다. 기존 `policy_db` 볼륨은 `infra/postgres/migrations/policy/006_policy_actor_user_ids.sql`을
한 번 적용해야 합니다.

기존 publish 경로는 DRAFT 활성화를 거절하고, 활성 정책과 Policy 내부 버전이 다른 버전의 재발행도
거절합니다. 같은 내부 버전의 보관된 사용자 버전 재적용은 허용합니다.

### `GET /internal/v1/policies/active`

`policy_db`에서 `ecosystem = npm`이고 `status = PUBLISHED`인 정책 하나와
`enabled = TRUE`인 Rule을 조회합니다. 응답은 기존 Policy Engine Contract를 사용합니다.

Published Policy가 없으면 `404 ACTIVE_POLICY_NOT_FOUND`입니다.

Active Policy 응답에는 `predicates` 배열도 포함됩니다. 이 배열은 `policy_predicates` 테이블의
활성 predicate registry이며 각 항목의 `code`, 설명, category, `requiresFeedEvidence`,
`rejectAllowed`를 제공합니다. Rule의 `condition_json.when.allOf/anyOf`는 이 registry에 등록된
code만 사용할 수 있고, Policy를 publish할 때 미등록 code는 `422 UNKNOWN_POLICY_PREDICATE`로
거부됩니다. 따라서 새 predicate는 TypeScript enum을 수정하는 대신 registry에 등록한 뒤
Dashboard에서 정책 rule에 사용할 수 있습니다.

## Decision DB API

### `POST /internal/v1/decisions`

요청 형식은 다음과 같습니다.

```json
{
  "policyKey": "npm-default",
  "decision": {
    "decisionId": "dec-example",
    "requestId": "00000000-0000-4000-8000-000000000001",
    "score": 75,
    "decision": "REVIEW",
    "reasonCode": "SCORE_REVIEW",
    "reason": "Manual review is required.",
    "matchedRuleIds": ["SCORING-THRESHOLD"],
    "evidenceIds": ["evidence-001"],
    "assessmentIds": [],
    "scanId": "00000000-0000-4000-8000-000000000002",
    "policyVersion": "e2e-0.1",
    "feedSnapshotId": null,
    "feedEvidenceIds": null,
    "subject": {
      "ecosystem": "npm",
      "packageName": "demo-package",
      "packageVersion": "1.0.0",
      "artifactHash256": "sha256:demo",
      "artifactHash512": "sha512-demo"
    },
    "evaluatedAt": "2026-08-21T00:00:00Z"
  }
}
```

`requestId`와 `scanId`는 현재 Decision DB Schema가 UUID이므로 UUID 형식이어야 합니다.
저장 API는 `201`과 DB Record를 반환하고, Policy Engine이 생성한 `decisionId`도 그대로 저장합니다.
동일 Decision ID로 재시도하면 기존 저장 결과를 반환해 멱등적으로 처리합니다.
재평가 lineage를 허용하기 위해 동일 요청·Policy 조합에 대한 기존 unique 제약은 제거되었습니다.
동일 `decisionId` 재시도는 같은 request/scan/package/artifact identity인 경우에만 기존 row를
반환합니다. 다른 identity가 같은 ID를 사용하면 `409 DECISION_ID_CONFLICT`입니다. 일반 평가의
ID는 패키지별 `scanId`에서 `dec_{scanId}`로 만들고, 재평가 Decision은 별도 ID와
`previousDecisionId`를 사용합니다. 별도 request/package/policy unique constraint와 충돌해도
성공으로 바꾸지 않고 `409 DECISION_CONFLICT`를 반환합니다.

### Dashboard 읽기 API

- `GET /internal/v1/decisions/packages?q=&decision=&page=&pageSize=`는 패키지 버전별 최신 판정을
  최신순으로 반환합니다. 이름·버전 검색은 대소문자를 구분하지 않고, page는 1부터 시작하며
  pageSize는 1~100입니다.
- `GET /internal/v1/decisions/package-versions?packageName=`는 정확한 패키지 이름의 버전별 최신
  판정을 반환합니다. 패키지 이름은 query parameter이므로 `@scope/name`도 처리합니다.
- `GET /internal/v1/decisions/summary?from=&to=`는 반열린 시간 범위 `[from, to)`의 총계,
  판정별 총계, 시작 시각부터 1시간 간격의 빈 구간을 포함한 시간별 건수를 반환합니다.
- Dashboard는 Decision DB의 `DECISION_DB_URL`, Evidence DB의 `EVIDENCE_DB_URL`을 사용합니다.

성공 OSV Feed가 실제 평가에 사용된 경우 `feedSnapshotId`에 Snapshot UUID를 저장하고,
최종 Decision rule이 실제 참조한 검증된 OSV 근거만 `feedEvidenceIds`에 저장합니다. Policy가
인용한 Scanner Evidence는 `evidenceIds`, LLM Assessment 식별자는 `assessmentIds`에 저장합니다. Feed가
없거나 실패했고 참조 근거도 없으면 두 필드는 `null`입니다. 숫자 기반 scoring은
사용하지 않으며 새 Decision의 `score`는 `null`입니다.

Policy Evaluation의 `subject.artifactHash`와 `subject.integrity`는 Decision DB 요청에서
각각 `subject.artifactHash256`과 `subject.artifactHash512`로 명시적으로 변환됩니다.
이 값들은 각각 `artifact_hash_256`과 `artifact_hash_512` 컬럼에 저장됩니다. Decision DB
요청에서는 알고리즘이 명확한 두 필드만 사용하며, legacy `artifactHash` 필드는 사용하지
않습니다.

### `POST /internal/v1/feed-lookups`

Policy가 검증한 OSV 조회 결과를 Decision보다 먼저 저장하는 내부 API입니다. 모든
`SUCCESS`, `FAILED`, `TIMEOUT`, `SKIPPED` 결과와 `complete` 상태는 `feed_lookup_attempts`에 저장합니다.
`SUCCESS`이면서 `complete=true`인 결과만 원본 Advisory와 정규화·검증 결과를 분리한
`feed_snapshots` row를 만들고 Attempt의 `snapshot_id`로 연결합니다. 정상 빈 Advisory도
성공 Snapshot입니다.

Snapshot의 `content_digest`는 package identity와 Advisory ID/aliases/affected/severity/
withdrawn 및 Policy 검증 결과의 canonical JSON SHA-256입니다. 수집·검증·만료 시각과
Attempt 이력은 digest에 포함하지 않습니다. `expires_at`은 `validated_at + 1 hour`이며,
Cache read는 만료 전 Snapshot만 사용합니다. 성공 저장 시 동일 identity와 digest가 있으면
TTL과 무관하게 기존 Snapshot을 재사용하고 원래 시각을 갱신하지 않습니다. Digest가
달라진 경우에만 새 Snapshot을 생성합니다.

`request_id`는 unique이므로 동일 요청 재시도는 기존 Attempt와 Snapshot 참조를 반환합니다.
Snapshot/Attempt 저장은 한 transaction이며 어느 한쪽이라도 실패하면 각각
`FEED_SNAPSHOT_PERSISTENCE_FAILED` 또는 `FEED_ATTEMPT_PERSISTENCE_FAILED`로 응답하고
Decision 저장을 진행하지 않습니다.

Fixture 기반 custom predicate 검증은 `POLICY_LLM_FIXTURE_SCENARIO=positive`와
`POLICY_LLM_FIXTURE_TARGET_PREDICATE=<registry-code>`를 사용합니다. 해당 predicate에
`SUPPORTED`와 직접 인용된 Evidence가 생성되며, `negative` 시나리오는 `NOT_SUPPORTED`와
빈 인용을 생성합니다. 운영과 유사한 비교가 필요하면 `POLICY_LLM_SHADOW_MODE=openai`로
실제 GPT를 Shadow 호출하고 Primary와의 결정 차이를 함께 저장합니다.

### `POST /internal/v1/llm-judgments`

Policy Engine이 Policy GPT를 호출할 때 생성한 감사 이력을 저장합니다. `prompt`, Provider의
원본 응답(`responseJson`), 파싱된 판단 JSON(`judgmentJson`), 모델·Provider 요청 ID·소요 시간,
검증 실패 코드, TypeScript Resolver 결과를 함께 보존합니다. `runMode`가 `PRIMARY`이면 실제
판정에 사용된 실행이고, `SHADOW`이면 최종 판정에 영향을 주지 않는 후보 실행입니다.
Shadow 실행은 `shadowOfJudgmentId`와 `comparison`으로 Primary와의 decision/reasonCode 차이를
기록합니다. 이 저장은 최종 Decision 저장 전에 수행됩니다.

추가 감사 필드는 다음과 같습니다.

- `provider`: `openai`, `fixture` 등 Provider adapter 식별자
- `promptVersion`: Policy prompt contract 버전
- `inputHash`: 실제 Provider 입력인 최종 prompt 문자열의 UTF-8 SHA-256
- `evaluatedAt`: 해당 실행의 평가 시각. `createdAt`은 DB 저장 시각입니다.

`inputHash`는 Active Policy snapshot hash인 `policyHash`와 별개입니다. Prompt에 포함되지
않는 API key, Authorization header, request ID, 호출 시각, duration은 hash 입력에서 제외하며,
기존 row의 누락 값은 backfill하지 않습니다. migration 009는 기존 row와 호환되도록 새
metadata column을 nullable로 추가합니다.

`GET /internal/v1/llm-judgments/{id}`는 원본 감사 이력을 조회합니다. 해당 이력은 Policy
판정 재현과 장애 분석을 위한 내부 데이터이며, 일반 Gateway 응답에는 prompt와 원본 응답을
노출하지 않습니다.

### `POST /internal/v1/decisions/lookup`

Gateway가 Arborist로 추출한 의존성 목록을 한 번에 조회하는 배치 API입니다.
조회 조건은 `packageName`, `version`, npm Registry SRI `integrity`이며,
`policyVersion`은 조회 조건으로 사용하지 않습니다.

```json
{
  "requestId": "f44203a5-0f44-43ba-8481-34ca77608578",
  "packages": [
    {
      "packageName": "example-package",
      "version": "1.0.0",
      "integrity": "sha512-demo"
    },
    {
      "packageName": "@scope/another",
      "version": "2.3.1",
      "integrity": "sha512-other"
    }
  ]
}
```

요청한 모든 Package에 대해 입력 순서를 유지하여 결과를 반환합니다. 동일한
Package에 Decision이 여러 건이면 `evaluated_at`이 가장 최신인 1건을 사용합니다.

```json
{
  "requestId": "f44203a5-0f44-43ba-8481-34ca77608578",
  "results": [
    {
      "packageName": "example-package",
      "version": "1.0.0",
      "integrity": "sha512-demo",
      "lookupStatus": "FOUND",
      "decisionId": "dec-example",
      "decision": "ACCEPT",
      "policyKey": "default-npm-policy",
      "policyVersion": "1.0.0",
      "evaluatedAt": "2026-08-22T08:00:00Z"
    },
    {
      "packageName": "@scope/another",
      "version": "2.3.1",
      "integrity": "sha512-other",
      "lookupStatus": "NOT_FOUND"
    }
  ]
}
```

`FOUND`는 과거 판정 기록이 있다는 뜻이며, `decision` 값이 실제 후속 처리
기준입니다. `FOUND + ACCEPT`는 Verdaccio 전달, `FOUND + REJECT`는 차단,
`NOT_FOUND`는 Scanner 검사 대상으로 분기합니다. `HOLD`와 `REVIEW`의 후속
처리 기준은 별도 정책이 필요합니다.

### `GET /internal/v1/decisions/{id}`

Decision DB 내부 Record를 조회합니다.

Path Parameter인 `id`는 Decision DB의 내부 UUID Primary Key입니다.

```text
GET /internal/v1/decisions/{id}
```

예시:

```text
GET /internal/v1/decisions/77960cf0-eb5f-4d07-a030-9b76fac97e91
→ 200 OK
```

식별자는 다음과 같이 구분합니다.

```text
id = 내부 DB Record 식별자(UUID)
decisionId = 외부 Decision 식별자(dec_xxx)
```

현재 이 단건 조회 API는 내부 UUID `id`를 기준으로 동작하며, 재평가 Processor는
별도 내부 경로 `GET /internal/v1/decisions/by-decision-id/{decisionId}`로 직전
Decision을 조회합니다.

따라서 `dec_xxx` 형식의 값을 전달하면 UUID 검증에 실패하여
`422 Unprocessable Entity`가 반환됩니다. 이는 현재 API Contract에 따른 정상 동작입니다.

### ReevaluationJob 내부 API

판단 관련 digest가 직전 성공 Snapshot과 다르고 해당 Snapshot을 참조한 Decision이
있을 때만 Job이 `QUEUED`로 생성됩니다. `(previous_decision_id, trigger_snapshot_id)`
unique constraint로 중복을 막고, 상태는 `QUEUED → RUNNING → COMPLETED` 또는
`FAILED`로 전환됩니다. 모든 전환은 `reevaluation_job_events`에 감사 저장됩니다.

- `GET /internal/v1/reevaluation-jobs/{jobId}`
- `POST /internal/v1/reevaluation-jobs/{jobId}/claim`
- `POST /internal/v1/reevaluation-jobs/{jobId}/fail`
- `POST /internal/v1/reevaluation-jobs/{jobId}/process` (Policy Engine)

재평가 Decision은 기존 row를 수정하지 않고 `previousDecisionId`, `triggerSnapshotId`,
`feedSnapshotId`와 재사용 Evidence provenance를 저장합니다. Decision INSERT와 Job
완료 전환은 하나의 Decision DB transaction에서 처리됩니다.

## 검증 흐름

```text
1. Evidence DB API에 Evidence POST
2. Evidence DB API에서 Evidence GET
3. Policy DB API에서 Active Policy GET
4. Policy Engine에 Evidence POST
5. Policy Engine이 Policy DB API를 호출하고 Decision 생성
6. Policy Engine이 Decision DB API에 Feed Snapshot/Attempt POST
7. Policy Engine이 Decision DB API에 Snapshot 참조를 포함한 Decision POST
8. Policy Engine이 저장된 Decision Record의 내부 UUID id와 저장 상태를 반환
9. 필요할 때 Decision DB API에서 저장 결과 GET
```

이 API들은 Gateway와 Scanner의 최종 API가 아닙니다. Gateway/Scanner 구현 전
Policy·DB 컴포넌트 간 MVP 통합 검증을 위한 내부 API입니다.
