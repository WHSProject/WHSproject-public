# Policy GPT·Claude 비교 평가 Harness

W6-DF-19 구현에 W7-DF-05 품질·성능 비교를 추가했다. Harness는 같은 고정 Fixture, `EvidenceCase`, Policy Snapshot과 `buildPolicyPrompt()`를 두 Provider에 전달한다. 결과는 평가용 JSON과 선택적 CSV이며 Primary·Shadow 실행, 감사 테이블, Decision DB와 연결되지 않는다.

## 실행

Fixture 모드는 기본값이며 GPT·Claude 대신 오프라인 Fixture Provider를 사용한다.

```bash
pnpm --dir apps/policy run build
pnpm --dir apps/policy run policy:compare -- --provider=both \
  --json=reports/validation/policy-llm-comparison.json \
  --csv=reports/validation/policy-llm-comparison.csv
```

결과 디렉터리 `reports/validation/`은 Git ignore 대상이다. 기존 경로는 덮어쓰지 않으므로 재실행은 새 파일명을 사용한다.

실제 Provider는 `--live`를 명시해야 한다. 선택한 Provider의 키가 없으면 실행을 거부하며 키 값은 출력하지 않는다.

```bash
pnpm --dir apps/policy run policy:compare -- --live --provider=both \
  --json=reports/validation/policy-llm-comparison-live.json \
  --csv=reports/validation/policy-llm-comparison-live.csv \
  --pricing=pricing-input.json
```

GPT에는 `OPENAI_API_KEY`, Claude에는 `ANTHROPIC_API_KEY`가 필요하다. Provider 선택은 `--provider=both|gpt|claude`로 제한한다. 모델 환경변수는 `POLICY_LLM_HARNESS_GPT_MODEL`, `POLICY_LLM_HARNESS_CLAUDE_MODEL`이다. Key와 Authorization Header는 결과에서 제외·redact한다.

Harness는 `apps/policy/src/llm/policy-llm.provider.ts`의 공통 interface, `claude-policy-llm.provider.ts`, 기존 Prompt 및 strict Judgment Validator를 사용한다. 최종 Decision은 TypeScript `resolveDecision()`만 계산하고 `score`는 null 정책을 유지한다.

## 고정 Dataset

Fixture Dataset 버전은 `policy-llm-comparison-fixtures-v2`다. 현재 20개 항목은 실제 Registry(`003_predicate_registry.sql`)와 기본/QA Rule(`default-policy.ts`, `002_qa_fixture.sql`, `004_expand_qa_policy.sql`, `005_qa_policy_priority_range.sql`)의 Predicate·Rule 정의를 사용한다. Fixture 입력은 정적·CORRELATED Evidence, 검증된 OSV advisory, 명시적인 부정 또는 미결정 입력으로 구성되며 실제 외부 서비스에 접근하지 않는다.

포함 시나리오:

1. 직접 static exfiltration 관계와 명확한 benign negative
2. child-process capability와 실제 child-process invocation 구분
3. source와 sink만 있고 data flow가 입증되지 않은 입력
4. CORRELATED 관계 Evidence
5. 일반 network와 `REMOTE_CODE_FETCH` 구분
6. 직접 Evidence를 연결한 VERIFIED Assessment
7. REJECTED Assessment의 EvidenceCase 입력 거부 및 품질 비교 제외
8. 유효 OSV advisory, Scanner Predicate의 빈 Feed Citation 기대
9. Prompt Injection 형태 문자열, benign 대안 부재 추론 금지, 근거 부족 UNKNOWN
10. 실제 allOf·anyOf Rule과 CONFLICT 처리

각 유효 Fixture는 Predicate별 기대 status, polarity(명확한 표본만), 허용 Evidence/Assessment/Feed ID 집합, Rule status, Resolver Decision, reason code, validation 기대값을 포함한다. 미검증·거부 Assessment는 `EvidenceCase Builder`가 기존 기준으로 거부하므로 Provider 품질 표본으로 오인하지 않는다. Citation은 선언된 각 namespace의 정확한 집합 일치로 채점한다.

## 지표 정의

일치율은 기대값이 선언된 비교만 분모에 넣는다. Predicate status, Citation set, Rule status, Resolver Decision, reason code별 비교 건수·일치 건수·비율을 Provider별로 집계한다. Fixture polarity가 없는 Predicate는 혼동행렬에서 제외한다.

| 실제 status | Positive 기대 | Negative 기대 |
| --- | --- | --- |
| `SUPPORTED` | TP | FP |
| `NOT_SUPPORTED` | FN | TN |
| `UNKNOWN` / `CONFLICT` | FN 및 미결정 집계 | 미결정만 집계 |

FPR=`FP/(FP+TN)`, FNR=`FN/(FN+TP)`, Precision=`TP/(TP+FP)`, Recall=`TP/(TP+FN)`, Specificity=`TN/(TN+FP)`, Accuracy=`(TP+TN)/(TP+TN+FP+FN)`이다. 분모가 0이면 `null`로 기록한다. 미결정 표본은 일반 status 일치율에는 포함하되 위의 음성 혼동행렬에서는 TN/FP로 세지 않는다.

