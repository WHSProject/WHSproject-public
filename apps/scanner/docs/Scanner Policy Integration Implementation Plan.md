# Scanner → Policy Integration Implementation Plan

- 작성일: 2026-08-26
- 상태: Scan Context 계약 확인 완료; Hash·Integrity Contract 확정 전 전체 연동 완료 불가
- 대상: Scanner가 Package별 `ScanResult`를 Policy Evaluation API로 전달하는 1차 통합

## 1. 목적

Scanner가 분석을 완료해 생성한 Package별 `ScanResult`를 Policy Engine에 동기
전달하고, Policy의 평가 및 Decision DB 저장 완료를 확인한 뒤 Gateway에 Scanner
완료 응답을 반환한다. Gateway는 Scanner 응답 Body에서 결과를 받지 않고 완료
응답 이후 Decision DB를 재조회한다.

Scanner는 Evidence 생성까지만 담당하며 Score, Policy Rule 평가, Security Decision
생성 및 Decision DB 저장을 직접 수행하지 않는다.

## 2. 현재 구현 상태

현재 Scanner는 다음 단계까지 구현되어 있다.

```text
Gateway Batch 요청
→ Package별 scanId 생성
→ Registry Metadata 조회
→ Tarball 다운로드·Integrity 검증
→ Safe Extract·Package Identity 검증
→ Metadata / Custom Rule Analyzer
→ Evidence Normalization
→ ScanResult 생성
→ ScanHistoryService 저장
→ Gateway에 200 빈 응답(현재는 Policy 호출 없이 반환)
```

| 항목 | 상태 | 근거 |
|---|---|---|
| Package별 `ScanResult` 생성 | 구현 완료 | `src/application/orchestrator/orchestrator.ts` |
| Atomic Evidence 생성 및 `ScanResult.evidences` 반영 | 구현 완료 | `src/evidence/normalizer/`, Orchestrator |
| Package별 `scanId` 생성·전달 | 구현 완료 | `src/application/scan-service/scan.service.ts` |
| Scan History 저장 | 구현 완료, 인메모리 | `src/history/scan-history.service.ts` |
| Policy Evaluation 요청 | 미구현 | Policy Client 및 Mapper 없음 |
| Policy 응답·Decision 저장 완료 확인 | 미구현 | Policy Client 없음 |

따라서 핵심 분석 결과는 이미 존재하지만 단순 HTTP 호출만 추가하면 끝나는 것은
아니다. 요청 형식 변환, 응답 검증, timeout, 오류 의미, Batch 실패 정책 및 Decision
중복 방지를 함께 정의해야 한다.

## 3. 현재 Source of Truth와 목표 계약

- Policy Evaluation Request:
  `packages/contracts/policy-evaluation-v0.1.schema.json`
- Evidence:
  `packages/contracts/evidence-v0.1.schema.json`
- Policy 실제 요청·응답 모델:
  `apps/policy/app/models.py`
- Policy 실제 Endpoint:
  `apps/policy/app/main.py`
- Policy API 문서:
  `apps/policy/docs/api-specs/details/02-policy-evaluation.md`

현재 공용 v0.1 Contract와 Policy Runtime에서 다음을 확인했다.

- `PREINSTALL_SCRIPT`, `INSTALL_SCRIPT`, `POSTINSTALL_SCRIPT`를 구분한다.
- Policy Evaluation은 `scanStatus`, `scanId`, `subject`를 필수로 받는다.
- `evidences: []`를 허용한다.
- Evidence Source의 `analyzerVersion`을 필수로 검증한다.
- Evidence Location과 Provenance를 공용 Schema 기준으로 검증한다.
- Policy 구현은 평가 성공 시 Decision DB 저장까지 수행하고 응답에 `persistence`를
  포함한다.

Policy 테스트는 `COMPLETED + [] → ACCEPT`, `PARTIAL + [] → HOLD`, 중복 Signal 기본점수
1회 반영과 Analyzer corroboration을 검증한다. `PREINSTALL_SCRIPT`와
`INSTALL_SCRIPT`도 Policy Scoring에 반영되어 있다.

남은 공통 Contract Blocker는 Gateway 재조회용 SHA-512 SRI다. 현재 v0.1 Subject에는
`artifactHash`만 있고 `integrity`가 없으므로 Hash·Integrity 분리와 Decision DB Mapping을
추가로 확정해야 한다.

## 4. 확정 호출 구조와 Component 책임

