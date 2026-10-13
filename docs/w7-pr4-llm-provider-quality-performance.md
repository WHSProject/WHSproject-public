# W7 PR 4: LLM Provider 품질·성능 평가

Issue #453 · W7-DF-05 · Branch `test/w7-df-453-llm-provider-quality-performance`

## 검증 범위와 기존 구조

같은 고정 입력으로 GPT와 Claude Provider의 Judgment를 비교하고 Predicate/Citation/Rule/Decision 품질, latency, usage, 명시 가격 기반 비용을 재현 가능한 JSON·CSV로 산출한다. 운영 Provider 판단 의미를 변경하지 않는다. Prompt version/content, Judgment Validator, Citation namespace 검증, Policy Rule, TypeScript Resolver, Primary·Shadow 저장 흐름은 기존 구현을 그대로 사용한다.

Harness 흐름은 `buildEvidenceCase()` → `buildPolicyPrompt()` → `PolicyLlmProvider.analyze()` → `validatePolicyJudgment()` → `resolveDecision()` → 집계/보고서다. Provider별 실패·validation 실패·timeout은 결과 행에 격리한다. Harness는 Primary·Shadow 감사 또는 Decision 저장 API를 호출하지 않는다.

작업 전 확인에서 HEAD와 `origin/dev`는 `f7fc47c5a5b637a58a15cb7af76e8dbfa2ee8815`로 같았고 작업 트리는 clean이었다. Issue 페이지와 `gh issue view`는 네트워크/API 접속 오류로 본문 확인이 불가능해 사용자가 제공한 범위 설명을 기준으로 했다. 저장소에는 W7 PR1 및 PR3 검증 문서가 있으나 별도 PR2 검증 문서는 발견하지 못했다.

## 고정 Fixture Dataset

Dataset version은 `policy-llm-comparison-fixtures-v2`다. 현재 20개 Fixture 중 18개는 Provider 품질 표본이고 UNVERIFIED·REJECTED Assessment 입력 각 1개는 기존 Builder validation에서 제외된다. Dataset hash는 고정 Fixture 객체를 canonical JSON으로 직렬화한 SHA-256이다. Predicate 정의는 `003_predicate_registry.sql`, 기본 Rule은 `default-policy.ts`, QA Rule은 `002_qa_fixture.sql`, `004_expand_qa_policy.sql`, `005_qa_policy_priority_range.sql` 및 OSV Rule `002_qa_fixture.sql`의 등록 내용을 사용한다.

