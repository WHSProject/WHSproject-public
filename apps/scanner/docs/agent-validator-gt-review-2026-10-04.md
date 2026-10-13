# Agent Validator–GT 대조 검토 초안 (2026-10-04)

## 1. 목적과 범위

이 문서는 코드 제공량 실험에서 최종 Evidence가 0건이 된 원인을, 기존 파일럿 수동 Ground Truth(GT), 원본 코드, frozen 입력, 저장된 Agent 결과, 현재 Validator/Adapter 구현을 서로 대조해 사람이 검토할 수 있게 정리한 초안이다. 결론은 Validator 완화 또는 `PARTIALLY_VERIFIED` 전달 변경을 제안·구현하는 것이 아니라, **실제 주장에 필요한 근거 부족**과 **Validator 적용 범위/기준을 재검토할 후보**를 분리하는 데 있다.

이번 검토는 저장된 자료만 사용했다. API 호출, 새 스캔, 실험 재실행, 운영 코드 변경은 하지 않았다. 아래 8개 assessment는 원인 진단을 위해 의도적으로 고른 사례이며 전체 61개 assessment의 오류율을 추정하는 표본이 아니다.

### 사용 자료와 식별 정보

- Frozen 입력: `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/`
- DD-NPM-010 L0/L2 결과: `apps/scanner/experiments/agent-code-volume/2026-10-04-luna-schema-fix-live-v1/`
- 나머지 결과: `apps/scanner/experiments/agent-code-volume/2026-10-04-remaining-{003,010,013,015,001}-v1/`
- 집계: `apps/scanner/experiments/agent-code-volume/2026-10-04-luna-schema-fix-full-live-v1/aggregation.json`
- 전체 보고서: `apps/scanner/docs/agent-code-volume-schema-fix-2026-10-04.md`
- 집계가 가리키는 Scanner commit: `0ad642467272efac2730184e5169c43f06a90f42`
- 수동 GT: `apps/scanner/guarddog-pilot-selection/manual-ground-truth/DD-NPM-*.ground-truth.json`
- GT schema: `apps/scanner/guarddog-pilot-selection/manual-ground-truth/manual-ground-truth.schema.json`
- 원본 코드: 각 manifest `source.originalRoot` 아래의 `apps/scanner/guarddog-pilot-selection/artifacts/extracted/.../package/`

수동 GT 파일에는 명시적 `schemaVersion` 필드가 없다. 따라서 본문에서는 경로와 동봉 schema를 식별자로 사용하며, 이를 임의로 v0.x라고 부르지 않는다. GT의 `reviewer`와 `reviewedAt`도 현재 표본에서 `null`이므로 GT는 절대적 정답이 아니라 재검토 대상인 정적 수동 주석으로 취급한다. 특히 DD-NPM-001 GT는 수집·압축·전송 행위를 verified behavior로 열거하지 않는다.

### 선정한 8개 assessment

| # | 조건 | assessment ID | 선정 이유 |
|---:|---|---|---|
| 1 | DD-NPM-003 L0 | `assessment-credential-exfiltration-001` | 최소 코드에서 mnemonic→Telegram 정적 흐름이 이미 인용됨 |
| 2 | DD-NPM-003 L4 | `assessment-index-env-to-telegram` | 같은 행위를 전체 코드 단계에서 비교 |
| 3 | DD-NPM-010 L0 | `assessment-credential-and-system-data-egress` | 요구된 `Unknown flow reference` 사례; 별도 구조 오류 확인 |
| 4 | DD-NPM-010 L2 | `assessment-remote-collection-egress-001` | L0과 같은 fallback 환경/시스템 정보 POST 행위의 정상 참조 비교 |
| 5 | DD-NPM-013 L1 | `assessment-install-obfuscated-execution-001` | DLL spawn 코드는 있으나 호출부가 입력에 없는 단계 |
| 6 | DD-NPM-013 L3 | `assessment-dll-execution-install` | top-level 호출부가 추가된 동일 행위 |
| 7 | DD-NPM-013 L4 | `assessment-install-obfuscated-dll-execution` | 전체 ORIGINAL 코드에서도 같은 정적 행위/제한이 유지되는지 비교 |
| 8 | DD-NPM-001 L3 | `assessment-parser-collection-exfil-001` | L4와 동일 입력인 최종 고유 입력; ORIGINAL 단일행과 복원본 mapping을 구분할 필요가 큼 |

DD-NPM-015는 이번 8건에 포함하지 않았다. 003/010/013의 단계 비교와 001의 lineage 검토를 유지하면서 8건 제한을 지키기 위한 선택이며, 자료 부재를 뜻하지 않는다.