호출 구조는 다음과 같이 확정한다.

```text
Gateway
→ Scanner POST /internal/v1/scans
→ Scanner Package별 분석·ScanResult·History 생성
→ Scanner Package별 Policy Evaluation 동기 호출
→ Policy 평가 및 Decision DB 저장
← Scanner가 Policy 저장 완료 응답 확인
← Gateway에 HTTP 200, 빈 Body
→ Gateway가 packageName/version/integrity로 Decision DB 재조회
→ Gateway가 조회한 Decision을 사용
```

Component별 책임은 다음과 같다.

| Component | 책임 |
|---|---|
| Gateway | Scanner Batch 요청, 완료 응답 확인, 완료 후 Decision DB 재조회 및 Decision 사용 |
| Scanner | 분석, Evidence·ScanResult 생성, History 저장, Policy Evaluation 호출, 저장 완료 확인 |
| Policy | Score·Rule 평가, Decision 생성, Decision DB 저장, 저장 결과 반환 |
| Decision DB | package identity에 대응하는 최종 Decision 저장·조회 |

Scanner의 `200`은 단순 분석 완료가 아니라 **요청된 모든 Package의 Policy 평가와
Decision 저장까지 완료되었다는 동기 완료 신호**다. Scanner는 `ScanResult`나
Decision을 Gateway 응답 Body로 반환하지 않는다. Gateway도 Scanner 응답 Body를
Policy 입력이나 Decision으로 사용하지 않는다.

기존 Policy 문서에서 Gateway를 Policy Caller로 명시한 부분은 이 확정 구조와
충돌하므로 관련 문서 담당자와 함께 Scanner Caller 구조로 정정해야 한다. 이 문서
변경은 구현 범위에 포함하되 Gateway·Policy 코드는 담당 Component 작업으로 분리한다.

## 5. Policy Evaluation 요청 Mapping

현재 v0.1 Schema와 Policy Runtime은 `scanStatus`, 최상위 `scanId`·`subject`와 빈
Evidence를 지원한다. 이 절에서 추가한 `subject.integrity`만 현재 Contract에 없으며,
공용 Contract와 Policy·Decision Model을 먼저 확장해야 한다.

Policy Endpoint는 Subject 하나를 평가하므로 Scanner Batch 전체를 한 요청으로 보내지
않고 Package별 `ScanResult`마다 한 번 호출한다.

```http
POST {POLICY_URL}/internal/v1/evaluations
Content-Type: application/json
Accept: application/json
```

| Scanner `ScanResult` | Policy Evaluation Request |
|---|---|
| `requestId` | `requestId` |
| `status` | `scanStatus` |
| `scanId` | `scanId` |
| `subject.ecosystem` | `subject.ecosystem` |
| `subject.name` | `subject.packageName` |
| `subject.version` | `subject.packageVersion` |
| `artifactHash` | `subject.artifactHash` |
| 다운로드 중 계산한 `calculatedIntegrity` | `subject.integrity` |
| `evidences` | `evidences` |

요청 예시:

```json
{
  "requestId": "req-123",
  "scanStatus": "COMPLETED",
  "scanId": "scan-123",
  "subject": {
    "ecosystem": "npm",
    "packageName": "example",
    "packageVersion": "1.0.0",
    "artifactHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "integrity": "sha512-<base64>"
  },
  "evidences": []
}
```

다음 Scanner 내부 정보는 Policy Evaluation 요청에 임의로 추가하지 않는다.

- `analyzerSummaries`
- `ScanResult.errors`
- Normalization Summary와 Unmapped Finding 상세
- Registry Metadata와 임시 파일 경로
- `expectedIntegrity`

Scanner는 `score`를 계산하지 않으며 `score`와 `expectedArtifactHash`를 전송하지
않는다. `expectedIntegrity`도 검증 입력이며 Policy 요청에는 포함하지 않는다.

### 5.1 Decision 재조회용 Integrity 정합성

Gateway의 Decision 조회는 다음 Identity를 사용한다.

```text
packageName + version + integrity
```

현재 Decision DB 조회 구현은 `integrity`를 `artifact_hash_512`와 정확히 비교한다. 반면
현재 Scanner의 `ScanResult.artifactHash`는 접두사 없는 lowercase SHA-256 hex다.
따라서 다음 값을 같은 필드로 취급하면 안 된다.

