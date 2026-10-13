# TypeScript Policy Rules

Policy는 숫자 risk score를 계산하지 않는다. `/internal/v1/evaluations`로 받은 Evidence Case와 Policy DB의 active snapshot을 조합해 정책 조건을 판정한다.

```text
Evidence Case → Active Policy Snapshot → Policy GPT predicate judgment → TypeScript Resolver → ACCEPT / REJECT / HOLD / REVIEW
```

Policy DB의 `condition_json`은 다음 구조를 사용한다.

```json
{
  "when": {"allOf": [{"predicate": "SENSITIVE_DATA_ACCESSED"}]},
  "minimumSupport": "SUPPORTED",
  "onUnknown": "HOLD"
}
```

등록된 predicate만 사용할 수 있다. GPT는 predicate를 새로 만들 수 없고, 실제 Evidence ID와 Assessment ID를 연결해야 한다.

OSV Advisory는 Scanner Evidence와 다른 Policy-local 근거다. 활성 rule에
`OSV_ADVISORY_APPLIES`가 있을 때만 GPT 입력에 포함하고, GPT는 별도
`feedEvidenceIds`로만 참조한다. OSV 근거를 악성 행위 predicate에 연결하거나
Severity를 점수로 변환하지 않는다. `OSV_ADVISORY_APPLIES`를 포함한 rule은
REJECT를 확정할 수 없다. Scanner의 명확한 악성 행위는 OSV와 분리된 REJECT rule로
평가하므로 기존 Scanner 기반 REJECT는 유지된다.

주요 predicate는 `LIFECYCLE_TRIGGERED`, `EXECUTION_PATH_REACHABLE`, `SENSITIVE_DATA_ACCESSED`, `DATA_REACHES_EXTERNAL_SINK`, `DATA_REACHES_PROCESS_EXECUTION`, `BENIGN_ALTERNATIVE_SUPPORTED`, `BENIGN_ALTERNATIVE_NOT_SUPPORTED`, `DECISIVE_LINK_UNRESOLVED`, `ANALYSIS_COVERAGE_INCOMPLETE`, `OSV_ADVISORY_APPLIES`다.

Resolver는 최종 Decision에 선택된 rule이 실제로 인용한 `evidenceIds`, `assessmentIds`,
`feedEvidenceIds`만 전달한다. 입력에 포함된 모든 Evidence를 판정 근거로 저장하지 않으며,
`anyOf`는 하나의 branch가 `SUPPORTED`이면 다른 branch의 `UNKNOWN`만으로 판정을 보류하지 않는다.

결정 순서는 유효한 REJECT rule, 근거 충돌, 결정적 UNKNOWN, 매칭 rule effect, default decision 순이다. `score`는 하위 호환을 위해 nullable로 남을 수 있지만 판단에 사용하지 않는다.

Active Policy에서 어떤 rule도 매칭되지 않으면 runtime 기본 판정은 `ACCEPT`다. 근거 충돌이나
결정적 미확정은 기존 `REVIEW`/`HOLD` 경로를 따르며, Policy LLM 실패 시에는
`judgmentFailureDecision`을 적용한다. Active Policy DB 응답의 `defaultDecision` 값은 runtime
기본 판정을 덮어쓰지 않는다.

구현 파일은 `src/case`, `src/llm`, `src/policy`, `src/decision`에 있다.
