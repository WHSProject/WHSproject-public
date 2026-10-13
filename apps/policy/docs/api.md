# Policy API

Policy runtime은 TypeScript로 실행한다. 기존 Scanner가 호출하는 평가 endpoint와 Policy DB·Decision DB API endpoint는 유지한다.

## Evaluation

```text
POST /internal/v1/evaluations
```

요청의 `requestId`, `scanStatus`, `scanId`, `subject`, `evidences`, `osvFeed` 필드는 유지한다. `score`는 nullable deprecated 입력으로 받을 수 있지만 무시한다. Evidence에는 `ATOMIC`, `CORRELATED`, `LLM_ASSESSMENT`가 포함될 수 있다.

처리 순서는 request validation, OSV validation, Feed Snapshot/Attempt 저장, Policy DB active snapshot 조회, Evidence Case 구성, Policy GPT structured judgment, LLM 판단 감사 이력 저장, TypeScript rule resolver, Decision DB 저장 순이다. Shadow 모드가 켜져 있으면 후보 실행도 같은 prompt로 수행해 감사 이력에 비교 결과를 남기지만 실제 Decision에는 영향을 주지 않는다. Feed 또는 LLM 감사 이력 저장 실패는 Decision 저장 성공으로 응답하지 않는다.

실제 GPT Shadow는 `POLICY_LLM_SHADOW_MODE=openai`로 켤 수 있으며, `POLICY_LLM_SHADOW_MODEL`을
지정하면 Primary와 다른 GPT 모델을 사용할 수 있다. 이 호출도 OpenAI Responses API와 동일한
structured output schema, timeout, output validator를 거치고 원본 응답은 LLM 감사 이력에 저장된다.
Fixture 검증은 `POLICY_LLM_FIXTURE_SCENARIO=positive|negative|evidence`와
`POLICY_LLM_FIXTURE_TARGET_PREDICATE`로 특정 custom predicate의 긍정·부정 judgment를 재현한다.

각 Primary/Shadow 감사 row에는 `runMode`, `requestId`, `scanId`, `policyKey`, `policyVersion`,
`policyHash`, `provider`, `model`, `promptVersion`, `inputHash`, `providerRequestId`,
`durationMs`, `judgmentId`, `status`, `prompt`, `judgmentJson`, `responseJson`, `failureCode`,
`resolvedDecision`, `resolvedReasonCode`, `shadowOfJudgmentId`, `comparison`, `evaluatedAt`가
저장된다. `inputHash`는 Provider에 실제 전달한 최종 prompt 문자열의 UTF-8 SHA-256이며,
Policy Snapshot SHA-256인 `policyHash`와 다르다. 수집 시각, API key, Authorization header,
Provider request ID, 소요 시간은 `inputHash`에 포함하지 않는다. Prompt JSON payload는 object
key를 정렬해 동일한 논리 입력의 prompt hash가 결정적으로 유지되도록 한다.

Provider 오류·Timeout·Abort·JSON/schema·Judgment Validator 실패도 `status=FAILED`와
`failureCode`를 가진 audit row로 보존한다. 잘못된 Judgment는 Resolver에 전달하지 않고
`judgmentFailureDecision`으로 fallback하며, Shadow 실패는 Primary Decision을 변경하지 않는다.

응답은 기존 `decisionId`, `requestId`, `score`, `decision`, `reasonCode`, `reason`, `matchedRuleIds`, `evidenceIds`, `scanId`, `policyVersion`, `subject`, `evaluatedAt`, `persistence` 필드를 유지한다. `score`는 `null`이며 `judgmentId`는 추가 감사 추적 필드다. `evidenceIds`와 `assessmentIds`는 최종 Decision에 실제로 인용된 근거만 포함한다. `feed`와 `llm`은 OSV 수집·검증 장애와 Policy GPT 장애를 분리해 노출하며, `feed.citedFeedEvidenceIds`는 최종 Decision rule이 실제 인용한 Policy-local OSV 근거다. `feed.feedEvidenceIds`는 이번 평가에서 검증된 전체 OSV 근거이며 Scanner `evidenceIds`가 아니다.

## Database boundaries

- Policy DB: `GET /internal/v1/policies/active`로 active snapshot과 predicate registry를 읽는다.
- Decision DB: `POST /internal/v1/decisions`로 최종 Decision을 저장한다.
- Decision DB: `POST /internal/v1/feed-lookups`로 모든 OSV Attempt와 성공 Snapshot을 저장한다.
- Decision DB: `POST /internal/v1/llm-judgments`로 Primary/Shadow Policy GPT 원문과 검증·비교 결과를 저장한다.
- Decision migration `009_add_policy_llm_input_fingerprint.sql`은 기존 row를 보존하면서
  `provider`, `prompt_version`, `input_hash`를 nullable audit metadata로 추가한다. 기존
  `007` migration은 수정하지 않으며 신규 bootstrap에도 같은 migration 순서를 적용한다.
- Evidence DB와 Policy DB API, Decision DB API는 Python DB adapter로 계속 실행한다.
- Policy runtime만 Node.js/TypeScript로 교체한다.

운영 오류는 Security Decision과 구분한다. 요청·Evidence·OSV 무결성 오류는 `422`, Policy DB 또는 Feed DB 응답 오류는 `502`, DB 연결 실패는 `503`이다. Feed 저장 단계 오류는 `FEED_SNAPSHOT_PERSISTENCE_FAILED`와 `FEED_ATTEMPT_PERSISTENCE_FAILED`로 구분한다. GPT 실패는 `HOLD` Decision으로 저장하고 `POLICY_LLM_UNAVAILABLE`을 기록한다.