### 사람 검토가 완료된 세 사례 요약

| 사례 | 확정된 사실 | 해소된 부족 | 남은 부족 | 현재 판정에 대한 의견 |
|---|---|---|---|---|
| DD-NPM-010 L0 | fallback의 전체 환경정보가 직렬화되어 request body로 기록되는 코드가 있음. 두 번째 assessment가 자체 선언하지 않은 `r1-trigger`를 `flow.trigger` 등에 사용 | 없음 | assessment-local ref 오류; 실행·전송 성공 미확인 | `REJECTED` 타당. Validator 완화 대상 아님 |
| DD-NPM-013 L1→L3 | install script, top-level `logDiskSpace()` 호출, Windows 조건, DLL spawn 시도가 L3에서 한 정적 경로로 연결됨 | L1에 없던 함수 caller가 L3에 포함되고 Agent도 새 trigger를 인용 | Windows 조건, 앞선 예외 가능성, DLL 내부 행위, 실제 lifecycle/process/DLL 성공 | B 수준 근거는 강화됐지만 assessment 전체의 VERIFIED 여부는 별도 결정 |
| DD-NPM-003 L0/L4 | MNEMONIC 표현식이 메시지 인자에 들어감. PRIVATE_KEY는 주석뿐임 | L4에서 함수 선언과 export 확인 | 지역 `TelegramBot` 바인딩, 실제 caller, 전송 성공. export는 호출 증거가 아님 | 근거 부족과 기준 검토가 함께 있는 후보; PRIVATE_KEY 전송으로 표현 금지 |

## 2. 현재 Validator와 Adapter가 실제로 하는 일

근거 코드는 `apps/scanner/src/llm-agent/artifact/artifact-output.validator.ts`, 구형 경로는 `apps/scanner/src/llm-agent/agent-output-validator.service.ts`, 변환은 `apps/scanner/src/llm-agent/llm-evidence.adapter.ts`에 있다.

### 판정 순서

1. 아래 무결성 issue가 하나라도 있으면 `REJECTED`다.
   - assessment ID와 assessment 내부 ref ID 중복
   - slice/artifact/planning target이 없거나 서로 불일치
   - ref 범위가 slice 또는 source file 밖임
   - slice hash/source hash/content 불일치 또는 source 접근 실패
   - `flow.trigger/source/transforms/sink/conditions`가 **그 assessment의 refs**에 없는 ref ID를 가리킴
   - Finding/Atomic Evidence ID가 입력에 없음
   - v0.3 artifact 경로에서 인용 artifact와 Finding/Evidence의 바인딩 artifact가 불일치
2. issue는 없지만 Finding ID와 Atomic Evidence ID가 모두 비어 있으면 `PARTIALLY_VERIFIED`다.
3. 그 외에도 응답 전체 `output.missingContext`가 하나라도 있거나 **해당 assessment**의 `limitations`가 하나라도 있으면 `PARTIALLY_VERIFIED`다.
4. 위 조건이 모두 없을 때만 `VERIFIED`다.

`reachability.entry`와 `reachability.path`도 문자열로 ref처럼 사용되지만 현재 Validator의 assessment-local ref 검사 대상에는 포함되지 않는다. DD-NPM-010 L0에는 이 필드에도 잘못된 `r1-trigger`가 있으나, 저장된 `Unknown flow reference`는 검사 대상인 `flow.trigger`만으로 발생한다. 따라서 “현재 계약이 reachability ref까지 검증한다”고 해석하면 실제 코드와 다르다.

`output.limitations` 자체는 이 status 함수의 직접 조건이 아니다. 다만 runner summary의 limitation 목록에는 포함된다. 반대로 `output.missingContext`는 내용·관련성을 구분하지 않고 응답의 모든 assessment에 적용된다. assessment limitation은 그 assessment에만 적용된다. 따라서 한 행위의 missing context가 응답 전체 배열에 기록되면 다른 assessment도 함께 `PARTIALLY_VERIFIED`가 될 수 있다.

### 검사하는 것과 검사하지 않는 것

Validator가 검사하는 것은 ID 존재성, ref 소유권, 위치 범위, 저장 source와 slice의 동일성, artifact lineage 같은 **구조·참조 무결성**이다. 이 검사는 유지해야 한다. 그러나 다음은 검사하지 않는다.

- 인용된 코드가 rationale/signal의 악성 의미나 데이터 흐름을 실제로 입증하는지
- 같은 변수를 source에서 sink까지 의미적으로 추적했는지
- limitation/missingContext가 해당 assessment 주장에 핵심인지, 일반적 한계인지, 다른 행위의 한계인지
- GT와 Agent 주장의 의미 일치 여부
- runtime 성공 또는 악성 의도 자체

