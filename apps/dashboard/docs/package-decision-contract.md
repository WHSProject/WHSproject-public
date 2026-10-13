# Dashboard Package·Overview 화면 데이터 명세

Dashboard Package 페이지(`/packages`, #432)와 Overview(`/`, #439)가 판정(Decision)·근거(Evidence)를 읽는 형식입니다.
Rule 페이지처럼 Dashboard가 필요한 형식을 먼저 정해 화면을 만들었고, 없는 API는 Policy에 요청합니다.

## 요청 요약

| 절 | 요청 | 우선순위 |
|---|---|---|
| 3.0 | 판정 id를 패키지마다 유일하게(같은 요청의 두 번째 패키지부터 판정이 저장되지 않음) | **결함, 가장 먼저** |
| 3.1 | 패키지 목록 API | 필수 |
| 3.2 | 패키지 버전 이력 API | 필수 |
| 3.3 | 판정 요약 API | 필수 |
| 5 | 계약 결정: 정책 key 안정성 및 evidence 순서 | 결정 완료 |

## 1. 현재 단계

Package·Overview는 `src/lib/decision/server/decision-db.ts`를 통해 Decision DB API와 Evidence DB API를 읽습니다.
정책(적용 중 정책, 판정한 버전의 Rule)은 Policy DB API에서 읽고, 사용자 설치 요청은 Dashboard 소유 `user_db.download_events`에서 읽습니다.

| 화면 | 데이터 | API |
|---|---|---|
| 목록 | 패키지 버전별 최신 판정(검색·판정 필터·페이지) | 3.1 |
| 상세 | 판정(사유, 매칭 Rule 코드, 근거 id, 정책 버전) | 기존 `GET /internal/v1/decisions/by-decision-id/{decisionId}` |
| 상세 | 매칭 Rule 이름·조건 | 기존 `GET /internal/v1/policies/{policyKey}/versions/{policyVersion}` |
| 상세 | 근거(신호 종류·분류·요약) | 기존 `GET /internal/v1/evidences/{evidenceId}`, 짧은 Assessment ID는 `GET /internal/v1/evidences/by-artifact`로 해석 |
| 상세 | 같은 패키지의 버전별 판정 | 3.2 |
| Overview | 최근 24시간 판정 수·판정별·시간대별 | 3.3 |
| Overview | 최근 판정 6건(설치 시도 사용자·트리거된 Rule 포함) | 3.1(`pageSize=6`), Rule 이름은 기존 Policy DB API(판정한 버전 상세), 사용자는 `user_db.download_events`(Dashboard 소유) |
| Overview | 적용 중 정책(버전, 사용 중 Rule 수, 적용한 사람) | 기존 Policy DB API(active·버전 상세·버전 목록) |

## 2. 기존 API에서 쓰는 필드

- 판정(Decision DB API): `decisionId`, `scanId`, `decision`, `reasonCode`, `reason`, `matchedRuleIds`(Rule 코드), `evidenceIds`, `assessmentIds`, `policyKey`, `policyVersion`, `subject.ecosystem`, `subject.packageName`, `subject.packageVersion`, `subject.artifactHash256`/`artifactHash512`, `evaluatedAt`
- 근거(Evidence API): `evidenceId`, `kind`, `signal.type`, `signal.category`, `assertion.summary`, `provenance.assessmentId`, `verificationStatus`
- `assessmentIds`는 전체 Evidence ID 또는 Assessment의 짧은 `provenance.assessmentId`일 수 있습니다. 단건 조회가 404인 짧은 ID는 동일 artifact·scan 목록에서 `kind=LLM_ASSESSMENT`, `verificationStatus=VERIFIED`, `provenance.assessmentId` 일치 조건으로 해석합니다. 실제 인용 ID와 일치하지 않는 Assessment는 표시하지 않습니다.
- 매칭 Rule은 적용 중 버전이 아니라 **판정한 `policyVersion`의 Rule**에서 `ruleCode`로 찾습니다.
- `score`는 쓰지 않습니다. 엔진이 저장하지 않습니다(`null`).

## 3. Policy에 요청하는 API (Decision DB API)

### 3.0 (결함) 같은 요청의 두 번째 패키지부터 판정이 저장되지 않음

- 판정 id가 요청 단위입니다: `dec_${requestId}`(`apps/policy/src/decision/decision-db.client.ts`).
- Gateway는 판정이 없는 패키지 여러 개를 requestId 하나로 Scanner에 보내고(`apps/gateway/src/services/decision-handler.service.ts`), Scanner는 패키지마다 같은 requestId로 평가를 요청합니다(`apps/scanner/src/api/scan.controller.ts`).
- Decision DB API는 `ON CONFLICT (decision_id) DO NOTHING` 후 기존 행을 돌려주므로(`apps/policy/app/decision_db_api.py`), 두 번째 패키지부터는 저장되지 않은 채 첫 패키지의 판정이 `SAVED`로 응답됩니다.
- 재현(2026-10-02, 격리 환경, 엔진의 `HttpDecisionDbClient.save`를 실제 Decision DB API에 호출): 같은 requestId로 pkg-a(ACCEPT)·pkg-b(REJECT) 저장 → 둘 다 `SAVED`·같은 DB id, DB에는 pkg-a 1건, Gateway 조회에서 pkg-b `NOT_FOUND`(REJECT 판정 유실, 계속 차단·재검사).
- 영향: 의존성이 많은 패키지를 처음 설치하면 하위 패키지 판정 대부분이 남지 않습니다. Dashboard의 Package 목록·상세, Request의 판정 연결도 판정 id로 이어집니다.
- 요청: 판정 id를 패키지마다 유일하게 만들어 주세요(예: `dec_${scanId}` 또는 UUID). 저장 충돌을 성공으로 응답하지 않도록 하는 것도 검토 부탁드립니다. 원인이 Scanner·Gateway와 걸쳐 있어 두 파트에도 함께 공유합니다.

### 3.1 패키지 목록

`GET /internal/v1/decisions/packages?q=&decision=&page=&pageSize=`

| 값 | 설명 |
|---|---|
| `q` | 선택. 패키지 이름 또는 버전 부분 일치, 대소문자 무시(최대 100자) |
| `decision` | 선택. `ACCEPT` / `REJECT` / `HOLD` / `REVIEW` |
| `page`, `pageSize` | 1부터. Dashboard는 `pageSize=15` |

```json
{
  "total": 23,
  "page": 1,
  "pageSize": 15,
  "items": [
    { "decisionId": "dec_…", "requestId": "5a4298e8-…", "packageName": "minipass-fetch", "version": "5.0.2", "decision": "REJECT", "evaluatedAt": "2026-10-01T01:12:00Z", "matchedRuleIds": ["RULE-…"], "policyKey": "qa-npm-policy", "policyVersion": "0.1.0" }
  ]
}
```

- 한 줄 = 패키지 버전(`ecosystem`·`packageName`·`version`) 하나의 **가장 최근 판정**(재판정이 있으면 마지막 판정)
- 최신 판정순(`evaluatedAt` 내림차순), `total`은 조건에 맞는 전체 개수
- `requestId`: 판정을 만든 Gateway 요청 ID(`x-request-id`). Dashboard가 `user_db.download_events.request_id`로 설치를 시도한 사용자를 찾습니다(판정은 재사용되므로 처음 판정을 만든 요청의 사용자)
- `matchedRuleIds`·`policyKey`·`policyVersion`: Overview가 판정한 정책 버전에서 첫 Rule(판정을 정한 Rule)의 이름을 찾아 "트리거된 Rule"로 보여 줍니다

### 3.2 패키지 버전 이력

`GET /internal/v1/decisions/package-versions?packageName=`

```json
{ "packageName": "minipass-fetch", "versions": [ /* 3.1 items와 같은 형식, 최신순 */ ] }
```

- 패키지 이름에 `/`가 들어갈 수 있어(`@scope/name`) 경로가 아니라 쿼리 값으로 받습니다.

### 3.3 판정 요약

`GET /internal/v1/decisions/summary?from=&to=` (ISO 시각, Dashboard는 지금부터 24시간 전 ~ 지금)

```json
{
  "from": "2026-09-30T02:00:00Z",
  "to": "2026-10-01T02:00:00Z",
  "total": 20,
  "byDecision": { "ACCEPT": 11, "REJECT": 3, "HOLD": 2, "REVIEW": 4 },
  "hourly": [ { "hour": "2026-09-30T02:00:00Z", "total": 1, "notAccepted": 0 } ]
}
```

- `total`·`byDecision`: 기간 안에 만들어진 판정 수(재판정 포함)
- `hourly`: `from`부터 1시간씩, 빈 시간대도 0으로 포함(24개). `notAccepted` = ACCEPT가 아닌 판정 수

## 4. 연결할 때 Dashboard 변경

- 환경변수: Dashboard 서비스에 `DECISION_DB_URL`(decision-db-api), `EVIDENCE_DB_URL`(evidence-api) 추가
- `decision-db.ts` 함수 본문을 HTTP 호출로 교체, 연결 실패 안내 추가
- 화면·타입·`server/packages.ts`는 그대로

## 5. 계약 결정

1. **정책 key는 안정적인 식별자이며 기존 정책에서 바꾸지 않습니다.** 이름이나 Rule, 버전이 달라져도 같은 정책이면 `policyKey`를 유지합니다. 별도 정책으로 분리할 때만 새 key를 발급합니다. Decision의 `policyKey`·`policyVersion`으로 과거 판정의 정확한 정책 버전을 찾고 Package 상세의 Rule 링크를 유지하기 위한 계약 결정입니다.
2. **`evidenceIds`는 판정을 결정한 Rule의 근거가 먼저 오도록 Rule 우선순위와 조건 순서를 보존합니다.** 첫 근거를 대표 근거로 취급할 수 있습니다.

## 구현 반영 현황 (2026-10-02)

- 판정 ID는 패키지별 `scanId` 기반 `dec_{scanId}`로 바꾸었습니다. 같은 ID가 다른 request/scan/package/artifact를 가리키면 Decision DB가 `409 DECISION_ID_CONFLICT`로 거절합니다.
- 3.1~3.3의 패키지 목록, 패키지 버전 이력, 판정 요약 API를 Decision DB에 추가했습니다.
- Dashboard 서버는 목업 대신 `DECISION_DB_URL`·`EVIDENCE_DB_URL`을 사용합니다. Decision/Evidence 연결 오류는 Package·Overview 화면에 표시합니다.
- `evidenceIds`는 Rule 우선순위와 Rule 조건 순서를 보존해 대표 근거가 먼저 오도록 변경했습니다.
- 계약 결정: `policyKey`는 안정적인 정책 식별자로 유지합니다. 정책 이름·Rule·버전 변경 시에도 기존 key를 사용하고, 별도 정책을 만들 때 새 key를 사용합니다. Dashboard는 Decision에 저장된 `policyKey`와 `policyVersion`으로 해당 정책 버전을 조회합니다.
