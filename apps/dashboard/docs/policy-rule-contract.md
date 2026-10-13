# Dashboard → Policy Rule 전달 명세

Dashboard Rule 페이지(`/rules`)가 Policy에 Rule을 전달하는 형식입니다.
Policy 쪽 병목으로 Dashboard가 형식을 먼저 정해 구현했고, Policy가 이 형식에 맞춰 개발합니다(2026-09-30 합의, 이슈 #362).

## 요청 요약

| 절 | 요청 | 우선순위 |
|---|---|---|
| 4.1 | 적용 API(새 버전 생성 + 활성화를 한 트랜잭션으로, 동시 적용 방지) | 필수 |
| 4.2 | 조건(predicate) 목록 API | 필수 |
| 4.3 | 판정 사유: `reason_code` 채우기, `reason`에 매칭 Rule 이름 | 필수 |
| 4.4 | 발행 API에서 초안·옛 내부 버전 활성화 막기 | 선택 |
| 4.5 | 버전 기록에 사용자 id 함께 저장 | 권장 |
| 1 | 지금 쓰는 Policy DB API 문서화 | 권장 |

Package·Overview가 쓰는 Decision DB 요청(판정 id 충돌 결함 포함)과 확인 질문은 `package-decision-contract.md`에 있습니다.

## 1. 현재 단계

Rule 적용은 Policy DB의 Dashboard 형식 API로 직접 요청합니다. 그 밖의 active·버전 목록·상세 조회는 기존 Policy DB API를 사용합니다.

| 동작 | 지금 쓰는 Policy DB API |
|---|---|
| 적용 중 정책·조건 목록 | `GET /internal/v1/policies/active` |
| 버전 상세(이름·Rule 전체) | `GET /internal/v1/policies/{key}/versions/{version}` |
| 버전 목록(다음 번호 계산) | `GET /internal/v1/policies/{key}/versions` |
| 적용 = 생성 + 활성화 | `POST /internal/v1/policies/{policyKey}/versions` (한 트랜잭션) |
| 이전 버전 다시 적용(Version 페이지) | `POST …/versions/{version}/publish` |

`active`를 뺀 나머지는 코드(`apps/policy/app/policy_db_api.py`)에는 있지만 `apps/policy/docs/api-specs/01-api-index.md`에는 없습니다. 문서화를 요청합니다.

## 2. Rule 형식

```json
{
  "ruleCode": "RULE-3F9A0C12",
  "name": "Credential 유출 차단",
  "decision": "REJECT",
  "priority": 90,
  "enabled": true,
  "matchAll": true,
  "conditions": ["CREDENTIAL_SOURCE_ACCESSED", "DATA_REACHES_EXTERNAL_SINK"],
  "minimumSupport": "SUPPORTED",
  "onUnknown": "HOLD"
}
```

| 필드 | 형식 | 설명 |
|---|---|---|
| `ruleCode` | `^[A-Z0-9][A-Z0-9_-]{0,63}$` | 식별 코드. Dashboard가 `RULE-` + 무작위 16진수 8자로 만듭니다. 새 버전에서도 같은 Rule은 같은 코드를 유지하고, 삭제된 코드는 재사용하지 않습니다. 판정 결과 `matched_rule_ids`에 남습니다. 기존 Rule(`RULE-REJECT-…` 등)은 코드를 그대로 씁니다. |
| `name` | 비어 있지 않은 문자열 | Rule 이름. 앞뒤 공백은 지우고 보냅니다. |
| `decision` | `ACCEPT` / `REJECT` / `HOLD` / `REVIEW` | 판정 |
| `priority` | 정수 1~100, 정책 안에서 중복 불가 | 큰 값부터 평가(단, 맞는 REJECT Rule은 우선순위와 관계없이 먼저 적용, 5절) |
| `enabled` | boolean | 활성 여부 |
| `matchAll` | boolean | `true`: 모든 조건(AND, `allOf`), `false`: 하나 이상(OR, `anyOf`) |
| `conditions` | predicate 코드 배열, 1개 이상, 중복 불가 | Policy에 등록된 predicate만 |
| `minimumSupport` | `SUPPORTED` / `PARTIAL` (선택, 기본 `SUPPORTED`) | 이 Rule을 확정하려면 분석이 어디까지 끝나야 하는지. 화면에서는 "고급 설정" |
| `onUnknown` | `HOLD` / `REVIEW` / `IGNORE` (선택, 기본 `HOLD`) | 조건을 판단할 수 없을 때의 결과. 화면에서는 "고급 설정" |

화면에서는 조건을 한국어 이름(`src/lib/policy/common/labels.ts`)으로 보여 주지만, 저장·전달은 항상 원래 코드로 합니다. 나중에 Policy 등록 데이터에 표시 이름이 생기면 그것으로 바꿀 수 있습니다.

Dashboard가 저장 전에 검사하는 항목: 이름 필수, 조건 1개 이상·등록된 조건·중복 없음, 우선순위 1~100·중복 없음, 식별 코드 형식·중복 없음, REJECT Rule에 `rejectAllowed=false` 조건 사용 불가(엔진이 매칭하지 않으므로).

보내지 않는 값: `ruleKind`, `description`, `reasonCode`, `reasonMessage`.
지금 API는 이 값들이 필수라 변환할 때 `ruleKind: "HARD"`, `description: null`, `reasonCode: ruleCode`, `reasonMessage: name`으로 채웁니다.

## 3. 버전과 적용

- 버전 번호 `0.{Policy 내부 버전}.{사용자 버전}`. 첫 자리는 미정이라 0을 유지합니다.
- 적용 = 새 버전 생성 + 바로 활성화. 적용 중은 항상 하나이며 기존 적용 버전은 보관(ARCHIVED)됩니다.
- 새 번호는 Dashboard가 정합니다: 적용 중 버전과 같은 내부 버전 중 가장 큰 사용자 버전 + 1 (예: `0.1.2` 적용 중, `0.1.4` 초안이 남아 있으면 `0.1.5`).
- 편집을 시작한 버전(`baseVersion`)과 지금 적용 중 버전이 다르면 다른 사용자가 먼저 적용한 것이므로 거절합니다.
- 초안은 서버에 저장하지 않습니다(브라우저에서만 편집). 그래서 초안 수정·삭제 API는 필요 없습니다.

## 4. Policy에 요청하는 API

### 4.1 적용 (필수)

`POST /internal/v1/policies/{policyKey}/versions`

```json
{
  "baseVersion": "0.1.2",
  "version": "0.1.3",
  "createdBy": "kim_editor",
  "createdByUserId": "<UUID>", /* 4.5절 */
  "rules": [ /* 2절 Rule 형식 */ ]
}
```

- 새 버전을 만들고 바로 활성화합니다(지금의 생성 + 발행을 한 번에, 한 트랜잭션으로).
- 응답 201: `{ "policyKey": "...", "version": "0.1.3", "status": "PUBLISHED", "publishedAt": "..." }`

| 상태 | `detail.code` | 경우 |
|---|---|---|
| 409 | `POLICY_CHANGED` | `baseVersion`이 지금 적용 중 버전이 아님 |
| 409 | `POLICY_VERSION_ALREADY_EXISTS` | 같은 버전이 이미 있음 |
| 422 | `UNKNOWN_POLICY_PREDICATE` | 등록되지 않은 조건 |
| 422 | `INVALID_POLICY_RULE` | 2절 형식·검사 위반 |

오류 본문은 지금처럼 `{ "detail": { "code": "...", "message": "..." } }`를 유지해 주세요. Dashboard가 `code`로 안내 문구를 고릅니다.

### 4.2 조건 목록 (필수)

`GET /internal/v1/predicates` → `{ "predicates": [{ "code", "description", "category", "requiresFeedEvidence", "rejectAllowed" }] }`

독립 endpoint가 구현되어 활성 정책 조회와 별도로 predicate registry를 받을 수 있습니다. Rule 화면은 이 API를 사용합니다.

### 4.3 판정 결과 사유

- `reason_code`: 지금은 변환할 때 `reasonCode = ruleCode`를 보내고 엔진이 그 값을 씁니다. 4.1 형식에는 사유를 보내지 않으므로 Policy가 매칭 Rule의 `ruleCode`로 채워 주세요(`decisions.reason_code`는 NOT NULL).
- `reason`(사유 문장): 요청 당시 엔진은 `Policy rule {ruleCode} matched.`로 저장해 Package 상세의 "사유"에 코드만 보였습니다. 매칭 Rule의 이름(사용자가 Rule 페이지에서 정한 이름)을 넣어 주세요. 매칭 Rule이 없으면 기본 문장을 유지합니다.
- Package 화면은 판정의 `policy_version`과 `matched_rule_ids`로 "어느 버전의 어느 Rule로 판정했는지"를 보여 줍니다(#432 구현).

### 4.4 (선택) 옛 내부 버전 활성화 막기

Version 페이지(`/versions`, #426)는 가운데 숫자가 지금 Policy 내부 버전과 다른 버전과 초안(DRAFT)을 적용할 수 없게 합니다(Dashboard 서버에서 확인).
지금 `…/publish`는 상태와 무관하게 어떤 버전이든 다시 발행하므로 Policy에서도 막아 주시면 좋습니다.

### 4.5 사용자 id 함께 저장

요청 당시 Dashboard는 사람 정보로 username만 보내고, Policy는 그것을 `policies.created_by`·`updated_by`(TEXT)에 저장했습니다.

| 요청 | 지금 보내는 값 |
|---|---|
| 생성 `POST /internal/v1/policies` | `createdBy`, `updatedBy` = username |
| 발행 `POST …/versions/{version}/publish` | `updatedBy` = username |

username은 바뀔 수 있어서, 바뀌면 버전 기록의 사람을 찾을 수 없고 옛 이름을 다른 계정이 쓰면 그 사람의 기록처럼 보입니다.
Dashboard의 다른 기록(설치 기록, 권한 변경 이력)은 user id로 식별하므로 Policy 기록도 id를 함께 남겨 주세요.

- 요청 필드(선택, UUID = Dashboard `user_db.users.id`)
  - 생성: `createdByUserId`, `updatedByUserId` / 발행: `updatedByUserId` / 4.1 적용 API: `createdByUserId`
- 컬럼: `policies.created_by_user_id`, `updated_by_user_id` (UUID, NULL 허용). `user_db`와 DB가 달라 외래키는 걸지 않습니다.
- 응답: 버전 목록·상세에 `createdByUserId`, `updatedByUserId` (없으면 `null`)
- 기존 `createdBy`·`updatedBy`(username)는 그대로 둡니다(요청 당시 이름).

Policy 요청 모델은 `extra="forbid"`를 유지하면서 user ID 필드를 선택 입력으로 받습니다. Version 페이지는 id로 현재 이름을 보여 주고, id가 없는 옛 기록은 저장된 username을 보여 줍니다.

## 5. 합의된 엔진 동작 (참고)

- 어떤 Rule에도 해당하지 않으면 REVIEW
- 실제 판정 순서(`apps/policy/src/decision/decision.resolver.ts`): 맞는 REJECT Rule이 있으면 우선순위와 관계없이 REJECT → 근거 충돌이면 REVIEW → 판단 불가·분석 미완료면 HOLD(판단 불가 시 REVIEW로 정한 Rule이 있으면 REVIEW) → 맞는 Rule 중 우선순위가 가장 높은 Rule → 없으면 REVIEW. Overview의 "판정 방식" 안내가 이 순서를 따릅니다
- 적용 버전이 바뀌어도 기존 Decision은 재사용(재판정 없음)
- Policy 내부 버전이 오르면(0.3.x → 0.4.0) 사용자 Rule은 초기화되고 Policy 기본 Rule로 바뀜, 사용자 버전은 0부터(Policy 미구현)

## 6. 기존 데이터

QA 예제 정책(`002_qa_fixture.sql`, `004_expand_qa_policy.sql`)의 우선순위(10~1000)를 `005_qa_policy_priority_range.sql`에서 1~100으로 바꿨습니다(Policy 요청).
조건·판정·사유는 그대로이고, 평가 순서(큰 값 우선)도 유지합니다.

| Rule | 이전 → 이후 |
|---|---|
| RULE-REJECT-CONFIRMED-EXFIL / CHILD-PROCESS / REMOTE-CODE | 1000 / 950 / 900 → 100 / 95 / 90 |
| RULE-REVIEW-CREDENTIAL-ACCESS / OBFUSCATION / FUNCTIONALITY-MISMATCH | 700 / 600 / 500 → 85 / 80 / 75 |
| RULE-HOLD-NATIVE-BINARY | 400 → 70 |
| RULE-ACCEPT-BENIGN / HOLD-UNKNOWN-LINK / REVIEW-OSV-HIGH | 100 / 80 / 70 → 60 / 50 / 40 |
| RULE-HOLD-SCAN-TIMEOUT / REJECT-SHELL-EXEC | 20 / 10 (그대로) |

7개만 줄이면 004의 REVIEW Rule(500~700)이 RULE-ACCEPT-BENIGN(100)보다 뒤로 밀려 판정이 바뀔 수 있어, 002의 Rule도 함께 낮췄습니다.
새 DB는 `infra/postgres/init/00-bootstrap.sql`이 006까지 적용합니다. 기존 DB는 우선순위 범위에 맞는 005와 사용자 ID 컬럼을 추가하는 006을 적용해야 합니다.
005가 적용되지 않은 DB에서는 Dashboard가 범위를 벗어난 우선순위를 오류로 표시하고 고치기 전에는 적용할 수 없습니다.

## 구현 반영 현황 (2026-10-02)

- 4.1: Dashboard 형식의 새 버전 생성·활성화 API를 추가했습니다. `baseVersion` 비교, 기존 버전 보관, 신규 Rule 저장은 하나의 트랜잭션이며 동시에 적용하는 요청은 직렬화합니다.
- 4.2: 활성 정책이 없어도 쓸 수 있는 `GET /internal/v1/predicates`를 추가했고 Rule 화면이 이 API를 조회합니다.
- 4.3: 적용 API가 `reasonCode=ruleCode`, `reasonMessage=Rule 이름`으로 저장하고, Policy Decision의 `reason`에도 매칭 Rule 이름을 사용합니다.
- 4.4: 기존 publish API도 DRAFT와 다른 Policy 내부 버전의 활성화를 막습니다. 같은 내부 버전의 보관된 사용자 버전은 재적용할 수 있습니다.
- 4.5: Policy version에 actor UUID nullable 컬럼을 추가했습니다. Dashboard의 생성·발행 요청이 UUID를 보내며, Version 화면은 ID로 현재 Dashboard 사용자 이름을 표시하고 예전 레코드는 저장된 username을 사용합니다.
- 기존 Policy DB API의 버전 목록·상세·발행 계약을 `apps/policy/docs/internal-db-apis.md`에 문서화했습니다.