따라서 “Validator가 ref를 수용했다”를 “데이터 흐름 또는 악성 의미를 검증했다”로 표현해서는 안 된다.

Adapter는 `VERIFIED` assessment만 순회해 Evidence로 변환한다. `PARTIALLY_VERIFIED`와 `REJECTED`는 변환 전에 제외된다. 저장 집계는 `VERIFIED 0 / PARTIALLY_VERIFIED 60 / REJECTED 1`, 변환 failure 0, Evidence 0이다. 즉 이번 Evidence 0건의 직접 기계적 원인은 60건의 부분 검증 제외와 1건의 구조 오류 거부이지 Adapter 변환 실패가 아니다.

## 3. 대표 assessment 대조표

분류는 중첩 가능하다. `VALIDATOR_SCOPE_OR_CRITERIA_REVIEW`는 결함 확정이 아니라 사람이 주장 범위와 제한 관련성을 다시 볼 후보라는 뜻이다.

| # | GT 행위·원본 근거 | frozen 입력과 Agent 인용 | limitation / missingContext 해석 | 실제 결과·Adapter | 원인 후보 |
|---:|---|---|---|---|---|
| 1 | DD-NPM-003 GT002~004/GTR001. ORIGINAL `dist/index.js:126`에는 MNEMONIC 표현식을 메시지 인자로 넣는 코드가 있음. PRIVATE_KEY는 `125`의 주석에만 있음 | L0은 ORIGINAL `123-127`만 제공. source `126-127`, sink `125-126`은 A(표현식 존재)를 지지하지만 함수 정의, export, caller, `TelegramBot` 선언은 없음 | constructor 바인딩과 호출 맥락 부재는 B(정적 호출 경로)에 핵심이다. 전송 성공은 C(runtime)에 핵심. 다른 테스트 missingContext는 이 주장과 다른 범위 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님 | `INPUT_CONTEXT_GAP` + 제한된 A에는 `VALIDATOR_SCOPE_OR_CRITERIA_REVIEW`; B/C에는 `APPROPRIATE_VALIDATOR_HOLD` |
| 2 | #1과 동일. ORIGINAL `122-129`에는 함수 정의와 export가 있지만 이것은 caller 증거가 아님 | L4는 ORIGINAL `1-129` 전체. `86`은 모듈 export 재노출이고 지역 `TelegramBot` 선언이 아님. Agent는 `128-129` export를 trigger로 삼고 “LIKELY reachable”로 표현했으며 PRIVATE_KEY finding도 언급 | MNEMONIC 전달 표현(A)은 확인. `TelegramBot` 바인딩, 실제 caller(B), 전송 성공(C)은 미확인. PRIVATE_KEY 수집·전송은 입증되지 않음 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님. Agent limitation은 caller/전송 성공은 적었지만 constructor 바인딩 문제는 누락 | `INPUT_CONTEXT_GAP`, `AGENT_INTERPRETATION_OR_CITATION_ERROR`, 제한된 A에는 `VALIDATOR_SCOPE_OR_CRITERIA_REVIEW`; B/C에는 `APPROPRIATE_VALIDATOR_HOLD` |
| 3 | DD-NPM-010 GT008~010/GTR005. ORIGINAL `scripts/postinstall.js:84-92`가 `env: process.env`를 payload에 넣고 helper를 호출하며 `40-60`이 직렬화한 body를 request에 기록 | 두 번째 assessment refs는 `r2-source/transform/sink/condition`뿐이다. 그런데 `flow.trigger`, `reachability.entry`, `reachability.path`가 첫 번째 assessment의 `r1-trigger`를 사용 | 코드의 환경정보→request body 연결과 응답 참조 오류는 별개다. 원격 payload 부재는 fallback POST 주장과 다른 범위이고, network/lifecycle 성공 부재는 C 주장에는 핵심 | `REJECTED`, issue `Unknown flow reference`; 직접 거부 원인은 검사되는 `flow.trigger`. reachability의 같은 오류는 현재 Validator 미검사 | 별도 **구조·참조 오류** + `AGENT_INTERPRETATION_OR_CITATION_ERROR`; Validator 완화 대상 아님 |
| 4 | #3과 동일 | L2 `sample-002-l2-0001:15-19,28-65,67-92` 포함. assessment 자체 trigger/source/transform/sink/condition refs가 모두 존재하고 정적 fallback 전송 설명을 지지 | remote payload 내용은 이 assessment의 fallback POST에는 다른 행위·범위 제한. lifecycle/network 성공은 runtime 주장에는 핵심, 정적 구성·호출 주장에는 일반적 한계. configurable destination은 범위 설명 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님 | `VALIDATOR_SCOPE_OR_CRITERIA_REVIEW`; 성공/실행 주장에는 `APPROPRIATE_VALIDATOR_HOLD` |
| 5 | DD-NPM-013 GT003. ORIGINAL `install.js:154-157`에 Windows 조건, 난독화한 child_process/spawn, DLL main 호출 | L1 `sample-003-l1-0004:152-166`에는 sink가 있으나 top-level `logDiskSpace()` 호출 `190-191`은 없음. Agent도 호출 미제공을 명시 | 호출부 부재는 install-time/reachability 주장에 **핵심 근거 부족**. DLL 내용 부재는 DLL의 악성 기능/의도 판단에 핵심. runtime 성공은 일반적 한계 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님 | `INPUT_CONTEXT_GAP`, `APPROPRIATE_VALIDATOR_HOLD` |
| 6 | DD-NPM-013 GT001/GT003. ORIGINAL `package.json:16`, `install.js:154-157,190-191` | L3 `sample-003-l3-0001:154-191`에 Windows spawn과 top-level 호출이 함께 포함. 정적 install 파일 내 reachability 설명은 지지하지만, flow의 `source`가 temp discovery ref가 아니라 sink와 같은 DLL command ref를 가리켜 의미 역할은 부정확 | DLL 내용은 악성 payload 의미에는 핵심이나 “bundled DLL을 rundll32로 호출”이라는 정적 주장에는 필요하지 않음. 실제 lifecycle 실행/성공은 일반적 한계 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님. Validator는 ref 존재만 검사하므로 역할 부정확성을 issue로 만들지 않음 | 정적 행위에는 `VALIDATOR_SCOPE_OR_CRITERIA_REVIEW`; flow 표현에는 `AGENT_INTERPRETATION_OR_CITATION_ERROR`; 악성 의도/실행 성공에는 `APPROPRIATE_VALIDATOR_HOLD` |
| 7 | #6과 동일 | L4 `sample-003-l4-0001:154-191` ORIGINAL. trigger/source/transform/sink/condition이 모두 같은 slice에 있고 주장을 지지 | DLL 내용·실행 trace·실제 npm lifecycle 실행 부재가 일괄 차단. “suspicious” 의도 확정에는 자료 부족이나, 정적 spawn 행위와 lifecycle 파일 내 호출은 보임 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님 | `VALIDATOR_SCOPE_OR_CRITERIA_REVIEW` + 의도 판단은 `UNDETERMINED`/`APPROPRIATE_VALIDATOR_HOLD` |
| 8 | DD-NPM-001 GT는 postinstall, 난독화, process execution, bin entry까지만 확인. ORIGINAL `bin/sonia:3-10`은 parser detached spawn, `bin/parser.js:1`은 대형 난독화 단일행이며 문자열 수준에서 archive/form/HTTP 관련 표식은 확인되지만 GT가 수집→전송 흐름을 확정하지 않음 | L3은 ORIGINAL `bin/parser.js:1` 전체와 ORIGINAL `bin/sonia:1-11`을 포함. Agent가 source/transform/sink를 모두 동일한 단일행으로 인용. DEOBFUSCATED artifact는 `index.js`용이며 parser 복원본이 아님 | parser 복원 실패, 정확한 상수와 call sequence 불명은 수집→압축→전송 결합 주장에 핵심. network 성공은 일반적 한계. 원본 한 줄 존재와 의미 흐름 입증은 구분해야 함 | `PARTIALLY_VERIFIED`, issue 없음, 변환 대상 아님 | `AGENT_INTERPRETATION_OR_CITATION_ERROR` 가능성 + `APPROPRIATE_VALIDATOR_HOLD`; GT도 상세 흐름이 없어 최종은 `UNDETERMINED` |