| 값 | 현재 형식 | 용도 |
|---|---|---|
| `ScanResult.artifactHash` | lowercase SHA-256 hex | Scanner Artifact 식별 |
| `DownloadedArtifact.calculatedIntegrity` | `sha512-<base64>` SRI | 실제 다운로드 Byte의 SHA-512 |
| 요청·Registry Integrity | SRI | Artifact 검증 및 Gateway Decision 조회 |
| Decision DB `artifact_hash_512` | `sha512-<base64>` SRI | Gateway 재조회 Key |

Policy v0.2 Subject에는 `artifactHash`와 `integrity`를 분리한다. `artifactHash`는 기존
Scanner·Evidence의 lowercase SHA-256 hex를 유지하고 `integrity`는 다운로드한 실제
Byte에서 계산한 SHA-512 SRI를 사용한다. Decision DB의 `artifact_hash_512`에는
`subject.integrity`를 저장한다.

현재 `ScanResult`만으로는 다운로드 단계의 `calculatedIntegrity`가 노출되지 않으므로
Orchestrator 결과에 검증된 SHA-512 SRI를 내부 필드로 보존해 Policy Mapper까지
전달한다. 기존 `artifactHash` 의미를 SHA-512로 변경하지 않는다.

## 6. Scan Status, 호출 가능 조건과 빈 Evidence

검증된 Artifact Identity와 Hash·Integrity를 확보한 결과만 Policy에 전달한다.

| Scanner 결과 | Policy 요청 의미 |
|---|---|
| `COMPLETED + evidences: []` | 정상 미탐지 |
| `COMPLETED + Evidence` | 정상 분석 결과 평가 |
| `PARTIAL + evidences: []` | 분석 또는 정규화 불완전, HOLD 후보 |
| `PARTIAL + Evidence` | 정상 Evidence 보존 + 불완전 상태, HOLD 후보 |
| Analyzer `FAILED/TIMEOUT`, Artifact 검증 완료 | 운영 실패 또는 시간 초과, HOLD 후보 |

Scanner는 빈 Evidence를 실패로 바꾸지 않고 `scanStatus`로 의미를 구분한다.
`PARTIAL + []`는 일부 Analyzer 실패·Timeout·Skip 또는 정규화 불완전으로 전체 분석
완전성을 보장할 수 없고 정상 완료된 Analyzer의 Evidence가 없는 상태다.

Registry Metadata, Download, Integrity, Extract 또는 Package Identity 단계에서 실패하면
검증된 정상 Artifact Subject가 없으므로 일반 Policy Evaluation을 호출하지 않는다.
Scanner는 Gateway에 성공 `200`을 반환하지 않으며 해당 실패를 Policy `REJECT`로
변환하지 않는다.

## 7. 중복 Evidence 책임

Scanner는 현재 원칙을 유지한다.

- 동일 Analyzer·Rule·Location·관찰 내용의 중복만 제거한다.
- 서로 다른 Analyzer가 같은 Signal을 생성해도 독립 Evidence로 유지한다.
- 하나의 Custom Rule Finding이 여러 Signal을 의미하면 여러 Atomic Evidence를
  유지한다.
- Signal별 기본 점수 중복 제거와 Analyzer corroboration 상한은 Policy 책임이다.

Scanner는 Policy Score를 예상해 Evidence를 추가 병합하거나 제거하지 않는다.

## 8. 구현 경계와 파일 계획

과도한 Module 계층 없이 Scanner 내부에 Policy 전송 경계를 추가한다.

```text
src/policy/
├─ policy-evaluation.types.ts
├─ policy-evaluation.mapper.ts
├─ policy-evaluation.client.ts
└─ policy-evaluation.error.ts
```

| 파일 | 책임 |
|---|---|
| `policy-evaluation.types.ts` | Scanner 내부 요청·응답 최소 타입 |
| `policy-evaluation.mapper.ts` | `ScanResult`를 Policy Evaluation 요청으로 변환 |
| `policy-evaluation.client.ts` | HTTP 요청, timeout, 응답 크기·JSON·계약 검증 |
| `policy-evaluation.error.ts` | 안전한 내부 연동 오류 표현 |
| `src/application/scan-service/scan.service.ts` | History 저장 후 Policy 호출 조정 |
| `src/scanner/scanner.module.ts` | Client Provider 등록 |
| `src/config/scanner-environment.ts` | Policy URL·timeout 시작 시 검증 |
| `.env.example`, `compose.yaml` | Runtime 설정과 Service 연결 |