GPT·Claude pairwise 비교는 동일 Fixture에서 양쪽 결과가 `COMPLETED`이고 validation 성공일 때만 수행한다. 나머지는 Fixture ID와 provider failure, timeout, validation failure 또는 누락 사유와 함께 제외한다. Predicate·Citation·Rule·Decision·reason code 각각의 비교 가능 건수, 일치율, 불일치 Fixture/항목을 결과에 기록한다.

Latency는 skip이 아닌 각 요청의 경과시간을 오름차순 정렬하고 nearest-rank `sorted[ceil(p*n)-1]`로 p50/p95를 계산한다. Token은 Provider가 보고한 값만 합산·평균하며 미보고 요청의 값을 추정하지 않는다. Pricing은 Provider·model별 명시 입력 JSON 또는 `POLICY_LLM_PRICING_JSON`에서 읽고, input/output 및 선택적 cached input 단가를 `tokenUnit` 기준으로 계산한다. 가격 설정이나 usage가 빠진 값은 추정하지 않고 null로 남긴다.

Pricing JSON은 다음 필드를 요구하며 가격 숫자는 운영자가 확인한 외부 가격표에 따라 입력한다.

```json
[
  {
    "provider": "gpt",
    "model": "operator-selected-model",
    "currency": "USD",
    "inputCostPerToken": 0,
    "outputCostPerToken": 0,
    "tokenUnit": 1000000,
    "cachedInputCostPerToken": 0
  }
]
```

이 예시는 설정 형태만 보여준다. 가격 숫자 0은 placeholder이며 비용 0으로 실행하는 설정이 아니다. 외부 가격을 확인해 교체하지 않으면 Pricing 입력을 생략한다. 비용은 평가 값이고 Policy 결정에 쓰이지 않는다.

## 결과와 재현성

JSON 보고서에는 Harness/Fixture Dataset version과 hash, mode, 시작·완료 시각, Provider·Model, Prompt version/hash, Policy version/snapshot hash, input hash, validation, Resolver 출력, token usage, latency, pricing 입력, failure code 및 limitation이 들어간다. CSV에는 Fixture·Provider별 재현 hash, validation/Resolver, latency·token·cost·failure 필드를 담는다.

Provider 원문 응답과 Judgment는 secret key 이름, Bearer 값, API-key 형식 문자열을 redact한 후 출력한다. 실제 Live 원문 출력은 커밋하지 않는다. JSON과 CSV는 임시 파일로 모두 staging한 뒤 atomic rename하며 최종 경로가 이미 있으면 거부한다. 쓰기 실패 시 임시 파일과 이미 commit한 출력물을 정리한다.

Fixture/Mock 평가 결과와 Live Provider 평가의 의미는 구분한다. CLI의 `PolicyLlmComparisonFixtureProvider`는 기존 `FixturePolicyLlmProvider`의 결정적 문자열 heuristic을 재사용한다. 이 provider는 fixture의 기대 status를 읽지 않으며, 주로 observation/assessment 본문에서 Predicate code 문자열을 찾을 때 해당 Predicate를 지원한다. Feed-only OSV Evidence는 이 heuristic의 observation 문자열 검색으로 평가되지 않는다. 따라서 이 mock은 expected judgment oracle도 아니고 일부러 오답을 넣는 품질 benchmark mock도 아니다. Mock의 TP/TN/FP/FN은 이 heuristic에 대한 Harness 집계 검증값일 뿐 GPT·Claude의 품질 결과가 아니다.

Mock GPT/Claude 모드는 동일한 `PolicyLlmComparisonFixtureProvider`에 Provider 이름과 Model 표기만 달리해 실행한다. Pairwise 일치율 100%는 같은 결정적 mock 구현이 같은 입력에서 같은 결과를 냈다는 뜻이며, 실제 GPT와 Claude의 판단이 같다는 뜻이 아니다. 실제 Provider 품질·Latency·Token·비용 비교값은 명시적으로 `--live`를 실행하고 결과를 확인한 뒤에만 확정한다. 현재 Live 평가는 미실행이다. Fixture 실행은 Primary·Shadow나 DB 저장 경로를 호출하지 않으며 자동 테스트에서도 GPT·Claude·OSV 네트워크를 사용하지 않는다.

이번 Fixture/Mock 집계에서 FN=3은 `direct-static-malicious/DATA_REACHES_EXTERNAL_SINK`, `correlated-direct-relation/DATA_REACHES_EXTERNAL_SINK`, `osv-advisory-applies/OSV_ADVISORY_APPLIES`에 해당한다. 앞의 두 Evidence 설명에는 Predicate code 문자열이 없고 OSV는 Feed namespace라 기존 heuristic의 본문 검색으로 발견되지 않는다. TP=2는 child-process invocation과 remote-code-fetch fixture다. Recall은 `2/(2+3)=0.4`로 계산이 맞다. Negative polarity인 `network-is-not-remote-code`는 기대 status가 UNKNOWN이어도 실제 NOT_SUPPORTED를 TN으로 세며, 이 분류는 Harness의 고정 polarity 정책을 따른다.

실제 Python 전체 테스트 결과와 본 Mock 실행 수치는 [W7 PR4 검증 기록](w7-pr4-llm-provider-quality-performance.md)을 참조한다.
