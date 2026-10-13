# Tier 3 구조화 limitation 0.3.0 소규모 live 비교

## 범위와 실행 완결성

정확히 DD-NPM-010 L2, DD-NPM-013 L1, DD-NPM-013 L3, DD-NPM-003 L4를 실행했다. 네 조건 모두 HTTP 200, Provider 요청 1회, Runner 호출 1회로 종료됐고 실패·UNKNOWN·미실행 조건은 없다. 총 Provider 요청과 Runner 호출은 각각 4회다. 추가 코드 요청은 없었으며 Jev는 비활성이다.

실제 설정은 `gpt-5.6-luna`, reasoning effort `medium`, output schema `0.3.0`, prompt `scanner-single-agent-0.3.0`, 최대 출력 32,768 tokens, timeout 180초, retry 0, `store: false`다. 입력 4개는 `2026-10-04-input-schema-fix-v2`의 대응 JSON과 byte-identical하며 live `inputHash`와 `codeHash`도 dry-run 값과 일치한다. 따라서 코드, Finding, Atomic Evidence, package context와 artifact identity는 유지됐다.

실행 성공은 모델 호출 완료를 뜻할 뿐 검증 성공을 뜻하지 않는다. 네 Runner는 모두 `PARTIAL`이고 VERIFIED와 Evidence는 0건이다.

## 조건별 결과와 이전 0.2 비교

| 조건 | 새 assessment 상태 | 새 Evidence | 기존 assessment 상태 | 기존 Evidence | 새 usage input/cached/output/reasoning/total | 새 저장 duration | 기존 duration |
| --- | --- | ---: | --- | ---: | --- | ---: | ---: |
| DD-NPM-010 L2 | P 2 / R 1 | 0 | P 2 | 0 | 18,299 / 0 / 4,033 / 1,552 / 22,332 | 40,333 ms | 25,770 ms |
| DD-NPM-013 L1 | P 4 | 0 | P 3 | 0 | 21,104 / 0 / 3,265 / 407 / 24,369 | 33,985 ms | 28,834 ms |
| DD-NPM-013 L3 | P 4 | 0 | P 3 | 0 | 25,481 / 0 / 3,941 / 948 / 29,422 | 32,992 ms | 23,957 ms |
| DD-NPM-003 L4 | P 3 | 0 | P 3 | 0 | 172,634 / 0 / 2,853 / 839 / 175,487 | 26,762 ms | 18,423 ms |

`P`는 PARTIALLY_VERIFIED, `R`은 REJECTED다. reasoning tokens는 output tokens의 부분집합이며 합계에 다시 더하지 않았다. 네 조건 합계는 assessment 14개, PARTIALLY_VERIFIED 13개, REJECTED 1개, VERIFIED 0개, Evidence 0개, 변환 실패 0개다. 실제 합산 usage는 input 237,518, cached 0, output 14,092, reasoning 3,746, total 251,610이다.

저장 산출물에는 Provider-only latency가 따로 없고 조건별 `durationMs`만 있다. 따라서 표의 시간은 Provider 호출을 포함한 Runner 측 저장 duration이며 순수 네트워크 시간으로 해석하지 않는다.

## limitation 구조화 품질

14개 assessment 중 13개가 `CODE_BEHAVIOR`, 1개가 `STATIC_REACHABILITY`다. assessment limitation에는 `RUNTIME_UNCONFIRMED` 13회 외에 CALLER 7, PAYLOAD 6, BINDING 2, INTENT 2, DATA_FLOW 1이 함께 기록됐다. global missingContext는 11개이고 모두 `affectedAssessmentIds`를 가졌다. 대상 없는 전역 항목은 없었다.

구조화 형식 자체는 잘 지켜졌다. 잘못된 kind, scope 누락, 혼합 자유문장, 존재하지 않는 affected ID는 없었다. 그러나 분류의 의미 정확성에는 다음 문제가 있다.

- `RUNTIME_UNCONFIRMED`를 코드·caller·payload 부족 대신 사용한 명백한 우회는 보이지 않았다. 핵심 부족에는 별도 CALLER/PAYLOAD/BINDING/DATA_FLOW 종류가 대체로 함께 붙었다.
- 반대로 모델은 좁은 `CODE_BEHAVIOR`에도 caller·intent·payload limitation을 폭넓게 붙였다. 현 Validator는 runtime 이외 모든 kind를 보류하므로 정적 표현 자체가 충분해도 VERIFIED가 되지 않았다.
- global scope는 모두 명시됐지만 일부 대상이 과도하다. DD-NPM-003 L4의 multisig fixture assessment는 단순 fixture 해석인데 공통 CALLER_UNKNOWN 대상에 포함됐다. 해당 코드 표현 판단에는 package caller가 필요하지 않다.
- VERIFIED Evidence가 없으므로 새 구조화 limitation이 실제 Evidence payload에 보존되는 live 사례는 관찰하지 못했다. Adapter 단위 회귀에서는 `KIND: detail` 보존을 확인했지만 이번 live 결과로 입증된 것은 아니다.