Policy Client를 Orchestrator에 넣지 않는다. Orchestrator는 Artifact·Analyzer·Evidence와
`ScanResult` 생성 책임을 유지한다.

## 9. ScanService 연결 순서

권장 순서는 다음과 같다.

```text
Orchestrator.execute()
→ ScanResult 생성
→ ScanHistoryService.save()
→ PolicyEvaluationMapper.map()
→ PolicyEvaluationClient.evaluate()
→ Decision 저장 완료 응답 검증
→ ScanService 완료
→ 모든 Package 완료 후 Controller가 HTTP 200 빈 Body 반환
```

History를 먼저 저장하면 Policy 장애가 발생해도 Scanner 분석 결과를 잃지 않는다.
이번 1차 구현에서 Policy Decision을 Scanner History 모델에 추가하지 않는다. Policy
결과는 Policy와 Decision DB가 소유한다.

Controller의 기존 `Promise<void>`와 `@HttpCode(HttpStatus.OK)` 계약은 유지한다.
Policy 호출 또는 저장 검증이 하나라도 실패하면 `ScanService.scan()`이 완료되지 않아야
하며 Controller가 성공 `200`을 반환해서는 안 된다.

Policy 호출·평가·저장 실패는 이미 생성된 `ScanResult.status`를 변경하지 않는다.
분석 결과와 Policy Delivery 결과를 별도로 관리한다. Policy Delivery 실패의 구조화
기록 위치는 구현 전에 확정한다.

## 10. Policy 응답 검증

HTTP 2xx만으로 성공 처리하지 않는다. 외부 응답을 `unknown`으로 받고 공용 Decision
Contract가 있으면 이를 재사용한다. 공용 Contract가 없다면 Policy 실제 응답 중 최소
필드를 Zod로 검증하되 Policy 모델 전체를 Scanner에 복제하지 않는다.

최소 검증값:

- `decisionId`: 비어 있지 않은 string
- `requestId`: 요청값과 일치
- `scanId`: 요청값과 일치
- `decision`: `ACCEPT | REJECT | HOLD | REVIEW`
- `subject`: 요청 Subject와 일치
- `evidenceIds`: 요청 Evidence ID의 부분집합인 string 배열
- `persistence.saved`: `true`
- `persistence.status`: Policy가 허용하는 값

Policy 실제 구현은 Evaluation 과정에서 Decision DB 저장까지 수행한다. 따라서
`persistence.saved !== true`이면 Scanner 완료로 처리하지 않는다.

응답의 모든 `evidenceIds`는 요청한 Evidence ID에 존재해야 한다. 요청에 없던 ID는
응답 검증 실패로 처리하되, 전체 배열의 완전 일치는 Policy Contract가 요구하기 전까지
강제하지 않는다. `decisionId`는 비어 있지 않은 opaque string으로만 검증한다.

Scanner는 Policy가 반환한 Decision을 Gateway 응답 Body에 다시 포함하지 않는다.
응답 검증은 완료 신뢰성을 위한 내부 검증이며, Gateway가 사용할 Decision의 Source of
Truth는 후속 Decision DB 재조회 결과다.

## 11. Timeout과 Retry

필요한 환경변수 후보:

```text
POLICY_URL=http://policy:8000
POLICY_EVALUATION_TIMEOUT_MS=<TBD>
```

환경변수 이름과 기본 timeout 값은 DevOps·Policy·Gateway와 확정한 뒤 사용한다.
Scanner 시작 시 URL과 양의 안전한 정수 timeout을 검증한다.

초기 구현에서는 자동 Retry를 수행하지 않는 것을 권장한다. Policy가 Decision을
저장한 후 응답만 유실되면 재시도로 중복 Decision이 생성될 수 있다. Retry를 추가하기
전에 `scanId` 또는 별도 Idempotency Key 기반 중복 방지 계약을 확정한다.

Policy timeout은 Gateway의 Scanner 전체 timeout보다 작아야 하며, 다음 전체 Budget을
고려해야 한다.

```text
Registry + Download + Extract + Analyzer + Normalizer + Policy
< Gateway Scanner timeout
< npm Client 전체 timeout
```

## 12. 오류 처리

