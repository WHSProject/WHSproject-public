# 코드 제공량 L0–L4 limitation 맥락 대조 (2026-10-04)

## 1. 목적과 해석 범위

이 보고서는 기존 코드 제공량 실험의 저장 입력·응답·Validator 결과를 그대로 읽어, limitation/missingContext가 코드 맥락 부족인지, 핵심 근거 부족인지, 제한된 정적 주장에는 불필요한 runtime 한계인지 사람이 검토할 초안이다. 모델 호출, Scanner 재실행, 패키지 실행, Validator replay는 하지 않았다. 저장 응답과 기존 산출물도 수정하지 않았다.

수동 분류는 현재 Validator의 자동 능력이 아니다. `VERIFIED` 승격이나 Evidence 생성 결과도 아니다. 5개 개발 표본을 전체 데이터셋의 정확도로 일반화하지 않는다.

### 자료와 완결성

- manifest: `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/manifest.json`
- 집계: `apps/scanner/experiments/agent-code-volume/2026-10-04-luna-schema-fix-full-live-v1/aggregation.json`
- 저장 결과: `2026-10-04-luna-schema-fix-live-v1`, `2026-10-04-remaining-{003,010,013,015,001}-v1`
- 기존 GT 검토: `apps/scanner/docs/agent-validator-gt-review-2026-10-04.md`
- 구조화 결과: `apps/scanner/experiments/agent-code-volume/2026-10-04-limitation-context-review-v1/comparison.json`

manifest/집계상 논리 조건은 25개, 실제 고유 응답은 22개다. DD-NPM-015 L3/L4는 L2, DD-NPM-001 L4는 L3의 SAME_INPUT이다. 비교표에는 표시하지만 assessment 및 limitation 원문 집계에는 중복하지 않았다. 고유 응답의 assessment는 61개다.

## 2. 주장 범위와 분류 방법

기존 응답에는 구조화된 claim scope가 없다. 따라서 signal, rationale, flow/reachability, refs와 실제 인용 코드를 함께 읽어 다음 범위로 수동 분해했다.

- **코드 표현·행위 존재:** API 호출, 환경변수 접근, 파일 쓰기 같은 구문 존재
- **정적 데이터 연결:** 같은 값이 source→transform→sink로 전달되는 정적 연결
- **정적 호출·설치 진입 경로:** manifest/lifecycle 또는 caller에서 대상 호출까지의 정적 경로
- **실제 실행·전송 성공:** 실제 환경에서 실행, write/spawn/network 성공 또는 서버 수신
- **payload 내부 행위:** 다운로드 payload나 DLL 내부 기능
- **정상·악성 의도:** 소유권·인가·목적을 포함한 의미 판단

한 assessment가 여러 층을 섞으면 분리해 해석했다. 분리할 수 없으면 `UNKNOWN`으로 남겼다.

부족 사항 분류는 다음과 같다.

| 코드 | 의미 |
|---|---|
| A `CONTEXT_RESOLVED` | 더 넓은 입력에서 실제 필요한 코드가 추가됨 |
| B `CORE_GAP_REMAINS` | 전체 제공 후에도 주장에 필요한 핵심 근거가 없음/외부/복원 불가 |
| C `RUNTIME_ONLY_FOR_STATIC_CLAIM` | 제한된 정적 주장에는 실행·수신·credential 유효성 확인이 불필요 |
| D `UNRELATED_TO_ASSESSMENT` | sibling assessment 또는 다른 행위에만 관련 |
| E `PROVIDED_BUT_NOT_USED` | 정보가 입력에 있는데 Agent가 없다고 하거나 올바르게 활용하지 않음 |
| F `UNKNOWN` | 주장 또는 관련성을 신뢰성 있게 구분할 수 없음 |

## 3. 원문 limitation 집계

| 원문 위치 | 항목 수 | 현재 status 영향 |
|---|---:|---|
| `output.limitations` | 93 | 개별 assessment status의 직접 조건 아님 |
| `output.missingContext` | 97 | 같은 응답의 모든 assessment를 partial로 만듦 |
| `assessment.limitations` | 163 | 해당 assessment를 partial로 만듦 |
| 합계 | 353 | 서로 다른 위치의 원문 항목 수 |

