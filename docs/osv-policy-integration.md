# OSV · Policy 통합 테스트 결과

> 현재 기준(2026-09-23): 이 문서 앞부분의 2026-09-09 점수 기반 내용은 구현
> 이력을 보존하기 위한 기록이다. 현행 Policy는 PR #301의 TypeScript GPT
> Judgment + deterministic Resolver이며 숫자 score를 판단에 사용하지 않는다.
> 현행 요구사항은 아래의 **LLM 전환 후 목표 설계**를 따른다.

## LLM 전환 후 목표 설계

### 유지하는 수집·전달 Contract

- Scanner가 OSV를 조회하고 Policy는 OSV 외부 API를 직접 호출하지 않는다.
- `osvFeed`는 Scanner → Policy 요청의 필수 top-level 필드이고 `source`는
  정확히 `OSV`다. Scanner Evidence 및 `LLM_ASSESSMENT`와 합치지 않는다.
- `SUCCESS`는 전체 페이지 수집 완료와 정상 빈 결과를 포함한다.
  `FAILED`, `TIMEOUT`, `SKIPPED` 및 미완전 수집은 Advisory를 전달하지 않는다.
- query/subject identity, 상태별 필드, Advisory ID/aliases/withdrawn,
  npm package/version/affected range, references, risk type와 원본 severity를
  Policy에서 검증한다. 개별 부적합 Advisory는 이유와 함께 제외한다.

### 현재 판단 경로

```text
Scanner evidences + 별도 osvFeed
  → Policy EvidenceCase + ValidatedOsvFeed
  → 활성 Policy에 OSV_ADVISORY_APPLIES predicate가 있을 때만
    Policy-local OsvFeedEvidence를 GPT 입력에 포함
  → GPT PolicyJudgment(SUPPORTED / NOT_SUPPORTED / UNKNOWN / CONFLICT)
  → 참조 validator
  → deterministic Policy Rule / Decision Resolver
```

OSV 근거는 `feedEvidenceId=osv:<advisoryId>`로 추적한다. 이 ID는 Scanner의
`evidences`나 `evidenceIds`에 삽입하지 않고 GPT 출력의 별도
`feedEvidenceIds`로만 참조한다. `OSV_ADVISORY_APPLIES` 외 predicate가 이를
참조하면 출력 검증에 실패한다.

OSV Advisory는 해당 npm package version에 알려진 취약점이 적용된다는 근거다.
민감 정보 접근, 외부 유출, 실행 경로, 악성 의도, benign 대안 부재를 입증하지
않는다. 따라서 활성 Policy에 OSV predicate가 없으면 Advisory 상세는 GPT 입력에서
제외한다. `OSV_ADVISORY_APPLIES`를 포함한 rule은 `REJECT` 효과로 구성되어도
deterministic Resolver가 REJECT로 확정하지 않는다. Scanner 악성 행위는 OSV와
분리된 REJECT rule에서 평가해 기존 Scanner 기반 REJECT를 보존한다.

### Severity와 장애 처리

Severity는 `rawSeverity`, 정규화 label, 충돌/누락 validation code로 보존한다.
LOW/MEDIUM/HIGH/CRITICAL 점수 가산, alias group의 최고 Severity 1회 반영,
Feed 점수만으로 REVIEW, Scanner/Feed/final score 분리 저장은 과거 구현 이력이며
현행 목표가 아니다. 새 Decision의 `score`는 nullable 호환 필드로 `null` 저장한다.

Feed 장애는 ValidatedOsvFeed의 `feedStatus`, `errorCodes`, `skippedReason`으로,
Policy GPT 장애는 응답의 `llm.status/failureCode`로 별도 추적한다. Feed 장애는
OSV 근거만 비우며 Scanner Evidence 판단을 중단하지 않는다. GPT 장애는 Policy의
`judgmentFailureDecision`(현재 기본 HOLD)로 처리한다.
평가 응답은 `feed.feedEvidenceIds`로 이번 평가에서 검증된 OSV 근거 ID를 노출한다.
Decision DB에는 실제 Judgment가 참조한 `feedEvidenceIds`와 성공 Snapshot ID를 별도로
저장한다.

### Cache·Snapshot 후속 Contract

