# Agent Planning Tier 3 Execution Result

## 목적과 현재 범위

`executeTier3V0_3()`은 준비된 `Tier3ExecutionInput`을 기존
`AgentInputV0_3Builder`와 `LlmAgentRunnerService.executeV0_3()`로 한 번 실행하고,
운영 연결에 사용할 수 있는 `Tier3OperationalResult`를 반환한다.

Orchestrator는 이 결과의 검증 Evidence를 기존 정적 Evidence 뒤에 병합하고 summary와
`inputFindingIds`를 기존 Policy 요청 경계에 전달한다. Policy는 기존 검증을 다시 적용한다.

## 호출 계약

| 입력 | 타입 | 의미 |
| --- | --- | --- |
| `execution` | `Tier3ExecutionInput` | 원본-only 또는 원본·복원 artifact, Finding, Atomic Evidence, binding과 실행 계획 |
| `context` | `AgentInputV0_3Context` | scan·package·archive 식별 정보 |
| `settings` | `LlmAgentEnvironment` | 기존 활성화, 코드 요청 예산과 실행 정책 |
| `dependencies` | `Tier3ShadowDependencies` | 기존 Builder, Runner와 Evidence Adapter |
| `triggerReason` | `string` | summary에 기록할 실행 사유 |
| `signal` | `AbortSignal` (선택) | package deadline/취소 신호 |

함수는 파일이나 artifact를 별도 경로로 읽지 않는다. Builder와 Runner가
`Tier3ExecutionInput.artifacts`의 기존 resolver 및 경계 검사를 사용한다.

## 반환 계약

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `evidences` | `LlmAssessmentEvidence[]` | `toEvidencesV0_3()` 변환을 통과한 `VERIFIED` Assessment만 포함 |
| `summary` | `AgentAnalysisSummary` | Runner 결과와 Evidence 변환 결과를 합친 단일 실행 상태·요약 |
| `inputFindingIds` | `string[]` | Agent 입력에 제공된 Finding 범위. 검증 완료를 뜻하지 않음 |
| `assessedFindingIds` | `string[]` | Validator가 처리한 Assessment가 참조한 Finding |
| `citedFindingIds` | `string[]` | 반환된 검증 Evidence가 실제 참조한 Finding |
| `conversionFailures` | `LlmEvidenceConversionFailure[]` | Assessment별 Evidence 변환 실패 |
| `initialSliceCount` | `number` | Builder가 만든 초기 코드 slice 수 |
| `runtimeSliceCount` | `number` | 실행 중 추가된 코드 slice 수 |
| `codeRequests` | `AgentCodeRequestRecordV0_3[]` | Agent의 추가 코드 요청 기록. 요청마다 `requestId`, `artifactId`, `filePath`, `requestedRange`, `servedRange`, `truncated`를 담는다. 파일이 너무 크거나(`LLM_AGENT_MAX_FILE_SIZE_BYTES` 초과) 바이너리이거나 없거나 요청 범위가 파일 밖이면 실행을 실패시키지 않고 Agent에 `unavailable` 응답을 돌려주며, 이때 `servedRange`는 `null`이고 `unavailableReason`(`FILE_TOO_LARGE`, `FILE_BINARY`, `FILE_NOT_FOUND`, `RANGE_OUTSIDE_FILE`, `BUDGET_EXHAUSTED`)이 붙는다. 파일 문제로 돌려주는 요청은 추가 요청 횟수를 1회 쓴다. 도구 호출·추가 요청·총 코드 줄 예산이 다 찼을 때 들어온 요청은 `BUDGET_EXHAUSTED`로 돌려주고 횟수는 쓰지 않는다. 예산이 다 찼거나 Agent 호출이 마지막 허용 횟차(기본 3회차)이면 그 호출은 추가 코드 요청 없이 최종 답(`COMPLETED`)을 내도록 요청하며, 그 호출이 또 코드를 요청하면 그때만 `REQUEST_LIMIT_EXCEEDED`로 실패한다. 경로 탈출·링크 등 안전 위반과 반복 요청은 지금처럼 `TOOL_REQUEST_REJECTED`로 실패한다. 코드 내용은 없고, 요청이 없거나 실행이 일찍 끝났으면 그때까지의 기록만 담긴다 |
| `limitations` | `string[]` | 계획, Runner 및 summary 제한의 중복 제거 합집합 |
| `executionFailure` | object (선택) | `DEPENDENCY`, `INPUT_BUILD`, `RUNNER`, `EVIDENCE_CONVERSION` 단계와 실패 사유 |

입력 Finding, Validator가 평가한 Finding, 최종 Evidence에 인용된 Finding은 서로
다른 의미이므로 별도 필드로 유지한다. 특히 `inputFindingIds`만으로 Finding이
검증됐다고 해석하면 안 된다.

## Evidence와 summary

- 기존 `toEvidencesV0_3()`가 artifact, slice, Finding 및 Atomic Evidence 참조를
  검증·변환한다. Raw Agent 응답은 직접 Evidence가 되지 않는다.
- 항목별 변환 실패는 Adapter가 격리한다. 유효한 형제 Evidence는 유지되고
  summary는 `PARTIAL` 및 실패 수를 반영한다.
- 정상 완료 후 Evidence가 0개인 결과는 `COMPLETED`와 0개로 남아 실행 실패와
  구분된다.
- Runner가 반환한 `FAILED`, `TIMEOUT`과 `failureReason`은 summary에 보존된다.
- Builder/Runner 예외와 전체 변환 예외는 `executionFailure.stage`로 구분한다.
  취소 신호가 이미 발생한 예외는 `TIMEOUT`으로 보존한다.
- 정적 Atomic Evidence는 읽기 전용 입력이며 이 함수가 생성·수정·병합하지 않는다.

Policy 요청 경계는 기존과 동일하게 Evidence ID/provenance, Finding 참조,
Atomic Evidence 참조 및 summary count를 다시 검증한다. `agentFindingIds`에는 전체
V0.3 입력 범위인 `inputFindingIds`를 전달한다. `assessedFindingIds`와
`citedFindingIds`는 더 좁은 관측 범위이며 Policy allow-list로 확대 해석하지 않는다.

## Shadow와의 관계

기존 `executeTier3Shadow()`는 실험·회귀용으로 유지된다. 운영 Orchestrator는
`executeTier3V0_3()`을 한 번 호출하고 `toTier3ShadowResult()`로 같은 결과의 관측 record를
만든다. Shadow 관측을 위해 Runner를 다시 호출하지 않는다.

## 수명과 후속 연결

반환값은 Scanner 내부 계약이다. `Tier3ExecutionInput`의 resolver와 artifact 경로는
기존 cleanup 전까지만 유효하며 LLM Evidence에 host 절대 경로를 포함하지 않는다.

Tier 2 GPT Shadow는 이 경로와 별개로 유지된다. 운영에서는
`OBFUSCATION_GPT_MODE=off`를 전제로 하며 이는 코드 기본값일 뿐, 실제 배포 환경 값은
배포 설정에서 별도로 확인해야 한다. GPT 후보·요청 생성과 관련 실험 코드는 후속 정리 범위다.