61개 assessment 모두 assessment limitation을 하나 이상 갖는다. 따라서 global missingContext만 제거해도 저장 응답은 자동으로 VERIFIED가 되지 않는다.

분석용으로는 혼합 문장을 나눠 대표 부족 20개를 수동 검토했다. 주 분류는 A 3, B 5, C 5, D 3, E 2, F 2다. 이 20은 353개 원문과 다른 분모이며, 전체 원문 분류율로 해석하면 안 된다. 원문은 각 `validated-result.json`에 보존되어 있고 구조화 JSON은 source pointer와 수동 분리 결과를 제공한다.

## 4. 표본별 L0→L4 핵심 변화

| 표본 | L0 | L1/L2 | L3/L4 | 해석 |
|---|---|---|---|---|
| DD-NPM-003 | `dist/index.js:123-127`; MNEMONIC 메시지 인자 표현은 보이나 함수 선언/export/caller/API binding 없음 | 표현은 유지되고 reachability가 UNKNOWN→POSSIBLE로 바뀌지만 binding/caller 증거는 없음 | L4 `1-129`; 함수 선언/export 확인. `__exportStar`는 지역 `TelegramBot` binding이 아니며 export는 call이 아님 | 코드량 증가로 함수 경계는 보였지만 핵심 binding/caller gap은 남음. 전송 성공은 제한된 표현 주장에는 C |
| DD-NPM-010 | postinstall 구현 전체에 가까운 코드. 환경정보 body와 remote download/write/spawn 존재. 두 번째 assessment는 교차 ref로 REJECTED | 같은 정적 연결을 assessment-local refs로 표현 | L3부터 lifecycle assessment 분리; L4까지 remote payload 내부는 없음 | egress body 주장에는 payload 내부가 D, network 성공은 C. L0 ref 오류는 limitation과 별도 |
| DD-NPM-013 | native binding fetch/maintenance 위주; DLL region 없음 | L1 `152-166`에 DLL spawn 함수 정의가 추가되지만 caller 없음. L2도 실제 caller 부족 | L3 `1-191`에 top-level `logDiskSpace()`와 valid trigger ref 추가; L4도 유지 | caller gap은 A. DLL 내부 악성 기능은 B, static spawn attempt의 실행 성공은 C |
| DD-NPM-015 | persistence와 token→registry/publish 연결을 주장 | L2에서 token delegation과 republish capability 분리 | L3/L4는 L2 SAME_INPUT | 실제 서비스/publish 성공은 C. 인증·publish가 인가된 정상 행위인지 악성 의도인지는 F |
| DD-NPM-001 | ORIGINAL parser 단일행을 여러 flow 역할로 인용; 복원 indicator 불일치 | 추가 slice에도 parser 복원 실패/한 줄 문제 유지 | L3에 `bin/sonia` caller는 추가되지만 parser 정확한 flow는 복원되지 않음; L4 SAME_INPUT | launcher gap은 A. parser source→archive→upload의 의미 입증은 B. 원본/복원본 혼동 금지 |

## 5. assessment 주장 대조

아래는 61개 assessment를 동일 행위 track별로 묶은 표다. ID가 달라도 signal/rationale와 refs가 같은 행위를 다루는지 확인했다.