새 응답에 기존의 “assessment limitation 또는 응답 전체 missingContext가 하나라도 있으면 보류” 규칙을 가정하면, 구조 오류가 없는 13개 assessment는 모두 PARTIALLY_VERIFIED이고 ref 오류 1개는 REJECTED다. 실제 새 결과와 동일하다. 이는 구형 parser 실행이 아니라 보류 규칙만 적용한 counterfactual이다. 따라서 이 4조건에서는 Validator 완화가 실제 상태나 Evidence 수를 바꾸지 않았다.

## 대표 사례 검토

### DD-NPM-010 L2

두 번째 assessment는 `CODE_BEHAVIOR`로 환경·system 객체가 `httpPost` payload에 들어가고, `JSON.stringify(payload)`를 거쳐 `req.write(body)`로 전달되는 연결을 올바른 assessment-local refs로 인용했다. 서버 수신 미관찰은 `RUNTIME_UNCONFIRMED`로 분리했다. 이 좁은 정적 연결은 코드로 확인된다.

그런데 assessment에 `INTENT_UNKNOWN`이 있고, global `BINDING_UNKNOWN`과 `CALLER_UNKNOWN`도 적용돼 PARTIALLY_VERIFIED가 유지됐다. fallback IIFE와 body 구성이라는 좁은 CODE_BEHAVIOR를 판단하는 데 author intent나 package-entry caller가 필수인지 재검토가 필요하다. 이 사례가 이번 실험에서 가장 가까운 불필요 보류 후보지만 실제로 승격되지는 않았다.

원격 payload 실행 assessment와 child environment propagation assessment에는 `PAYLOAD_UNKNOWN`이 붙었다. payload 내부 행위를 주장하지 않는 정적 실행 시도·환경 전달 주장까지 payload 부족으로 보류하는 것은 범위가 넓다. 다만 payload 내부 효과를 판단할 때 PAYLOAD_UNKNOWN 자체는 타당하다.

세 번째 assessment는 ref ID를 `r3-sink-process`로 선언하고 flow에서는 `r3-sink`를 사용해 `Unknown flow reference`로 REJECTED됐다. 구조·참조 검증 유지가 적절하며 limitation 완화 대상이 아니다.

### DD-NPM-013 L1

DLL 관련 assessment는 `CODE_BEHAVIOR`로 좁혀 함수 내부 Windows 조건과 obfuscated `spawn("rundll32", ...)` 표현을 실제 줄로 인용했다. `CALLER_UNKNOWN`, `PAYLOAD_UNKNOWN`, `RUNTIME_UNCONFIRMED`를 모두 기록했고 caller가 없는 상태를 설치 도달성 성공으로 표현하지 않았다. 필요한 보류가 유지된 좋은 사례다.

다른 세 assessment도 CODE_BEHAVIOR지만 caller·binding limitation이 붙어 모두 보류됐다. 일부는 함수 내부 download/write 또는 platform read 표현만 판단하므로 caller가 그 좁은 주장에 필수인지 불분명하다. 모델이 scope를 좁히면서 limitation 적용 범위를 함께 좁히지는 못했다.

### DD-NPM-013 L3

입력에는 `install: node install.js`, install.js의 top-level `logDiskSpace()` 호출, Windows 조건과 rundll32 실행 시도가 존재한다. 그러나 DLL assessment는 `CODE_BEHAVIOR`이며 spawn을 주장하면서 refs가 154~155줄까지만 가리켜 실제 spawn 156~157줄을 인용하지 않았다. 또한 top-level caller 191줄도 이 assessment가 인용하지 않았다. 1~4줄 context와 package metadata만으로 “lifecycle association”을 서술했다.

따라서 L3에서 해소된 caller 맥락을 Agent가 핵심 assessment에 제대로 사용하지 못했다. Validator는 라인 범위와 ref 무결성은 통과시켰지만 인용 의미가 rationale을 뒷받침하는지는 검증하지 않아 구조 issue가 없었다. 현재는 CALLER_UNKNOWN과 global CODE_MISSING/CALLER_UNKNOWN으로 PARTIAL이라 잘못 VERIFIED되지는 않았지만, limitation 분류와 인용은 부정확하다.

별도의 maintenance assessment는 191줄 top-level 호출을 인용했지만 DLL 실행 주장과 분리돼 있다. 이 assessment의 flow도 logDiskSpace에서 unrelated logging sink로 연결해 DLL 정적 경로의 증거로 사용할 수 없다. DLL 내부 행위와 실제 Windows 실행 성공이 미확인이라는 제한은 타당하나, 정적 DLL 실행 시도 경로 자체는 제공 코드로 확인 가능하다.

### DD-NPM-003 L4