Decision DB의 `feed_snapshots`와 `feed_lookup_attempts`가 정상 빈 결과를 포함한 검증
성공 Snapshot과 모든 조회 Attempt를 분리한다. TTL은 Policy 검증 완료 시각부터
1시간이며 재사용, 실패, TIMEOUT, SKIPPED로 연장하지 않는다. 판단 관련 canonical
필드의 SHA-256 digest가 같은 만료 전 Snapshot만 기존 시각 그대로 재사용한다.
최근 7일 실제 요청 package 중 만료 대상을 선정하고 판단 관련
Advisory 내용 변경 시에만 동일 Artifact의 유효 Scanner Evidence로 새 Decision을
만들어 이전 Decision과 연결해야 한다. 구체 선행 조건은
`docs/w6-osv-follow-up-status.md`에 기록한다.

- 검증일: 2026-09-09
- 작업 브랜치: `test/osv-policy-integration`
- 범위: Policy 테스트와 결과 문서. Scanner 코드, Evidence 흐름, API/Schema/환경변수 및 런타임 설정 변경 없음.

## 연동 흐름

1. `OsvClient.query_package()`는 npm 패키지 이름과 버전으로 OSV를 조회한다. 현재 평가 API가 이 클라이언트를 직접 호출하지는 않는다.
2. `normalize_osv_result()`는 OSV 응답을 `ThreatFeedResult` 형태로 변환한다. `MODERATE`는 `MEDIUM`으로 변환하며, 정상 응답은 advisory가 없어도 `SUCCESS`다.
3. 호출자가 기존 Scanner `evidences`와 별도 필드인 `threatFeed`를 `POST /internal/v1/evaluations`에 전달한다. OSV advisory를 Scanner Evidence로 변환하지 않는다.
4. `score_evidences()`가 Evidence 위험 점수에 advisory의 최고 심각도 점수만 더한다. LOW/MEDIUM/HIGH/CRITICAL은 각각 10/20/30/40점이며, 최종 보안 점수는 `100 - detectionScore`다(위험 점수 최대 100).
5. 미완료 scan은 먼저 HOLD 처리한다. 완료 scan에서 feed가 FAILED/TIMEOUT이면 각각 `FEED_FAILED`/`FEED_TIMEOUT` HOLD를 생성한다. 외부 `score`는 응답 점수와 정책 조건 평가에 사용되지만 이 scoring HOLD를 제거하지 않는다.
6. 활성 정책을 조회하고 scoring 결과와 정책 규칙을 함께 평가한다. 결정 우선순위는 `REJECT > HOLD > REVIEW > ACCEPT`다. 따라서 별도 REJECT 정책이 일치하면 HOLD보다 우선할 수 있다.
7. `save_decision()`에 정책 키와 최종 Decision을 전달한 후, 성공 응답에 `persistence.saved=true`, `status=SAVED`, `decisionDbId`를 포함한다. 저장 불가 시 기존 테스트에서 HTTP 503을 검증한다.

## 테스트 시나리오와 기대 결과

테스트 파일은 `apps/policy/tests/` 기준이다. 기존 단위 테스트와 실패 경로는 유지하고, 기존 성공 평가 테스트 하나를 정규화 → HTTP 평가 → 저장 호출 검증의 세 가지 매개변수 사례로 확장했다.

| 시나리오 | 테스트 | 기대 결과 |
| --- | --- | --- |
| OSV advisory 정규화 | `test_osv_mapper.py::test_normalize_osv_result_maps_advisory` | SUCCESS, MODERATE → MEDIUM, fixedVersion 보존 |
| OSV advisory 없음 | `test_osv_mapper.py::test_normalize_osv_result_without_vulnerabilities` | SUCCESS, 빈 advisory 목록 |
| advisory 존재 + Evidence | `test_main.py::test_endpoint_applies_normalized_osv_feed_and_saves_decision[advisory-exists]` | FILE_READ 10 + HIGH 30 → score 60, REVIEW |
| advisory 없음 + Evidence | 동일 테스트 `[no-advisories]` | FILE_READ 10만 적용 → score 90, ACCEPT |
| 여러 advisory + Evidence | 동일 테스트 `[highest-severity-only]` | MODERATE/HIGH/LOW/HIGH 중 HIGH 30만 한 번 적용 → score 60, REVIEW |
| 최고 심각도 단위 검증 | `test_scoring.py::test_threat_feed_highest_severity_affects_score_once` | MEDIUM/HIGH → detectionScore 30, score 70, REVIEW |
| 빈 SUCCESS feed의 기존 scoring 유지 | `test_scoring.py::test_successful_empty_threat_feed_preserves_scoring` | feed 없는 FILE_READ 평가와 동일 |
| FAILED/TIMEOUT scoring | `test_scoring.py::test_unsuccessful_threat_feed_is_held` (6건) | Evidence 없음/FILE_READ/KNOWN_MALWARE 각각 HOLD, 해당 FEED reasonCode |
| FAILED/TIMEOUT 및 외부 점수 | `test_main.py::test_endpoint_holds_unsuccessful_threat_feed` (4건) | score 생략/100 모두 HTTP 200, HOLD; ACCEPT 정책이 일치해도 HOLD 유지 및 저장 호출 |
| Decision 저장 요청 | 위 성공 3건 및 실패 상태 4건 | 올바른 policyKey로 한 번 호출; 성공 3건은 저장 전달 payload와 응답의 Decision 전체 일치, Evidence ID·scanId·subject 보존, persistence 확인 |