## 4. 사례별 근거와 제한 해석

### DD-NPM-003 L0/L4 — 정적 데이터 전달과 남은 바인딩 문제

추적 경로:

- GT: `apps/scanner/guarddog-pilot-selection/manual-ground-truth/DD-NPM-003.ground-truth.json`
- 원본: `apps/scanner/guarddog-pilot-selection/artifacts/extracted/2025-02-25-@ton-wallet_create-v14.0.3/tmp/tmpstcvwg2f/@ton-wallet-create/package/dist/index.js`
- 입력: `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-001/L0-input.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-001/L4-input.json`
- 결과: `apps/scanner/experiments/agent-code-volume/2026-10-04-remaining-003-v1/private/sample-001/L0/validated-result.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-remaining-003-v1/private/sample-001/L4/validated-result.json`

확정할 수 있는 A 수준의 사실은 `process.env.MNEMONIC` 표현식이 `sendMessage`의 메시지 인자에 들어 있고 같은 함수에서 반환된다는 것이다. PRIVATE_KEY는 해당 코드의 주석에만 나타나므로 PRIVATE_KEY의 실제 수집·전송 근거로 쓰면 안 된다.

L0에는 ORIGINAL `dist/index.js:123-127`만 있어 함수 선언, export, caller, `TelegramBot` 바인딩을 확인할 수 없다. L4에는 `1-129` 전체가 있어 `122`의 함수 선언과 `129`의 export는 확인되지만 export는 실제 호출 증거가 아니다. 또한 `86`의 `__exportStar(require("node-telegram-bot-api"), exports)`는 모듈의 export를 재노출할 뿐 지역 식별자 `TelegramBot`을 선언하지 않는다. 제공된 L4 코드에서는 별도 선언을 찾지 못했다. 다른 파일이나 실행 환경의 전역 주입 가능성까지 배제할 자료는 없으므로 “모든 환경에서 반드시 실패한다”고 단정하지는 않는다.