| 표본·단계 | assessment 주장 | 주된 scope | limitation 관련성 초안 |
|---|---|---|---|
| 003 L0–L4 | mnemonic 환경 표현을 messaging call 인자에 결합 | 표현 + 정적 데이터 연결 + 의도 | 표현은 직접 확인. API binding/caller는 B, 전달 성공은 C, PRIVATE_KEY 전송은 코드와 불일치 |
| 003 L0–L4 | TEST_CLIENTS로 테스트 실행 선택 및 TON API 테스트 | 표현/정상 의도 | 테스트 파일 전체는 이 track에는 관련. mnemonic assessment에는 D |
| 003 L0–L4 | multisig BOC hex fixture | 표현/정상 의도 | 주변 assertion은 fixture 판단에 관련하지만 mnemonic assessment에는 D |
| 010 L0–L4 | remote JS download→temp write→detached spawn | 정적 데이터/실행 연결 + payload/의도 | download/write/spawn은 코드에 있음. payload 내부는 B, 성공은 C |
| 010 L0–L4 | host/env report→JSON body→request write | 정적 데이터 연결 + 의도 | 코드 연결은 확인. remote payload 내부는 D, server receipt는 C. L0는 flow ref 오류로 별도 REJECTED |
| 010 L3–L4 | package postinstall declaration→local script | 정적 설치 경로 | declaration과 파일 연결은 확인. 실제 npm execution은 주장 범위가 runtime이면 B, 정적 경로에는 C |
| 013 L0–L4 | registry/native package fetch→extract/write/install | 정적 데이터/실행 연결 + 정상 의도 | registry response/integrity는 다운로드 내용·안전성 주장에 관련. runtime success는 제한된 정적 시도에 C |
| 013 L0–L4 | platform/env inspection 및 cleanup | 표현 + 정상 의도 | helper callers는 일부 단계 부족; 별도 DLL assessment에는 D |
| 013 L1–L4 | Windows 조건에서 obfuscated rundll32 DLL spawn | 정적 설치 경로 + payload/의도 | L1 caller gap, L3 A. DLL 내부는 B, 실제 load success는 C. L3 flow source 역할은 부정확 |
| 015 L0–L2 | encoded remote payload를 service/persistence 경로에 연결 | 정적 설치/실행 경로 + payload/의도 | lifecycle/local link는 L2까지 확인. remote payload 동작/성공은 B/C로 분리 필요 |
| 015 L0–L2 | npm token을 registry discovery/publish에 사용 | 정적 데이터 연결 + 의도 | token 사용은 보이나 정상 인증/인가 publication과 exfiltration을 자동 구분할 수 없어 F |
| 015 L2 | package/README mutation과 npm publication | 정적 행위 + 의도 | publish attempt는 코드로 볼 수 있어도 unauthorized/malicious는 ownership context가 없어 F |
| 001 L0–L3 | shell profile 읽기/marker/write persistence | 정적 데이터/호출 경로 + 의도 | deobfuscated index 경로는 제공되나 mapping 제한 존재. 실제 lifecycle 실행은 C |
| 001 L0–L3 | recursive collection→archive→messaging upload | 정적 데이터 연결 + 의도 | parser 한 줄/복원 실패 때문에 정확한 연결은 B. 성공/수신은 C |
| 001 L0–L1 | obfuscation 및 mapped collection indicator | 표현/tool correlation | obfuscation 자체는 확인. mapped `index.js`와 ORIGINAL parser를 섞어 flow 증거로 쓰면 안 됨 |

## 6. 코드 보강으로 실제 해소된 사례

### DD-NPM-013 caller: A `CONTEXT_RESOLVED`

- L1 입력: `sample-003-l1-0004`, `install.js:152-166`
- 부족 원문: `Whether install.js invokes logDiskSpace...`
- L3 입력: `sample-003-l3-0001`, `install.js:1-191`
- 새 코드: `190 ensureDir(LOG_DIR)`, `191 logDiskSpace()`
- L3 Agent ref: `ref-trigger-install-call`, `188-191`

L3 assessment는 top-level caller를 실제로 인용하고 `TOP_LEVEL_INVOCATION_OBSERVED`를 남겼다. 따라서 install entry(`node install.js`)→top-level call→Windows condition→rundll32 시도라는 정적 경로의 caller 부족은 해소됐다. DLL 내부 행위와 실제 Windows 실행 성공은 별도다.

### DD-NPM-001 launcher: A `CONTEXT_RESOLVED`

L3에는 ORIGINAL `bin/sonia:1-11`이 추가되어 parser를 detached child로 시작하는 launcher가 보인다. 그러나 parser 자체는 ORIGINAL 한 줄이고 복원 실패 상태이므로 launcher가 생긴 것과 parser 내부 데이터 흐름 입증은 구분한다.