| Fixture | 기대 Predicate status | 실제 Rule / 기대 Rule status | Resolver 기대값 |
| --- | --- | --- | --- |
| `direct-static-malicious` | `SENSITIVE_DATA_ACCESSED`, `DATA_REACHES_EXTERNAL_SINK`, `EXECUTION_PATH_REACHABLE`, `BENIGN_ALTERNATIVE_NOT_SUPPORTED` 모두 SUPPORTED | `MALWARE-EXFIL-001` / SATISFIED | REJECT / `POLICY_CONFIRMED_DATA_EXFILTRATION` |
| `clear-negative` | 위 4개 모두 NOT_SUPPORTED | `MALWARE-EXFIL-001` / NOT_SATISFIED | ACCEPT / `POLICY_DEFAULT` |
| `capability-without-invocation` | CHILD_PROCESS_SPAWNED, EXECUTION_PATH_REACHABLE, BENIGN_ALTERNATIVE_NOT_SUPPORTED 모두 UNKNOWN | `RULE-REJECT-CHILD-PROCESS` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `source-sink-without-flow` | 민감 데이터 SUPPORTED, 외부 흐름·실행 경로·benign 대안 배제 UNKNOWN | `MALWARE-EXFIL-001` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `correlated-direct-relation` | credential source, external sink, execution path, benign alternative 배제 모두 SUPPORTED | `RULE-REJECT-CONFIRMED-EXFIL` / SATISFIED | REJECT / `POLICY_CONFIRMED_CREDENTIAL_EXFILTRATION` |
| `child-process-invocation` | child process, execution path, benign alternative 배제 모두 SUPPORTED | `RULE-REJECT-CHILD-PROCESS` / SATISFIED | REJECT / `POLICY_CONFIRMED_CHILD_PROCESS_EXECUTION` |
| `network-is-not-remote-code` | lifecycle, REMOTE_CODE_FETCH, execution path, benign 대안 배제 모두 UNKNOWN | `RULE-REJECT-REMOTE-CODE` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `remote-code-fetch-confirmed` | lifecycle, REMOTE_CODE_FETCH, execution path, benign 대안 배제 모두 SUPPORTED | `RULE-REJECT-REMOTE-CODE` / SATISFIED | REJECT / `POLICY_REMOTE_CODE_FETCH` |
| `verified-assessment-enrichment` | CREDENTIAL_SOURCE_ACCESSED, INDEPENDENT_SUPPORT_PRESENT 모두 SUPPORTED | `RULE-REVIEW-CREDENTIAL-ACCESS` / SATISFIED | REVIEW / `POLICY_CREDENTIAL_ACCESS_REVIEW` |
| `rejected-assessment-excluded` | REJECTED Assessment를 EvidenceCase Builder가 거부; 품질 계산 제외 | `RULE-REVIEW-CREDENTIAL-ACCESS` / 입력 거부 | Provider 평가 제외 / `INVALID_LLM_ASSESSMENT` |
| `unverified-assessment-excluded` | UNVERIFIED Assessment를 EvidenceCase Builder가 거부; 품질 계산 제외 | `RULE-REVIEW-CREDENTIAL-ACCESS` / 입력 거부 | Provider 평가 제외 / `INVALID_LLM_ASSESSMENT` |
| `osv-advisory-applies` | OSV_ADVISORY_APPLIES SUPPORTED, Citation은 `feedEvidenceIds`만 | `RULE-REVIEW-OSV-HIGH` / SATISFIED | REVIEW / `OSV_ADVISORY_REVIEW` |
| `osv-not-scanner-citation` | credential source SUPPORTED는 Evidence namespace, corroboration NOT_SUPPORTED, OSV Predicate SUPPORTED는 Feed namespace | `RULE-REVIEW-CREDENTIAL-ACCESS` / NOT_SATISFIED; `RULE-REVIEW-OSV-HIGH` / SATISFIED | REVIEW / `OSV_ADVISORY_REVIEW` |
| `prompt-injection-is-data` | 세 child-process Rule Predicate 모두 UNKNOWN | `RULE-REJECT-CHILD-PROCESS` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `benign-absence-is-unknown` | exfiltration Rule Predicate 네 개 모두 UNKNOWN | `MALWARE-EXFIL-001` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `evidence-insufficient-unknown` | NATIVE_BINARY_LOADED, ANALYSIS_COVERAGE_INCOMPLETE 모두 UNKNOWN | `RULE-HOLD-NATIVE-BINARY` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `anyof-coverage-unknown` | DECISIVE_LINK_UNRESOLVED NOT_SUPPORTED, ANALYSIS_COVERAGE_INCOMPLETE UNKNOWN | `MALWARE-UNRESOLVED-001` / UNKNOWN | HOLD / `POLICY_DECISIVE_EVIDENCE_UNKNOWN` |
| `anyof-conflict` | DECISIVE_LINK_UNRESOLVED CONFLICT, ANALYSIS_COVERAGE_INCOMPLETE SUPPORTED | `MALWARE-UNRESOLVED-001` / CONFLICT | REVIEW / `POLICY_EVIDENCE_CONFLICT` |
| `allof-review-obfuscation` | OBFUSCATION_PRESENT, ANALYSIS_COVERAGE_INCOMPLETE 모두 SUPPORTED | `RULE-REVIEW-OBFUSCATION` / SATISFIED | REVIEW / `POLICY_OBFUSCATION_REVIEW` |
| `native-binary-analysis-required` | NATIVE_BINARY_LOADED, ANALYSIS_COVERAGE_INCOMPLETE 모두 SUPPORTED | `RULE-HOLD-NATIVE-BINARY` / SATISFIED | HOLD / `POLICY_NATIVE_BINARY_ANALYSIS_REQUIRED` |