| 조건 | 분류 원칙 | Scanner/Gateway 동작 |
|---|---|---|
| Network·timeout | 일시적 연동 실패 가능 | Scanner 200 반환 금지 |
| Policy `422` | Request Contract 불일치 | 비재시도, 구현·Contract 점검 |
| Policy `502` | Policy 또는 하위 응답 Contract 오류 | 비재시도 |
| Policy `503` | Policy DB/Decision DB 일시 장애 | retryable 특성 보존, 자동 Retry 없음 |
| 응답 크기 초과·JSON Parse 실패 | 외부 응답 오류 | 완료 처리 금지 |
| requestId·scanId·Subject 불일치 | 응답 Identity 오류 | 완료 처리 금지 |
| `persistence.saved !== true` | Decision 저장 미완료 | 완료 처리 금지 |

Policy 전용 공용 Error Code를 임의로 추가하지 않는다. 기존 Scanner Error Contract로
표현할 수 있는지 먼저 확인하고, 부족하면 Contract 변경 Issue로 분리한다. 오류 Body,
내부 Stack, Header와 민감 URL 정보를 로그나 Gateway 응답에 그대로 노출하지 않는다.

## 13. Batch 실패 정책

현재 Batch concurrency `1`을 유지한다. Package 하나의 Policy 평가가 실패해도 전체
Deadline이 남아 있으면 나머지 Package 처리를 계속하고 Package별 실패를 수집한다.
모든 Package 처리 후 하나라도 Decision 저장에 실패하면 Gateway에 성공 `200`을
반환하지 않는다.

이미 저장된 앞선 Package의 Decision은 Rollback하지 않는다. 전체 Deadline이 부족하면
새로운 Package 처리를 시작하지 않고 timeout 실패로 집계한다. Gateway가 실패 응답 후
재요청할 수 있으므로 `scanId` 또는 Artifact Identity 기반 중복 저장 방지 계약이
필요하다.

## 14. 구현 단계

1. `policy-evaluation-v0.2` 공용 Contract를 확정한다.
2. Policy Pydantic Model·Runtime과 JSON Schema를 동기화한다.
3. Policy Contract Test로 빈 Evidence, Scan Status, Subject, Hash·Integrity를 검증한다.
4. 최신 `dev`를 기준으로 Lifecycle Mapping과 공용 Contract를 동기화한다.
5. 확정된 Scanner Caller 구조를 관련 Policy API 문서에 반영한다.
6. Policy URL, 전체 Deadline, timeout과 인증 기준을 결정한다.
7. Policy Evaluation Request Mapper와 단위 테스트를 작성한다.
8. Policy HTTP Client와 응답 검증 테스트를 작성한다.
9. Scanner 환경변수 검증과 NestJS Provider를 연결한다.
10. ScanService에 History 저장 후 Policy 호출을 연결한다.
11. Policy 실패 수집과 Scanner Controller의 최종 응답을 연결한다.
12. Scanner 전체 테스트·typecheck·build를 실행한다.
13. Compose에서 Gateway→Scanner→Policy→Decision DB Smoke를 실행한다.
14. 후속 Gateway 작업에서 Scanner 200 이후 Decision 재조회와 집행을 연결한다.

## 15. 테스트 계획

### Mapper Unit Test

- 모든 Scan Status 변환
- Subject 필드명 변환
- Artifact Hash와 Evidence 원형 유지
- 빈 Evidence 허용
- `expectedIntegrity` 미전달
- SHA-256 Artifact Hash와 SHA-512 Integrity를 혼동하지 않음
- Decision 재조회용 SHA-512 Integrity 원형 유지

### Policy Client Unit Test

- 정상 Decision과 저장 완료 응답
- 요청 URL, Method, Header 및 Body
- HTTP 오류 `422`, `502`, `503`
- Network 오류와 실제 대기 없는 timeout
- JSON Parse와 응답 크기 실패
- requestId·scanId·Subject 불일치
- 응답 Evidence ID가 요청 Evidence ID의 부분집합인지 검증
- `persistence.saved` 누락 또는 `false`
- 자동 Retry 및 중복 호출 없음

### ScanService·Controller Integration Test

- History 저장 후 Policy 호출
- Package별 Policy 호출 1회
- requestId와 scanId 보존
- `COMPLETED + []`, `PARTIAL + []` 전달
- Evidence 포함 결과 전달
- Policy 성공 후 Scanner 200
- Scanner 성공 응답 Body가 비어 있음
- Policy 실패 시 Scanner 200 금지
- Policy 실패 후 기존 ScanResult.status 유지
- Policy 실패 후 Scan History 보존
- Package 하나의 Policy 실패 후 남은 Package 처리
- Artifact Identity 확보 실패 시 Policy 미호출
- Deadline 소진 시 새 Package 처리 중단

