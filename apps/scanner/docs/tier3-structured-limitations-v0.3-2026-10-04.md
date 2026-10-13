# Tier 3 구조화 limitation 계약 0.3.0

## 목적과 범위

Tier 3 Agent는 정적 분석 결과만 작성한다. 출력 0.3.0은 limitation을 없애지 않고 종류와 적용 대상을 구조화하여, 정적 코드 주장에 `RUNTIME_UNCONFIRMED`만 남은 경우까지 일괄 보류하던 문제를 제한적으로 개선한다. 정적 필터, M/A/I 기준, Orchestrator 라우팅, Tier 2, Jev, 코드 슬라이싱, 모델 설정, Policy 외부 계약과 Scoring은 변경하지 않는다.

`VERIFIED`는 Scanner가 계약, assessment-local 참조, Finding/Evidence ID, artifact/slice/라인 범위와 아래 보류 규칙을 통과시켰다는 뜻이다. 악성 판단의 정답, 실제 실행, 전송 성공 또는 서버 수신을 보증하지 않는다.

## 계약 버전과 호환성

- 새 출력 계약과 API Structured Output schema: `0.3.0`
- 새 프롬프트: `scanner-single-agent-0.3.0`
- 입력 계약: 기존 Tier 3 입력 `0.3.0` 유지
- 구형 출력 `0.2.0`: 별도 parser와 기존 자유문장 보류 규칙을 유지한다.

새 assessment는 `claimScope`와 구조화된 `limitations`를 반드시 포함한다.

```json
{
  "claimScope": "CODE_BEHAVIOR",
  "limitations": [
    {
      "kind": "RUNTIME_UNCONFIRMED",
      "detail": "실제 서버 수신 여부는 관찰하지 않았다"
    }
  ]
}
```

`claimScope`는 다음 두 값만 허용한다.

- `CODE_BEHAVIOR`: 코드 표현, 코드상 행위, 정적 데이터 연결
- `STATIC_REACHABILITY`: 진입점, caller와 조건을 포함하여 인용된 정적 호출 경로

limitation kind는 `CODE_MISSING`, `BINDING_UNKNOWN`, `DATA_FLOW_UNKNOWN`, `CALLER_UNKNOWN`, `RESTORE_UNCERTAIN`, `PAYLOAD_UNKNOWN`, `INTENT_UNKNOWN`, `RUNTIME_UNCONFIRMED`, `OTHER` 중 하나다. Agent가 `blocksVerification`을 정하지 않으며 Validator의 고정 규칙이 상태를 결정한다.

응답 전체 `missingContext`도 `kind`와 `detail`을 사용한다. 영향을 특정할 수 있으면 `affectedAssessmentIds`에 해당 assessment ID들을 기록한다. 이 필드가 없으면 범위를 특정할 수 없는 전역 항목으로 보아 모든 assessment에 적용한다. 응답에 존재하지 않는 ID를 쓰면 0.3.0 계약 오류이며 parser가 응답을 거부한다.

API schema는 기존처럼 단일 root object와 nullable transport envelope를 사용한다. nullable placeholder는 domain parsing 전에 재귀적으로 제거되지만, 구조화 limitation과 `affectedAssessmentIds`의 유효 값은 보존된다. 자유문장과 구조화 객체의 혼합, 누락된 `claimScope`, 잘못된 scope/kind는 0.3.0으로 통과할 수 없다.

## Validator 판정

구조·참조 검증이 항상 먼저 적용된다. 다음 검증은 0.2.0과 0.3.0에서 유지된다.

- 중복 assessment/ref ID
- assessment 내부 `flow.trigger/source/transforms/sink/conditions`가 자기 `refs`에 존재하는지
- slice, artifact, planning target, Finding, Atomic Evidence ID의 존재 여부
- slice와 원본 파일의 hash/content 및 라인 범위
- Finding/Evidence와 인용 artifact의 lineage 일치
- Finding ID와 Atomic Evidence ID가 모두 없는 assessment의 보류