L4 Agent는 `128-129`를 trigger로 인용하고 `EXPORTED_FUNCTION`, `LIKELY` reachability를 부여했다. 이는 함수가 export됐다는 사실을 실제 caller 증거처럼 넓혀 읽을 위험이 있다. rationale의 “findings also identify process.env.PRIVATE_KEY”는 normalized finding의 존재를 말할 수는 있지만, 코드가 PRIVATE_KEY를 수집·전송한다는 뜻으로 읽히면 원본과 맞지 않는다. Agent limitation은 caller와 전송 성공, PRIVATE_KEY mapping 불확실성은 적었지만 `TelegramBot` constructor 바인딩 문제는 적지 않았다.

따라서 이 사례는 단순한 “Validator 기준 과다”가 아니라 근거 부족과 범위 기준 검토가 함께 있는 후보로 수정한다. A(환경값을 메시지 인자에 넣는 표현)에는 직접 근거가 있다. B(호출 가능한 API 바인딩과 실제 caller)와 C(전송 성공)는 남아 있다. 다른 테스트 문맥이나 일반적인 runtime 성공 미확인이 A까지 일괄 차단해야 하는지는 별도 검토 대상이다.

### DD-NPM-010 L0/L2 — 구조 오류와 코드량 부족을 혼동하지 않을 사례

추적 경로:

- GT: `apps/scanner/guarddog-pilot-selection/manual-ground-truth/DD-NPM-010.ground-truth.json`
- 원본: `apps/scanner/guarddog-pilot-selection/artifacts/extracted/2026-05-27-@cloudplatform-single-spa_installations-v99.99.99/tmp/tmp8bnc8pkb/@cloudplatform-single-spa-installations/package/scripts/postinstall.js`
- 입력: `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-002/L0-input.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-002/L2-input.json`
- 결과: `apps/scanner/experiments/agent-code-volume/2026-10-04-luna-schema-fix-live-v1/private/sample-002/L0/validated-result.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-luna-schema-fix-live-v1/private/sample-002/L2/validated-result.json`

L0 두 번째 assessment가 선언한 refs는 `r2-source`, `r2-transform`, `r2-sink`, `r2-condition`뿐이다. 그런데 `flow.trigger`, `reachability.entry`, `reachability.path`는 첫 assessment의 `r1-trigger`를 사용한다. 현재 Validator는 `flow.*`를 assessment-local refs와 대조하므로 `flow.trigger`만으로 `Unknown flow reference`가 발생하며 거부는 타당하다. `reachability.entry/path`의 동일 오류는 현재 검사하지 않는다는 점은 별도 공백이다.

원본에는 fallback 객체의 `env: process.env`, callback helper 호출, helper 내부의 payload 직렬화와 request body 기록이 있어 환경정보를 요청 body로 넘기는 A 수준 코드 연결은 확인된다. 그러나 악성 의미 근거가 존재하는 것과 출력의 참조 무결성이 깨진 것은 별개다. 같은 코드 위치를 쓰더라도 각 assessment가 자체 refs를 선언해야 하며, 다른 assessment의 ref를 자동 복사·보정하거나 전역 ref로 허용해서는 안 된다. 참조를 고쳐도 limitation/missingContext로 부분 검증될 가능성은 별도로 남는다. L2 대응 assessment는 자체 ref만 써 구조 오류가 사라지지만 remote payload처럼 해당 fallback POST와 다른 missingContext도 전역 적용된다.

### DD-NPM-013 L1/L3/L4 — 실제 input gap이 해소된 뒤에도 남는 일괄 제한

추적 경로:

- GT: `apps/scanner/guarddog-pilot-selection/manual-ground-truth/DD-NPM-013.ground-truth.json`
- 원본: `apps/scanner/guarddog-pilot-selection/artifacts/extracted/2025-07-18-napi-postinstall-v0.3.1/tmp/tmpyb59lbal/napi-postinstall/package/install.js`
- 입력: `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-003/L1-input.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-003/L3-input.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-input-schema-fix-v2/private/sample-003/L4-input.json`
- 결과: `apps/scanner/experiments/agent-code-volume/2026-10-04-remaining-013-v1/private/sample-003/L1/validated-result.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-remaining-013-v1/private/sample-003/L3/validated-result.json`, `apps/scanner/experiments/agent-code-volume/2026-10-04-remaining-013-v1/private/sample-003/L4/validated-result.json`

package context에는 `install: node install.js`가 있다. L1에는 함수 정의 `152-166`, Windows 조건 `154`, 문자열 결합으로 구성된 process spawn 및 DLL main 호출 `156-157`이 있지만 `logDiskSpace()` caller는 없다. 여기서는 Agent가 “invocation ... is not present”라고 정확히 제한했고, install-time 정적 호출 경로(B)의 보류는 타당하다.

L3은 ORIGINAL `install.js:1-191`을 제공하며 `190`의 `ensureDir(LOG_DIR)`와 `191`의 top-level `logDiskSpace()` 호출을 포함한다. Agent는 `188-191`을 trigger로 새로 인용하고 `TOP_LEVEL_INVOCATION_OBSERVED`를 reason으로 남겼다. 따라서 L1의 특정 input gap은 L3에서 해소됐다. Agent도 더 이상 호출부가 없다고 주장하지 않는다.

L3가 `PARTIALLY_VERIFIED`인 직접 조건은 assessment limitations와 응답 전체 missingContext가 모두 비어 있지 않기 때문이다. 남은 내용은 DLL 내부/exports, runtime platform과 command success, 실제 npm lifecycle 실행 여부, 독립적인 난독화 해석 검증이다. Windows 조건과 앞선 top-level 코드의 예외 가능성도 실제 도달/성공에 영향을 줄 수 있다. 이들은 “설치 스크립트에 Windows 조건에서 DLL 실행을 시도하는 정적 경로가 있다”(B)와 “실제로 실행되어 특정 악성 행위를 했다”(C)를 구분해 적용해야 한다. 또한 L3 flow는 `source`와 `sink`를 모두 `ref-dll-command`로 두어 의미 역할이 부정확하지만 현 Validator는 ref 존재만 보므로 issue로 잡지 않는다. 입력 보강만으로 assessment 전체를 VERIFIED로 결정할 수는 없다.

### DD-NPM-001 L3 — original/deobfuscated 위치를 섞지 않을 사례

추적 경로:

- GT: `apps/scanner/guarddog-pilot-selection/manual-ground-truth/DD-NPM-001.ground-truth.json`
- 원본: `apps/scanner/guarddog-pilot-selection/artifacts/extracted/2026-03-07-aesdecryptor-v1.0.0/tmp/tmp4ryxtgru/aesdecryptor/package/bin/parser.js`, `bin/sonia`, `index.js`
- 입력: `.../2026-10-04-input-schema-fix-v2/private/sample-005/L3-input.json`
- 결과: `.../2026-10-04-remaining-001-v1/private/sample-005/L3/validated-result.json`

입력에는 ORIGINAL `bin/parser.js:1`과 `bin/sonia:1-11`이 있다. 별도의 DEOBFUSCATED artifact는 `index.js:1-105`이며 line mapping 105줄 중 단 1줄(derived 45→original 2)만 EXACT이고 `AGENT_INPUT_LINE_MAPPING_TRUNCATED` limitation이 있다. 선택 assessment는 parser ORIGINAL 한 줄을 source/transform/sink로 모두 인용했으므로 복원된 `index.js` 위치를 parser 원본 위치로 해석해서는 안 된다. 문자열/모듈 표식은 행위 가능성을 높이지만, 정확한 재귀 수집→archive→POST call sequence는 이 검토 자료만으로 확정하지 않는다. 수동 GT도 그 상세 흐름을 verified behavior로 제공하지 않아 사람의 원본 단일행 검토가 필요하다.

## 5. 제한 분류 요약

사람 검토에는 다음 주장 층을 사용한다. 이는 문서상 검토 기준일 뿐 새 schema나 운영 상태를 제안·구현한 것이 아니다.