첫 assessment는 `CODE_BEHAVIOR`로 MNEMONIC 표현식이 `bot.sendMessage` 인자에 들어가는 줄을 인용했고 caller 미확인을 기록했다. PRIVATE_KEY는 rationale이나 flow의 실제 source로 사용하지 않아 기존 0.2 응답의 과장을 줄였다. export를 실제 호출 증거로 단정하지도 않았다.

그러나 “constructs a Telegram bot”과 “direct static source-to-messaging-sink link”를 주장하면서 지역 `TelegramBot` binding이 제공 코드에서 선언되지 않았다는 `BINDING_UNKNOWN`을 누락했다. `__exportStar(require("node-telegram-bot-api"), exports)`는 module export 재노출이지 지역 변수 선언이 아니다. 따라서 sendMessage의 API 의미와 실행 가능한 local binding은 미확인이다. 현재는 CALLER_UNKNOWN과 INTENT_UNKNOWN 때문에 PARTIAL이지만, 향후 그 제한이 사라지면 잘못 VERIFIED될 위험이 있다.

global CALLER_UNKNOWN은 Telegram assessment와 test assessment에는 관련되지만 multisig fixture의 “hex test fixture로 사용됨”이라는 좁은 CODE_BEHAVIOR 판단에는 직접 필요하지 않다. scope가 과도하다.

## 개선 여부와 위험 구분

### 불필요한 보류가 해소된 사례

실제 상태 기준으로는 없다. runtime-only limitation이 다른 핵심 limitation 없이 남은 assessment가 한 건도 없었다. 따라서 새 규칙이 작동할 기회가 없었다.

### 핵심 부족 보류가 유지된 사례

- DD-NPM-013 L1 DLL 표현: caller와 DLL 내용 부족 유지
- DD-NPM-013 L3 remote package/payload: payload 내용 부족 유지
- DD-NPM-003 L4 Telegram: caller 부족 유지
- DD-NPM-010 L2 payload 내부 및 package binding 관련 부족 유지

### 잘못 VERIFIED될 가능성이 있는 사례

이번 결과에는 VERIFIED가 없어 실제 과승격은 없다. 다만 DD-NPM-003 L4 Telegram assessment는 `BINDING_UNKNOWN` 누락, DD-NPM-013 L3 DLL assessment는 핵심 spawn/caller 인용 누락이 있어 후속 완화 전에 고쳐야 할 위험 후보다.

### 구조·참조 오류

DD-NPM-010 L2의 세 번째 assessment 1건이 assessment-local flow ref 오타로 REJECTED됐다. 변환 실패는 0건이다.

## 결론과 다음 작업

4조건에서는 Evidence가 0→0으로 유지됐고 새 Validator 완화의 관찰 효과도 0건이다. 이를 정확도 저하나 개선 실패로 단정할 수는 없다. 새 프롬프트가 assessment 수와 주장 분할을 바꾸었고 모델이 거의 모든 정적 주장에 runtime 외 limitation도 함께 붙였기 때문이다.

전체 22개로 즉시 확대하기보다 다음을 먼저 수행하는 편이 타당하다.

1. 프롬프트 fixture를 보강해 `CODE_BEHAVIOR`의 좁은 표현 주장에는 caller·intent·payload 부족을 해당 주장에 직접 필요한 경우만 붙이게 한다.
2. DD-NPM-013 L3처럼 제공된 caller를 Agent가 활용하지 않은 사례와 핵심 주장 줄을 인용하지 않은 사례를 회귀 fixture로 추가한다.
3. DD-NPM-003 L4의 지역 binding 부재를 `BINDING_UNKNOWN`으로 분류하도록 예시를 추가하되 표본별 예외는 만들지 않는다.
4. global missingContext가 sibling의 좁은 코드 표현까지 포함하지 않도록 affected assessment 선정 지침을 강화한다.
5. 그 후 runtime-only assessment가 실제로 생성되는 2~4조건 smoke를 다시 수행해 Validator 완화 효과를 분리한다.

현재 Validator의 “RUNTIME_UNCONFIRMED만 비차단, 나머지는 모두 보류” 규칙을 더 완화하기 전에 Agent 분류와 인용 품질을 먼저 고치는 것을 권장한다. 네 개발 조건만으로 전체 데이터셋 성능을 일반화하지 않는다.

## 추적 경로

- 새 run 요약: `experiments/agent-code-volume/2026-10-04-structured-limitations-live-v1/run.json`
- 조건 결과: 같은 디렉터리의 `results/`
- 요청·응답·Validator 상세: 같은 디렉터리의 private condition별 `validated-result.json`
- 새 입력: `experiments/agent-code-volume/2026-10-04-structured-limitations-input-v1`
- 기존 비교: `2026-10-04-luna-schema-fix-live-v1`, `2026-10-04-remaining-013-v1`, `2026-10-04-remaining-003-v1`

private 요청·응답과 frozen 입력은 수정하지 않았다.
