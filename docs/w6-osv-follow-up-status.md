# W6 OSV Feed 후속 작업 상태 및 WBS 수정안

- 확인일: 2026-09-23
- 브랜치: `feat/policy-feed-snapshot-persistence`
- 기준: `HEAD=976a6c6`, `origin/dev=976a6c6`, PR #301 및 PR #1 OSV/LLM 통합 포함
- 성격: 저장소에 WBS 원본이 없어 외부 WBS를 수정하지 않고 변경안을 보고한다.

## 코드 기준 현재 흐름

Scanner `Orchestrator`는 registry identity와 artifact를 확인한 뒤 analyzer 실행과
`OsvFeedClient.query()`를 병렬 시작한다. OSV client는 전체 deadline, parent abort,
page/byte/JSON depth/string 제한과 반복 page token을 처리하며 실패 시 부분 Advisory를
버린다. `buildPolicyEvaluationRequest()`가 저장된 Scanner Evidence와 별도 필수
`osvFeed`를 한 번의 Policy 요청에 넣는다. 공유 JSON Schema, Scanner 타입과 QA
fixture도 이 필드를 필수로 유지한다.

Policy는 요청과 Evidence identity를 확인하고 `ValidatedOsvFeed`를 만든다. PR #301은
과거 Python mapper/scoring/rules를 제거하고 TypeScript GPT Judgment → output validator
→ rule resolver → decision resolver로 전환했다. 이번 후속 작업은 삭제 과정에서
축소됐던 OSV Advisory 검증을 TypeScript로 복원하고, Scanner Evidence ID와 구분되는
`feedEvidenceIds`를 도입했다. Severity는 metadata이고 Decision DB의 `score`는 null이다.

## WBS별 실제 상태와 수정안