따라서 다른 assessment의 ref를 사용하면 limitation과 관계없이 `REJECTED`다. 현재 Validator는 `reachability.entry/path` 문자열을 ref 무결성 대상으로 검사하지 않는다.

0.3.0의 limitation 보류 규칙은 다음과 같다.

| 적용 limitation | 결과 |
| --- | --- |
| assessment 및 적용 대상 global 항목이 없거나 `RUNTIME_UNCONFIRMED`뿐임 | 다른 검증 통과 시 `VERIFIED` 가능 |
| `RUNTIME_UNCONFIRMED` 외 kind 하나 이상 | `PARTIALLY_VERIFIED` |
| 다른 assessment만 지정한 global `missingContext` | 현재 assessment에 적용하지 않음 |
| `affectedAssessmentIds`가 없는 global `missingContext` | 모든 assessment에 적용 |
| 구조·참조 오류 | `REJECTED` |

이번 완화는 두 claim scope에서 `RUNTIME_UNCONFIRMED`에만 적용한다. caller, binding, data flow, 복원, payload, intent의 관련성을 더 세분화하지 않으며 모두 보수적으로 보류한다. `OTHER`와 범위 불명도 보류한다. Agent가 runtime kind를 선택했다는 사실 자체는 코드 의미의 입증이 아니므로 기존 인용 검증을 우회하지 않는다.

0.2.0 자유문장 응답은 `output.missingContext.length > 0 || assessment.limitations.length > 0`이면 기존처럼 보류한다. 자연어 키워드로 새 kind를 추정하거나 저장 응답을 변환하지 않는다. 따라서 기존 파일럿 22개 응답의 상태나 Evidence 수는 이번 구현만으로 변하지 않는다.

## Runner, 실험과 Evidence 영향

운영 `executeV0_3` 경로는 0.3.0 프롬프트, API schema, nullable 정규화와 parser를 사용한다. 코드 제공량 실험 실행기도 향후 생성하는 요청에 동일한 0.3.0 조합을 사용한다. 기존 frozen 요청과 저장 응답은 수정하지 않았으므로, 기존 입력을 그대로 재사용하려면 그 요청에 기록된 구형 계약으로 읽어야 한다. 새 live 비교는 새 schema를 포함한 입력을 별도로 생성해야 한다.

Evidence Adapter는 계속 `VERIFIED` assessment만 변환한다. 외부 Evidence 계약의 `limitations: string[]`은 변경하지 않고 구조화 limitation을 `KIND: detail` 형식으로 보존한다. `claimScope`를 저장할 외부 Evidence 필드는 현재 없으므로 Evidence payload에는 추가하지 않는다. 이를 보존하려면 별도의 외부 계약 변경 검토가 필요하다.

## 검증 범위와 후속 작업

수작업 0.3.0 fixture로 runtime-only 통과, 핵심 부족 보류, scoped/unscoped global 적용, 알 수 없는 대상 ID 계약 거부, 교차-assessment ref 거부, 구형 자유문장 보류, nullable 내용 보존, mutation 방지와 VERIFIED-only Evidence 변환을 검증한다. DD-NPM-010 L0, DD-NPM-013 L1/L3, DD-NPM-003 L4는 fixture 설계의 근거일 뿐 표본별 예외는 없다.

후속 최소 작업은 새 계약으로 소규모 live smoke를 별도 실행하여 모델이 claim scope와 limitation kind를 안정적으로 구분하는지 확인하는 것이다. 특히 핵심 코드 부족을 `RUNTIME_UNCONFIRMED`로 잘못 분류하는지, global 항목을 불필요하게 무범위로 내는지, 독립 주장을 assessment로 분리하는지를 사람이 검토해야 한다. 그 결과 전에는 VERIFIED 증가를 탐지 정확도 향상으로 해석할 수 없다.