성공 경로는 실제 mapper, 요청 모델 검증, FastAPI endpoint, scoring 및 규칙 선택을 실행한다. 활성 정책 조회와 Decision 저장은 monkeypatch로 대체한다. 따라서 저장 함수 호출과 전달 내용은 검증하지만 실제 DB commit/read-back을 증명하지는 않는다. OSV 응답도 고정된 합성 데이터로, 특정 실존 패키지의 최신 취약점 유무를 주장하지 않는다.

## 실행 명령과 실제 결과

저장소 루트에서 실행:

```bash
PYTHONPATH=apps/policy apps/policy/.venv/bin/python -m pytest apps/policy/tests -q
```

```text
52 passed, 8 warnings in 4.40s
```

종료 코드 0. 위 표의 모든 테스트를 포함한 Policy 테스트 전체가 통과했다.
최초 샌드박스 실행은 15건 진행 후 응답이 없어 중단했다(종료 코드 130).
승인 후 동일 명령을 샌드박스 밖에서 재실행한 결과가 위 성공 결과다.

## 현재 경고 및 후속 항목

- 실행 경고 8건: `StarletteDeprecationWarning` 1건(`starlette.testclient`의 httpx 사용 deprecated, httpx2 전환 안내), Pydantic serializer 경고 7건(`DecisionPersistence` 예상 필드에 dict 할당). 응답 assertions는 통과했으며, 의존성 호환성 검토와 `decision.persistence` 모델 할당 개선은 별도 후속 작업으로 남긴다. 이번 작업에서 의존성이나 production 코드를 변경하지 않았다.

- Issue #209의 패키지 식별정보 불일치 조건은 미해결이다. 현재 평가 요청 검증은 Evidence subject와 scanId를 검사하지만 `threatFeed.packageName/packageVersion`을 평가 subject와 비교하지 않는다. 불일치 feed에도 점수가 적용될 수 있으므로, 거부/HOLD 등 처리 Contract 합의 후 별도 구현·회귀 테스트가 필요하다. 이번 결과로 Issue 전체 완료를 주장하지 않는다.
- OSV 클라이언트는 HTTP/timeout 예외를 전달하고 mapper는 SUCCESS만 생성한다. 실제 조회 실패를 FAILED/TIMEOUT feed로 변환해 전달하는 호출자 연동은 별도 검증이 필요하다. 이번 실패 테스트는 이미 구성된 feed 상태를 입력한다.
- mapper가 인식하지 못한 severity는 `None`이며 scoring 가산에서 제외된다. CVSS 벡터 해석은 구현되어 있지 않으므로 별도 매핑 정책과 테스트가 필요하다.
- `packages/contracts/policy-evaluation-v0.1.schema.json`에는 `threatFeed`가 없고 추가 필드를 금지한다. Python 요청 모델과 공유 JSON Schema의 차이는 관련 Component와 합의 후 정리해야 한다.
- 실제 OSV 네트워크 조회 및 Policy DB/Decision DB 저장·재조회는 이번 실행 범위에 포함하지 않았다. 기존 `tests/integration/policy_decision_db_smoke.py`를 사용하는 서비스 통합 검증과 OSV 연결 검증은 후속 작업이다.
- 평가 코드의 Gateway 후속 처리 연결 TODO는 그대로 남아 있다.