| WBS | 현재 상태 | 확인 결과 및 수정 완료 기준 |
| --- | --- | --- |
| W6-SC-G-01 | 기존 구현 완료 | Scanner OSV client가 page 수집, HTTP/JSON/size/deadline/skip 상태를 구현한다. 재구현하지 않음. |
| W6-SC-G-02 | 기존 구현 완료 | Analyzer와 OSV가 병렬 실행되고 결과가 별도 `osvFeed`로 Policy에 전달된다. 재구현하지 않음. |
| W6-SC-G-03 | PR 3 구현 | 기존 page/byte/depth/string/deadline/abort 제한을 유지하고, process-wide concurrency limiter와 동일 package·version·ecosystem 실시간 요청 coalescing을 추가했다. 실시간 요청은 계속 no-retry다. |
| W6-SC-G-04 | PR 3 구현 | Decision DB Snapshot lookup API와 Scanner read-through adapter를 연결했다. 미래 expiresAt인 성공 Snapshot과 빈 결과만 재사용하고, miss/만료/조회 오류는 OSV로 fallback한다. |
| W6-SC-G-05 | 기존 구현 완료(실시간 범위) | 성공/빈 결과/HTTP·JSON·timeout·abort·부분 수집 폐기 및 전달 테스트가 존재. Cache/refresh 테스트는 G-04/G-06 이후 별도다. |
| W6-SC-G-06 | PR 3 구현 | 최근 7일 Attempt 기반의 만료/누락 후보 조회, 기본 1시간 scheduler, background-only 제한 retry/Retry-After, per-package lock과 circuit breaker를 추가했다. |
| W6-SC-G-07 | PR 3 구현 | 기존 Scanner 내부 API 경계에 optional `SCANNER_ADMIN_TOKEN` 권한 검사를 적용한 force-refresh job/status API를 연결했다. Policy 자동 재평가는 추가하지 않았다. |
| W6-SC-G-08 | PR 3 구현 | coalescing/concurrency/deadline/cache/worker retry·circuit/force-refresh 및 Snapshot 보존 장애 테스트를 추가했다. |
| W6-DF-01 | LLM 전환으로 수정 필요 → 이번 범위 완료 | package/version/ecosystem/affected/withdrawn/ID/aliases/reference/risk/severity 검증과 Policy-local OSV evidence 변환을 TS에 복원. Severity 점수는 생성하지 않음. |
| W6-DF-02 | 기존 Contract 완료 + 이번 LLM 연결 완료 | 필수 `osvFeed` 수신은 기존 완료. 활성 Policy에 OSV predicate가 있을 때만 별도 OSV facts를 GPT에 제공. |
| W6-DF-03 | LLM 전환으로 수정 필요 → 이번 범위 완료 | 제목을 **OSV predicate 근거 연계 및 deterministic 안전장치**로 변경. `feedEvidenceIds` 참조 검증, 무관 predicate 연결 금지, OSV-only REJECT 금지를 완료 기준으로 제안. |
| W6-DF-04 | 구현 완료 | 성공/빈 성공 Snapshot의 원본·검증 결과·canonical digest·1시간 TTL과 전체 상태 Attempt를 Decision DB에 분리 저장한다. 만료 전 동일 digest만 원래 TTL로 재사용한다. |
| W6-DF-05 | LLM 전환으로 수정 필요 → Policy 단위 범위 완료 | 제목을 **OSV facts→GPT Judgment→Resolver 통합 검증**으로 변경. Policy 단위 테스트는 추가했지만 실제 DB 저장·재조회 E2E는 Snapshot 계약 후 남음. |
| W6-DF-06 | 이번 PR 구현 | 성공 Feed만 validator를 거쳐 판단 관련 canonical digest를 계산하고, identity별 직전 성공 Snapshot과 비교한다. 동일 digest는 Snapshot을 재사용하고, 변경 시 기존 Snapshot을 참조한 Decision만 idempotent Job으로 등록한다. |
| W6-DF-07 | 이번 PR 구현 | `QUEUED → RUNNING → COMPLETED/FAILED` Job Processor가 기존 Scanner Evidence, 신규 Snapshot, 현재 Published Policy를 사용해 기존 Policy 평가 경로를 재호출하고 immutable Decision lineage를 저장한다. |
| W6-DF-08 | 이번 PR 구현 | 기존 Evidence artifact 조회 Contract, `previousDecisionId`, `triggerSnapshotId`, 새 Decision ID, Job 상태 감사와 Decision/Job transaction 연결을 추가했다. |
| W6-DF-09 | 구현 완료 | Decision에 nullable Snapshot ID와 실제 Judgment가 참조한 검증된 `feedEvidenceIds`를 저장한다. 실패 Attempt와 저장 단계 오류는 Decision 결과와 분리한다. |
| W6-DF-10 | 기존 구현 완료 | Scanner 타입, 공유 Schema, Policy 요청, QA fixture에서 `osvFeed` 필수와 `source=OSV` 확인. 재구현하지 않음. |

## 새로 필요한 WBS 항목

1. **W6-DF-11 OSV Policy-local evidence 및 GPT 참조 무결성**: Scanner Evidence와
   분리된 ID namespace, predicate allowlist, hallucinated ref 거부, OSV-only REJECT 방지.
   이번 범위에서 구현했다.
2. **W6-DF-12 Feed/LLM 장애 관측 분리**: feed acquisition/validation 상태와 GPT
   provider/judgment validation 실패를 독립 field로 노출·audit 저장. 응답 분리는
   이번 범위에서 구현했으며 영구 audit 저장은 DB 계약 후속이다.
3. **W6-DF-13 Snapshot canonicalization과 change fingerprint**: ID/aliases,
   affected package/ranges/versions, withdrawn, risk type, severity 원본 및 Policy
   validation 결과를 순서 독립적으로 정규화해 SHA-256 digest로 저장한다.
4. **W6-DF-14 재평가 lineage/idempotency**: 이전 Decision을 덮어쓰지 않는 새 ID,
   `previousDecisionId`, trigger snapshot ID, reused Scanner Evidence IDs를 저장한다.

## Snapshot·TTL·갱신·재평가 선행 인터페이스

Snapshot/Attempt/Decision 연결과 refresh·재평가 항목은 다음 계약으로 구현했다.

- `feed_snapshots`: package ecosystem/name/version, canonical payload/hash,
  validation result, source collected/completed 시각, `validated_at`, `expires_at`,
  last successful check. 정상 빈 결과도 성공 Snapshot이다.
- `feed_attempts`: status(SUCCESS/FAILED/TIMEOUT/SKIPPED), started/finished 시각,
  error/retry metadata와 optional resulting snapshot ID. 실패 row는 성공 Snapshot을
  update하지 않는다.