기대 Evidence·Assessment·Feed ID는 Fixture 안의 요청과 namespace를 참조한다. quality polarity는 분명한 `DATA_REACHES_EXTERNAL_SINK`, `CHILD_PROCESS_SPAWNED`, `REMOTE_CODE_FETCH`, `OSV_ADVISORY_APPLIES` 표본에만 지정한다. Predicate/Rule/Citation이 적절한 근거로 평가되지 않는 경우 기존 Validator가 이를 허용하지 않도록 기존 경계를 유지한다.

## 오탐·미탐 및 품질 지표

Polarity가 명시된 Predicate 표본만 이진 품질 지표에 넣는다. Positive + SUPPORTED는 TP, Positive + 그 외 status는 FN, Negative + SUPPORTED는 FP, Negative + NOT_SUPPORTED는 TN이다. Negative + UNKNOWN/CONFLICT는 FP나 TN에 넣지 않고 미결정 수에만 넣는다. UNKNOWN/CONFLICT는 별도 집계하며 Prediction status 일치율에는 포함한다. Polarity 없는 Predicate는 confusion metric에서 제외한다.

Provider별 보고는 전체·품질 대상 Fixture 수, 완료·validation 성공 수/비율, Predicate/Citation/Rule/Decision/reason code별 비교 건수·일치 건수·일치율, TP/TN/FP/FN, FPR/FNR/Precision/Recall/Specificity/Accuracy, 미결정·Provider 실패·validation 실패·timeout 수를 포함한다. 분모가 0인 비율은 JSON `null`이다.

GPT와 Claude pairwise는 같은 Fixture에서 양쪽 결과가 COMPLETED이고 validation 성공일 때만 비교한다. Predicate status, Citation ID set, Rule status, 최종 Resolver Decision, reason code 일치율을 계산하며 비교 가능 수, 비교 제외 Fixture/사유, 불일치 Fixture와 항목을 별도로 남긴다.

## 성능·Token·예상 비용

Provider별 완료·실패 요청 수, min/average/max/p50/p95 latency를 기록한다. Percentile은 요청 latency를 오름차순 정렬해 nearest-rank `sorted[ceil(p*n)-1]` 방식으로 계산한다. Skip 요청은 latency 통계에서 제외한다.

Input·Output·Total Token 합계와 보고된 요청 기준 평균을 제공한다. Total Token은 Provider가 명시하지 않았더라도 Input과 Output이 모두 존재할 때만 파생한다. 예상 비용은 Provider·model이 맞는 명시 Pricing 입력만 사용하고, 비용 합계와 완료 Fixture당 평균을 출력한다. 일부 완료 요청의 비용을 계산할 수 없으면 전체 완료 요청당 평균 비용은 null이다. 가격은 코드·문서에 하드코딩하지 않는다.

Pricing 입력은 `--pricing=<path>` 또는 `POLICY_LLM_PRICING_JSON` JSON 배열로 받는다. 각 항목은 `provider`, `model`, `currency`, `inputCostPerToken`, `outputCostPerToken`, `tokenUnit`을 포함하고 `cachedInputCostPerToken`은 선택사항이다. 단위는 `tokenUnit` tokens이며 비용은 입력 토큰×단가를 tokenUnit으로 나눈다. 가격 정보나 Token usage가 없으면 비용은 null이다.

## 실행과 결과 보호

Fixture/Mock 비교:

```bash
pnpm --dir apps/policy run build
pnpm --dir apps/policy run policy:compare -- --provider=both \
  --json=reports/validation/w7-pr4-fixture.json \
  --csv=reports/validation/w7-pr4-fixture.csv
```

Live 실행 명령:

```bash
pnpm --dir apps/policy run policy:compare -- --live --provider=both \
  --json=reports/validation/w7-pr4-live.json \
  --csv=reports/validation/w7-pr4-live.csv \
  --pricing=/path/to/operator-pricing.json
```

Live는 GPT `OPENAI_API_KEY`, Claude `ANTHROPIC_API_KEY`와 선택 Provider의 모델 환경변수를 필요로 한다. 이 문서 작성과 일반 자동 검증 중에는 Live 호출을 실행하지 않는다.

JSON 최상위 재현 필드는 Harness version/mode/time, Prompt version, Fixture Dataset version/hash, Provider·model, Policy version/hash, Prompt/input hash, validation, Resolver result, Token, latency, pricing input, failure code다. CSV는 기존 Fixture 행을 유지하고 재현 hash, validation·Resolver, latency·usage·cost·failure 열을 추가한다. `PAIRWISE` 행에는 provider 간 각 항목 일치율, 제외 Fixture 및 불일치를 담는다. 출력 기본 디렉터리는 `.gitignore`의 `reports/validation/` 규칙에 포함된다. 기존 결과 파일을 덮어쓰지 않고 JSON·CSV 임시 출력을 atomic 처리한다. Secret/Authorization Header는 기록하지 않으며 Provider 원문 응답과 Judgment는 안전한 redaction을 적용한다. Live 결과 원문은 저장소에 커밋하지 않는다.

## 검증 기록

아래 표는 실제로 실행한 typecheck/build/테스트와 결과를 기록한다. Live GPT·Claude·OSV 연결은 실행하지 않는다.

| 명령 | 결과 |
| --- | --- |
| Issue #453 조회 | GitHub Web 및 `gh` API 네트워크 오류로 미확인; 요청 본문을 기준으로 구현 |
| `pnpm typecheck` (`apps/policy`) | 통과 |
| `pnpm build` (`apps/policy`) | 통과 |
| `pnpm test` (`apps/policy`) | 17 suites 통과 |
| Comparison Harness·Output·Validator·Resolver·Primary·Shadow 회귀 대상 `node --test ...` | 6 suites 통과 |
| `python3 -m compileall -q app tests` (`apps/policy`) | 통과 |
| `python3 -m pytest -q` (`apps/policy`) | 시스템 Python에 FastAPI/Pydantic가 없어 7개 테스트 모듈 수집 오류 |
| `.venv/bin/python -m pytest -vv -x` (sandbox, `apps/policy`) | `test_new_input_null_is_422_but_legacy_jsonb_null_is_readable`의 Starlette TestClient에서 중단. AnyIO `BlockingPortal.call()`의 Future 대기와 asyncio selector 대기를 확인했고, 별도 최소 `loop.call_soon_threadsafe` 실행도 sandbox에서 callback이 실행되지 않음 |
| Linux `/tmp` 복사본에서 Python CI 전체 명령 `python -m pytest -q` (sandbox 제한 해제, 기존 venv 의존성 및 테스트용 migration 복사) | 74 passed. 테스트 코드·기대값은 수정하지 않음; DB·Provider·Feed는 mock 사용 |
| Fixture/Mock GPT·Claude 비교 CLI | 성공; 품질 대상 18개씩 validation 성공, pairwise 비교 18개, 2개 Assessment 입력 제외, 가격 미설정이라 예상 비용 null |
| Live Key/Provider/Model 및 Pricing 입력 preflight | unset Key, 미지원 Provider, 빈 Model, tokenUnit 0을 각각 거부; 실제 Provider 호출 없음 |
| 생성 JSON 검증 | 20 Fixture, 각 Provider 18/18 완료·유효, JSON.parse 성공, 비유한 숫자 없음, secret pattern 없음 |
| 생성 CSV 검증 | Fixture 40행 + pairwise 1행, 47열; 모든 행 열 수 일치 |
| Policy Validator·Resolver·Primary·Shadow 회귀 | 위 대상 6 suites와 전체 17 suites에서 통과 |
| Output overwrite·임시 파일 정리·secret redaction | Output writer 테스트 통과; Harness secret redaction 및 임시 파일 정리 테스트 통과 |
| Live GPT·Claude·OSV 외부 평가 | 미실행; Fixture/Mock 테스트에서 fetch 0회 확인 |
| `git diff --check`·최종 Git 상태 | 통과; branch/HEAD가 시작 시점과 동일, 변경 7개 파일 모두 unstaged, staged 변경 없음 |