## Issue #268 당시 점수 기반 설계 및 추가 검증(PR #301 이전 이력)

위 내용은 2026-09-09 당시 Issue #209 구현과 검증 이력을 보존한 기록이다. 당시의
`threatFeed`, Feed 점수, 실패 시 HOLD 기대값은 이후 Issue #268에서 한 차례 변경됐다.
아래 내용 역시 PR #301의 LLM 전환 전 구현 이력이며, 문서 최상단의 LLM 목표 설계를
대체하지 않는다.

### PR #301 이전 전달 구조

```text
evidences + osvFeed
  → POST /internal/v1/evaluations
  → Policy가 osvFeed 검증
  → ThreatFeedEvidence 변환
  → Scanner Evidence와 함께 Scoring·Policy Rule 평가
```

Policy는 OSV API를 직접 호출하지 않는다. Scanner가 수집한 별도 `osvFeed`를 검증하고
내부 `ThreatFeedEvidence`로 변환한다. OSV 결과는 공용 `EvidenceV0_1` 배열에 섞지 않는다.

PR #273 통합 후 `osvFeed`는 필수이며 `source="OSV"`를 사용한다. Scanner Orchestrator가
기존 평가 요청 한 번에 포함한다. 누락/null 요청은 422로 거부하고 `SKIPPED`는
`NOT_EVALUATED`, `skippedReason` 및 구조화 로그로 기록하며 Scanner-only로 평가한다.
상태별 timestamp·errorCode·skippedReason 조건은 Python 모델과 공유 JSON Schema에서 검증한다.

기존 `threatFeed` 입력은 확정된 Contract 변경에 따라 요청 모델에서 제거했다.
구형 `threatFeed` 요청은 `extra=forbid`에 의해 422가 되며, 새 `osvFeed`만 허용한다.

### PR #301 이전 검증 기준

- Advisory의 package, version, ecosystem, affected range, advisory ID, aliases,
  withdrawn, references 및 원본 severity 경로를 검증한다.
- 개별 Advisory 검증 실패는 해당 Advisory만 제외하고, 전체 Feed 실패·미완료는 전체를 제외한다.
- fixed version 없음은 허용하고, severity 없음·해석 불가 severity는 Evidence로 보존하되 점수에서 제외한다.
- `LOW=5`, `MEDIUM=10`, `HIGH=15`, `CRITICAL=20`, `MODERATE=MEDIUM`을 사용한다.
- 명시적 Advisory ID·alias가 연결될 때만 중복 제거하며, 최고 severity bonus를 한 번만 적용한다.
- 외부 `request.score`, 제출된 `decision`, `threatFeed`는 신뢰하지 않는다.
- 확실한 Scanner 악성 Evidence는 Feed 상태와 관계없이 `REJECT`, 미완료 Scanner는
  확실한 악성 Evidence가 없을 때 `HOLD`다. Feed 실패만으로 HOLD/REVIEW를 만들지 않는다.
- Feed 점수만으로 새 REJECT 후보가 되면 `REVIEW`로 제한하고 기존 Scanner REJECT/HOLD는 보존한다.

Issue #268 추가 테스트는 기존 테스트를 대체하지 않고 `test_main.py`,
`test_scoring.py`, `test_osv_mapper.py`, `test_contract_validation.py`에 추가했다.
기존 HTTP/persistence, Policy DB·Decision DB 장애, Scanner scoring 회귀 시나리오도
현재 Contract에 맞춘 입력과 기대값으로 유지한다.

복구 및 추가 검증 수는 다음과 같다.

- HEAD에서 복구·유지한 기존 시나리오: 33건 — `test_main.py` 13건,
  `test_scoring.py` 18건, `test_osv_mapper.py` 2건
- Issue #268 OSV/Contract 추가 시나리오: 33건
- 전체 Policy 테스트: `85 passed`

기존 문서에 기록된 2026-09-09의 52건 결과는 과거 Issue #209 검증 이력으로
보존한다. 현재 명세에서는 Feed 실패만으로 HOLD를 만들지 않으므로, 당시 Feed-specific
HOLD를 기대했던 테스트 시나리오는 삭제하지 않고 Scanner-only 결과를 기대하도록
Contract에 맞춰 갱신했다.