- **A — 코드 표현·행위 구성의 존재:** 예를 들어 환경변수 표현식이 메시지 인자에 들어간다.
- **B — 정적 호출 경로·조건:** 예를 들어 install entry에서 top-level 호출과 Windows 조건을 거쳐 DLL spawn까지 연결된다.
- **C — runtime 실행·성공:** 실제 lifecycle/process/network가 실행되고 DLL 로딩 또는 전송이 성공했다.

A 근거만으로 B/C를 입증했다고 하지 않는다. C가 미확인이라는 이유만으로 A를 부정하지도 않는다. limitation의 중요도는 assessment가 실제로 A, B, C 중 어디까지 주장하는지에 따라 판단한다.

| 제한 내용 | 해당 주장에 대한 분류 | 적용 메모 |
|---|---|---|
| caller/top-level invocation 부재 | 핵심 근거 부족 | DD-NPM-013 L1의 B에는 핵심이며 L3에서 해소. DD-NPM-003의 B에는 계속 남음 |
| constructor/API 바인딩 부재 | 핵심 근거 부족 | DD-NPM-003에서 `TelegramBot` 호출 가능성을 판단하는 B에 핵심; 단순 runtime 성공 미확인과 구분 |
| remote payload/DLL 내용 부재 | 핵심 근거 부족 또는 다른 범위 | payload/DLL 내부 악성 기능 주장에는 핵심; 이미 보이는 download/spawn 자체에는 다른 범위 |
| 실제 npm lifecycle 실행 미확인 | 일반적 분석 한계; 실제 실행을 주장하면 핵심 | 정적 lifecycle declaration과 실제 관측 실행을 구분 |
| network/file write/process spawn 성공 미확인 | 일반적 분석 한계; 성공을 주장하면 핵심 | 코드상 호출과 성공 결과를 구분 |
| token/secret 유효성 미확인 | 다른 행위·범위 또는 일반적 한계 | 코드상 값 사용과 외부 유효성은 별개 |
| 같은 응답의 테스트 파일·다른 helper 문맥 누락 | 다른 행위·범위의 제한 | assessment 관련성 없이 global missingContext로 전파됨 |
| DD-NPM-001 parser 복원 실패·정확한 call sequence 불명 | 핵심 근거 부족 | 상세 결합 흐름 주장에는 중요 |
| `Unknown flow reference` | limitation이 아니라 구조·참조 오류 | 코드량 부족과 별도 집계해야 함 |

## 6. 사람이 확인해야 할 질문

1. Evidence assertion을 “코드에 존재하는 정적 source→sink/호출”로 한정할 때, runtime invocation·network 성공·credential 유효성 부재만으로 `PARTIALLY_VERIFIED`여야 하는가?
2. `output.missingContext`를 모든 assessment에 일괄 적용해야 하는가, 아니면 assessment별 관련성 또는 명시적 연결이 필요한가?
3. assessment limitation이 하나라도 있으면 무조건 부분 검증하는 현재 기준을 유지할 것인가? 유지한다면 모델이 일반적인 “실행하지 않음” 문구를 항상 쓰는 출력 계약과 VERIFIED 가능성이 양립하는가?
4. DD-NPM-003 L0/L4의 정적 mnemonic→messaging 흐름에 필요한 최소 assertion 범위는 무엇인가? 함수 호출 여부까지 요구한다면 L4의 export만으로 충분한가?
   - `TelegramBot` 지역 바인딩이 확인되지 않은 상태에서 A를 어떤 문구로 제한할지 함께 결정해야 한다.
5. DD-NPM-013 L3/L4에서 `logDiskSpace()`의 top-level 호출과 Windows DLL spawn을 정적 행위로 Evidence화할 수 있는가, 아니면 DLL 내용/실제 lifecycle 실행까지 필수인가?
6. DD-NPM-001 parser의 단일행을 사람이 다시 추적했을 때, Agent가 말한 recursive collection→archive→HTTP POST 연결이 실제 동일 실행 경로인가? 기존 GT에 없는 이 상세 행위를 GT 보강 대상으로 삼을 것인가?
7. 정적 benign/negative assessment도 limitation 때문에 전부 제외하는 현재 정책이 의도된 것인가?

## 7. 유지해야 할 검증과 개선 검토 후보

### 유지해야 할 검증

- assessment-local flow ref 소유권, duplicate ID, unknown slice/artifact 검사. DD-NPM-010처럼 다른 assessment ref를 자동 복사·보정하거나 전역 참조로 허용하지 않는다.
- ref 범위와 source/slice hash·content 일치 검사
- Finding/Atomic Evidence 존재성과 artifact lineage 검사
- ORIGINAL/DEOBFUSCATED representation 및 line mapping 보존
- 코드에 없는 호출·데이터 흐름 주장의 보류. 다만 참조 무결성 통과만으로 의미 흐름이나 악성성을 입증했다고 표현하지 않는다.
- API/constructor 바인딩과 핵심 호출 연결 부족을 runtime 성공 미확인과 구분
- 변환 실패 격리와 conversion failure 별도 집계