Fixture/Mock CLI 실행에서 두 offline Provider는 각각 18/18 품질 대상 Judgment validation에 성공했고, 양 provider가 완료한 18 Fixture의 Predicate/Citation/Rule/Decision/reason code pairwise 일치율은 모두 100%였다. 이는 두 provider 이름으로 실행한 **같은 결정적 `PolicyLlmComparisonFixtureProvider`**가 같은 결과를 반환했다는 뜻이다. Fixture Provider는 기대 status를 사용하지 않는 기존 `FixturePolicyLlmProvider` heuristic이며 실제 GPT·Claude의 모델이 아니다. 따라서 100% pairwise는 실제 Provider 간 품질 일치의 증거가 아니며, 아래 품질·Latency 수치는 실제 GPT·Claude 성능 수치가 아니다.

UNVERIFIED·REJECTED Assessment 입력은 양쪽에서 `EVIDENCE_CASE_REJECTED:INVALID_LLM_ASSESSMENT`로 제외됐다. 각 Provider mock 집계는 TP=2, TN=2, FP=0, FN=3, FPR=0, FNR=0.6, Precision=1, Recall=0.4, Specificity=1, Accuracy=4/7이다. FN 3건은 `direct-static-malicious/DATA_REACHES_EXTERNAL_SINK`, `correlated-direct-relation/DATA_REACHES_EXTERNAL_SINK`, `osv-advisory-applies/OSV_ADVISORY_APPLIES`다. 앞 두 Fixture는 Predicate code가 Evidence 본문에 없어 문자열 heuristic이 놓치고, OSV 근거는 Feed namespace라 해당 본문 검색에 포함되지 않는다. 이는 의도적으로 주입한 오답이 아니라 기존 CI Fixture Provider heuristic의 한계다. Positive 표본 5건 중 2 TP와 3 FN이므로 Recall=`2/(2+3)=0.4`는 계산상 맞다. Negative polarity인 `network-is-not-remote-code`는 기대 status가 UNKNOWN이어도 실제 NOT_SUPPORTED를 정해진 분류 정책에 따라 TN으로 센다.

Mock Provider latency는 GPT 평균 약 0.944 ms (min 0.320, p50 0.582, p95/max 6.233), Claude 평균 약 0.593 ms (min 0.239, p50 0.495, p95/max 1.181)였다. 입력 Token usage가 없는 mock이라 Token과 비용은 null이다. 실제 GPT·Claude 품질·Latency·Token·비용 비교값은 Live 평가를 별도로 실행하고 그 결과를 검토한 뒤에만 확정할 수 있다. Live 평가는 이번 작업에서 **미실행**이다.
| 실제 Live GPT·Claude 평가 | 미실행 |
| 실제 외부 GPT·Claude·OSV 네트워크 평가 | 미사용 |

## 완료 근거와 제한

Harness 구현·산출 경로의 검증은 고정 Fixture, mock pairwise, 집계 지표, JSON/CSV 안전 저장, TypeScript 및 Python 회귀 결과에 근거한다. 실제 GPT·Claude 모델 품질·Latency·Token·비용 평가는 Live가 미실행이므로 아직 확정되지 않았다. Python 테스트가 기본 sandbox에서 멈춘 원인은 `TestClient` 테스트 무한 대기가 아니라 sandbox의 asyncio cross-thread wake 제한이었다. sandbox 제한을 해제한 Linux `/tmp` 실행에서 74개 전체 테스트가 통과했다. Issue 본문과 저장소의 PR2 별도 검증 문서는 확인할 수 없어 별도 제약으로 기록한다.