### DD-NPM-015 lifecycle/local linkage: A `CONTEXT_RESOLVED`

L2까지 manifest/local entry와 persistence/deploy 관련 code link가 제공된다. L3/L4는 SAME_INPUT이라 추가 해소가 아니다. 실제 서비스 시작, remote content 실행, publication 성공은 관찰되지 않았다.

## 7. 전체 제공 후에도 남은 핵심 부족

### DD-NPM-003 API binding과 caller

L4 ORIGINAL 전체 `dist/index.js:1-129`에서도 지역 `TelegramBot` 선언은 확인되지 않는다. export 재노출은 지역 binding이 아니며 함수 export도 caller가 아니다. MNEMONIC expression이 call argument에 들어가는 코드 표현은 존재하지만 API 의미와 도달 가능한 호출을 완결하려면 binding/caller가 필요하다. 다른 파일·전역 환경에도 없다고 단정하지는 않는다.

PRIVATE_KEY는 해당 행의 주석에만 있으므로 실제 수집·전송으로 기록하지 않는다.

### DD-NPM-013 DLL 내부 기능

L3/L4에서 DLL spawn 시도 경로는 보이지만 `node-gyp.dll` 내용과 provenance는 없다. 따라서 “DLL 실행 시도”는 정적으로 말할 수 있어도 DLL의 특정 악성 기능은 입증할 수 없다.

### DD-NPM-001 parser 복원과 line mapping

ORIGINAL `bin/parser.js:1`을 source/transform/sink로 반복 인용한 사실은 값의 연결을 의미적으로 입증하지 않는다. DEOBFUSCATED artifact와 mapping은 `index.js`용이며 parser 복원본이 아니다. L4도 L3 SAME_INPUT이므로 이 gap은 코드량 증가로 해결되지 않았다.

### DD-NPM-015 authorization/intent

코드가 npm token을 registry/authenticated publish에 사용하는 것과 credential을 제3자에게 유출하는 것은 다르다. package mutation/publish가 인가된 행위인지 악성 재게시인지는 소유권·authorization 자료 없이는 판단하기 어렵다. 개발 표본 라벨을 개별 주장 정답으로 사용하지 않았다.

## 8. 정적 주장에 불필요한 runtime 보류 후보

다음은 assessment가 제한된 정적 존재/연결만 주장한다고 해석할 때 C 후보다.

- 코드상 MNEMONIC expression이 messaging call argument에 들어간다는 주장에 token 유효성·server delivery 성공 요구
- 환경/host object가 JSON body로 직렬화되어 request에 쓰인다는 주장에 실제 endpoint 수신 요구
- Windows 조건의 rundll32 DLL spawn 시도 주장에 실제 Windows 실행·DLL load 성공 요구
- service/write/spawn 또는 npm publish 호출 시도 주장에 실제 서비스 시작·publication 성공 요구
- 정적 archive/upload 표현 주장에 endpoint 수신 성공 요구

단, assessment signal/rationale가 “sent”, “execution”, “exfiltration”처럼 실제 성공까지 읽힐 수 있어 claim scope가 혼합된 경우 자동 제외할 수 없다. 보고서의 C 분류는 제한된 정적 문구로 재해석했을 때의 수동 후보이지 자동 승격 판정이 아니다.

## 9. 입력에 있었으나 활용하지 않은 사례

### DD-NPM-010 imports

일부 missingContext는 `os`, `fs`, `path` 정의/import를 요구하지만 L0/L2의 postinstall slice 시작에는 해당 `require` 선언이 존재한다. 외부 모듈 구현 자체와 지역 binding 선언은 다르지만 “imports가 없다”는 표현은 과도하다. E 후보로 기록했다.

### DD-NPM-001 artifact identity

복원·mapping 정보가 제공됐지만 그것은 `index.js`용이다. parser assessment에서 이를 parser 복원 근거처럼 활용할 수 없다. 정보가 있다는 사실보다 artifact identity가 중요하다.