- TTL: `expires_at = validated_at + 1 hour`. Cache read는 만료 전 Snapshot만 사용하며,
  동일 digest 저장은 기존 Snapshot과 TTL을 재사용한다. read, failure, SKIPPED로 갱신하지 않는다.
- refresh candidates: 실제 Policy 요청 로그의 package key와 `last_requested_at`을
  근거로 최근 7일 + expired 조건을 조회한다. 동일 key는 lease/unique job으로 병합한다.
- change detection: canonical judgment-related hash가 바뀐 경우에만
  `reevaluation_jobs`를 생성한다. 수집·검증·만료 시각, Attempt 정보 및 페이지 수만
  바뀐 것은 재평가 사유가 아니다.
- reevaluation: 동일 artifactHash와 scanId로 기존 Scanner Evidence를 조회하고,
  현재 Published Policy와 Predicate Registry를 다시 읽어 평가한다. 새 Decision은
  `previousDecisionId`, `triggerSnapshotId`, `feedSnapshotId`와 Evidence ID를 보존한다.
- 관리자 refresh: auth/audit, job ID, force 의미(cache bypass 여부), dedupe, 상태 조회,
  change event 전달과 Policy 재평가 ownership을 정해야 한다.

## Dynamic Evidence(W6-DF-06) 수신 기준

현재 Policy가 사용하는 Scanner `LLM_ASSESSMENT` 필드는 `subject`, `signal`,
`assertion`, `executionContext.flow`, `reachability`, `intentAssessment`,
`verificationStatus`, `confidence`, `reasonCodes`, `locations`, `relatedFindingIds`,
`relatedAtomicEvidenceIds`, `sources`, `limitations`, `provenance.analysisId/assessmentId`다.
Policy 전송 경계는 `VERIFIED`이고 원 Atomic reference와 subject/scan identity가 유효한
항목만 수용한다.

`PARTIAL`/`FAILED`/`TIMEOUT` agent summary나 누락된 Dynamic Evidence는 악성 부재의
근거가 아니다. 관련 predicate는 `UNKNOWN`으로 남겨야 하며 OSV로 보충하지 않는다.
OSV와 관련 없는 악성 행위 predicate에는 Scanner Evidence/Assessment만 사용한다.
필드 의미, reachability enum/shape, 부분 분석 시 predicate별 coverage 표현은 Scanner와
공동 Contract가 아직 필요하다.

## Issue #335 확인 결과

2026-09-25 기준 `origin/dev`의 PR #311 구현을 재감사했다.

- **W6-DF-17**: 기존 `policy_llm_judgments` 저장 경로와 migration 007은 유지하고,
  실제 최종 Prompt의 SHA-256 `inputHash`, `provider`, `promptVersion`을 migration 009와
  TypeScript/Python DB API에 추가했다. `policyHash`는 Policy Snapshot hash로 그대로
  유지하며 기존 row는 backfill하지 않는다.
- **W6-DF-18**: Primary/Shadow 정상·실패·Timeout·Abort, raw response 보존, invalid
  Judgment 차단, Prompt Injection의 registry/evidence namespace 오염 차단, OSV-only
  feed citation, allOf/anyOf rule status 검증을 Fixture/Mock 기반 자동 테스트로 보강했다.
  Shadow는 비교 audit만 만들고 Primary Decision을 변경하지 않는다.
- **W6-DF-19**: 별도 Anthropic Messages 기반 Claude Policy Provider Adapter와
  Policy GPT·Claude 비교 Harness를 구현했다. 기존 공통 Provider Interface,
  `buildPolicyPrompt()`, Prompt Version, inputHash, Judgment Validator 및
  TypeScript Resolver를 재사용한다. Fixture 기본 모드, 명시적 `--live` Provider
  모드, Predicate/Citation/Rule/Decision/reasonCode 비교, latency/token/pricing
  집계, JSON/선택적 CSV 출력과 Provider 실패 격리를 제공한다. Harness는 운영
  Primary·Shadow·감사·Decision DB 경로와 분리되어 있다. 상세 실행 방법과 결과
  Contract는 `docs/policy-llm-comparison-harness.md`에 기록했다.