DD-NPM-010 L0는 assessment-local flow 참조 검사가 실제 오류를 잡은 명확한 사례다.

### 개선 검토 후보(확정 결함 아님)

- 응답 전체 `missingContext`를 assessment 전부에 적용하기 전에 관련 범위를 표현하거나 연결하는 계약
- limitation의 존재 여부가 아니라 주장과의 관련성/중요도를 구분할 수 있는 구조화
- A 코드 표현, B 정적 호출 경로, C runtime 실행·성공, malicious intent를 서로 다른 검토 층으로 분리
- `reachability.entry/path`가 ref ID 의미를 갖는다면 assessment-local refs와 검증할지 계약을 명확히 함. 현재 코드는 `flow.*`만 검사한다.
- 구조 무결성 통과와 의미 입증을 별도 상태/지표로 표현
- `PARTIALLY_VERIFIED`를 Evidence로 전달할지는 이 문서 범위를 벗어나며 별도 정책·contract 검토로 남김

자연어 limitation과 missingContext만으로 해당 주장의 관련성을 현재 코드가 신뢰성 있게 판별할 수는 없다. 키워드 몇 개를 삭제하거나 특정 상용구를 무시해 자동으로 VERIFIED로 승격하는 방식은 개선안으로 삼지 않는다.

### 후속 작업 우선순위

| 우선순위 | 영역 | 최소 후속 작업 | 이번 문서에서 확인된 이유 |
|---:|---|---|---|
| 1 | Agent 출력 | 각 assessment가 자기 refs만 사용하도록 생성·lint 기준을 검토하고, export를 caller 증거로 과장하지 않으며 normalized finding과 직접 코드 관찰을 구분 | DD-NPM-010 교차 ref, DD-NPM-003 export/PRIVATE_KEY, DD-NPM-013 L3 flow 역할 문제 |
| 2 | 슬라이싱/입력 | caller뿐 아니라 사용 식별자의 import/declaration/binding을 함께 제공하는 우선순위를 검토 | DD-NPM-013은 caller 추가로 B가 개선됐고, DD-NPM-003은 전체 파일에도 `TelegramBot` 지역 바인딩이 없음 |
| 3 | Validator/계약 검토 | limitation/missingContext의 assessment 관련성과 주장 층(A/B/C)을 표현할 수 있는지 설계 검토; reachability ref 의미도 명확화 | 현재 자연어 배열의 존재 여부만으로 일괄 부분 검증하며 의미 관련성을 판별하지 않음 |
| 4 | GT 유지보수 | DD-NPM-003 GT를 MNEMONIC 표현, constructor 바인딩 미확인, caller 미확인으로 세분화할지 검토 | 기존 GT의 `CREDENTIAL_EXFILTRATION` 표현은 정적 표현과 실제 실행을 사람이 혼동할 여지가 있음 |

이 순서는 구현 승인이 아니라 다음 오프라인 설계·검토 순서다. Validator 완화나 `PARTIALLY_VERIFIED` Evidence 전달 변경은 포함하지 않는다.

## 8. 잠정 결론

8건 중 사람이 확인한 세 사례는 다음처럼 정리된다. DD-NPM-010 L0는 악성 의미를 지지하는 코드와 별개로 명확한 assessment-local flow 참조 오류가 있어 Validator 완화 대상이 아니다. DD-NPM-013은 L1의 caller gap이 L3에서 실제로 해소되어 B 수준 정적 경로가 강화됐지만 DLL 내부 행위와 C는 남아 있다. DD-NPM-003은 A 수준 MNEMONIC 전달 표현은 분명하나 `TelegramBot` 바인딩과 caller가 없고, PRIVATE_KEY 전송은 입증되지 않아 기존의 단순한 “기준 과다 후보”보다 혼합 원인으로 보아야 한다.

DD-NPM-003의 수동 GT가 정적 코드 표현을 `CREDENTIAL_EXFILTRATION`으로 명명한 것과 실제 입력에서 constructor 바인딩/caller가 확인되지 않는 점은 GT 보강 후보로 기록한다. GT 원본은 이번 작업에서 변경하지 않았다.

이 구분만으로 Validator 결함이나 VERIFIED 승격을 확정할 수는 없다. 최종 판단은 각 Evidence가 표현하려는 assertion 범위를 먼저 합의한 뒤 원본 코드와 함께 사람이 내려야 한다.