DD-NPM-003의 함수 export도 제공되지만 caller로 사용할 수 없고, `__exportStar`도 local constructor binding으로 사용할 수 없다. 이는 제공됐지만 주장에 필요한 종류의 정보가 아닌 경우다.

## 10. 다른 assessment에만 관련되는 missingContext

- DD-NPM-003 mnemonic assessment에 client test 전체와 multisig assertion 부족을 적용하는 것은 D 후보
- DD-NPM-010 fallback egress assessment에 remote payload 내부 내용을 적용하는 것은 D 후보
- DD-NPM-013 DLL assessment에 native-binding fallback/cleanup helper caller 부족을 적용하는 것은 D 후보

현재 global `output.missingContext`는 이 관련성을 표현하지 않고 모든 assessment에 적용된다. 반면 `output.limitations`는 status 직접 조건이 아니므로 보고서·runner 요약과 Validator 판정을 구분해야 한다.

## 11. 사람 결정이 필요한 UNKNOWN

- DD-NPM-015 token 사용이 정상 registry 인증인지 credential abuse인지
- DD-NPM-015 package mutation/publication이 인가된 유지보수인지 unauthorized republication인지
- 성공형 동사(`sent`, `execution`, `exfiltration`)를 쓴 assessment가 정적 시도를 주장한 것인지 runtime 성공까지 주장한 것인지
- DD-NPM-001 한 줄 parser의 문자열·API 표식이 실제 하나의 실행 가능한 source→sink 경로인지
- DD-NPM-003의 미해결 `TelegramBot`이 다른 실행 환경에서 주입될 수 있는지

## 12. 후속 작업 제안

| 영역 | 우선 작업 | 해결하는 문제 |
|---|---|---|
| Jev·슬라이싱 | caller만이 아니라 사용 식별자의 import/declaration/binding을 함께 가져오고 artifact identity를 유지 | 013 caller는 실제 개선됨; 003 binding, 001 parser artifact 혼동 방지 |
| 복원 | parser 단일행에 대한 신뢰 가능한 복원과 file별 line mapping 완결성 개선 | 001의 핵심 데이터 흐름 gap |
| Agent 프롬프트 | 코드 표현/정적 경로/runtime 성공/payload 내부/intent를 문장에서 분리하고 export≠call, re-export≠local binding을 명시 | 혼합 주장과 과장된 reachability 감소 |
| Agent 출력 검증 | assessment-local refs와 flow role 일관성을 출력 단계에서 점검 | 010 cross-assessment ref, 013 source=sink 역할 오류 |
| Validator 설계 | limitation/missingContext의 assessment 관련성과 claim scope를 구조화한 뒤 제한적으로 판단 | global missingContext 및 limitation 존재 여부만 보는 문제 |
| GT | 003의 MNEMONIC expression과 binding/caller 미확인을 분리하고 015 authorization 범위를 명시 | GT 라벨을 개별 행위 정답으로 오해하지 않게 함 |

## 13. 결론

코드를 더 주면 직접 도움이 된 사례는 DD-NPM-013의 caller, DD-NPM-001의 launcher, DD-NPM-015의 lifecycle/local linkage다. 다음 입력 개선 우선순위는 DD-NPM-003의 constructor binding/caller와 DD-NPM-001 parser의 신뢰 가능한 복원·mapping이다.

코드를 더 줘도 해결되지 않는 항목은 실제 실행/전송 성공, 서버 수신, credential 유효성, 외부 payload/DLL 내부, authorization/ownership이다. 이 중 runtime 성공은 제한된 정적 주장에는 Validator 기준 문제일 수 있지만, 실제 성공을 주장하면 핵심 부족이다. 외부 payload 내부와 intent/authorization은 Validator 완화로 해결할 문제가 아니다.

따라서 구현 순서는 (1) slicing/binding 및 복원 품질, (2) Agent 주장 범위 분리, (3) limitation scope를 표현할 최소 계약 설계, (4) 그 후 Validator의 제한적 기준 변경이 적절하다. 현재 자유문장만으로 keyword 삭제나 일괄 승격을 하는 것은 권고하지 않는다.