### Compose Smoke

```text
Gateway
→ Scanner
→ Policy
→ Policy DB
→ Decision DB
→ Scanner 200
→ Gateway Decision DB 재조회
```

다음을 대조한다.

- Gateway requestId
- Package별 scanId
- Evidence ID와 Subject
- Policy Decision
- `persistence.saved`
- Scanner 성공 응답의 빈 Body
- Gateway 재조회 결과의 packageName/version/integrity/decision
- Gateway 조회 Integrity와 Decision DB `artifact_hash_512`의 정확한 일치

## 16. 범위 제외

- Policy Score 및 Rule 구현 변경
- Decision DB Schema 변경
- Gateway의 ACCEPT/REJECT/HOLD/REVIEW 집행
- GuardDog 및 Correlated Evidence
- Scanner History의 DB 영속화
- 자동 Retry와 Idempotency 구현
- 서비스 인증 방식이 미정인 상태에서의 임의 인증 구현

## 17. 구현 전 결정사항

| 우선순위 | 결정사항 | 이유 |
|---|---|---|
| 확정 | Policy Caller는 Scanner | Gateway는 Scanner 완료 후 Decision DB를 재조회 |
| 확정 | Package 하나라도 Policy 저장 실패 시 Scanner 200 금지 | 빈 성공 응답은 전체 저장 완료 신호 |
| 확정 | Package별 실패 격리 | Deadline이 남으면 나머지 Package 처리 후 Batch 실패 반환 |
| P0 | `policy-evaluation-v0.2` 공용 Contract | 현재 v0.1은 목표 Request를 거부 |
| P0 | Hash·Integrity 분리와 Decision DB Mapping | SHA-256과 Gateway 조회용 SHA-512 SRI 역할 분리 |
| P0 | Artifact 검증 실패의 Gateway HTTP 오류 | Policy를 호출할 수 없는 실패의 외부 의미 필요 |
| P0 | Scanner 전체 Deadline·Policy timeout·Batch 제한 | 전체 npm 요청 Budget과 연결 |
| P0 | Decision Idempotency | timeout 후 Retry·중복 Decision 방지 |
| P0 | Policy Delivery 실패 기록 위치 | ScanResult 상태와 연동 실패를 분리해 추적 |
| P1 | Policy 서비스 인증 | API 문서에서 TBD |
| P1 | Policy 연동 오류 Code·Stage | 기존 Scanner 공용 오류와 정합성 |
| P2 | Policy Decision을 Scanner History에 남길지 | 현재는 Policy·Decision DB 소유로 제외 |

## 18. 완료 조건

- [ ] 최신 공용 Policy Evaluation/Evidence Contract와 Scanner Mapping이 일치한다.
- [ ] Package별 ScanResult가 Policy 요청으로 정확히 변환된다.
- [ ] 빈 Evidence와 Artifact 검증이 완료된 Scan Status가 Policy에 전달된다.
- [ ] Artifact Identity 확보 실패 시 Policy를 호출하지 않고 Scanner 200을 반환하지 않는다.
- [ ] Policy 응답의 Identity와 Decision 저장 완료를 검증한다.
- [ ] Gateway 조회 Integrity와 Decision DB의 SHA-512 저장값이 일치한다.
- [ ] Policy 실패 시 Scanner가 완료 200을 반환하지 않는다.
- [ ] 모든 Package 저장 완료 후에만 Scanner가 빈 Body의 200을 반환한다.
- [ ] Policy 장애 후에도 Scanner Scan History가 보존된다.
- [ ] Policy 실패가 기존 ScanResult.status를 변경하지 않는다.
- [ ] 응답 Evidence ID가 요청 Evidence ID의 부분집합인지 검증한다.
- [ ] 자동 Retry 없이 호출 횟수가 보장된다.
- [ ] Unit·Integration·Failure Test가 통과한다.
- [ ] Node 24에서 Scanner test·typecheck·build가 통과한다.
- [ ] Compose Gateway→Scanner→Policy→Decision DB→Gateway 재조회 Smoke가 통과한다.
- [ ] Gateway가 Scanner 200 이후 packageName/version/integrity로 Decision을 재조회한다.
- [ ] 재조회한 Decision이 요청 Package와 일치함을 검증한다.
