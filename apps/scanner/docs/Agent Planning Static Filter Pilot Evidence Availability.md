# Agent Planning 1차 정적 필터 파일럿 근거 가용성 실험

## 목적과 범위

이 실험은 탐지 정확도나 오탐률을 입증하지 않는다. Scanner에 남아 있던 개발용
파일럿에서 M01~M08의 필수 Raw rule 조합, Finding 코드 맥락, 관계 후보와
`LINKED` 검증 가능성을 확인한다. 표본 라벨은 행위 연결의 근거로 사용하지 않았다.

생산 필터, Gate, Tier 2 구현은 변경하지 않았다. 실험 harness가 Metadata,
Custom Rule, GuardDog, Tier 2, Normalizer, `buildAgentPlanningInput()`,
`evaluateStaticFilter()`를 직접 호출했다. Tier 3, Legacy Agent, Policy, History는
호출 경로에 포함하지 않았다.

## v0.4.0 Threat 분기 재실험 (2026-10-02)

pilot-v7과 동일한 15개 artifact를 최신 0.4.0 빌드로 재분석했다. 산출물은
`experiments/agent-planning-static-filter/2026-10-02-pilot-v8`이며 표본별 변화는
`comparison-v0.3.0-to-v0.4.0.json`에 있다.

| 상태 | v0.3.0 | v0.4.0 |
| --- | ---: | ---: |
| `STATIC_MALICIOUS` | 3 | 3 |
| `NO_ESCALATION_SIGNAL` | 0 | 3 |
| `STATIC_INCOMPLETE` | 12 | 9 |
| `AMBIGUOUS` | 0 | 0 |

Raw Finding threat는 12/15에 존재하고 3/15에 없었다. 향후 라우팅 관점의 후보 수는
M 기준 충족 생략 3, threat 부재 생략 3, `STATIC_INCOMPLETE`/`AMBIGUOUS` 2차 전달
9다. 현재 결과는 비활성 계산이므로 실제 호출이나 비용은 변하지 않는다.

threat 부재 3개는 모두 악성 개발 표본이므로 놓치는 악성 생략 후보로 기록한다.

| 표본 | v0.3.0 → v0.4.0 | 보존된 진단 |
| --- | --- | --- |
| DD-NPM-006 | `STATIC_INCOMPLETE` → `NO_ESCALATION_SIGNAL` | I08 |
| DD-NPM-007 | `STATIC_INCOMPLETE` → `NO_ESCALATION_SIGNAL` | I01, I04, I08 |
| DD-NPM-013 | `STATIC_INCOMPLETE` → `NO_ESCALATION_SIGNAL` | A05, A09, I08 |

DD-NPM-008과 DD-NPM-009에는 미분류 `threat-npm-http-dependency` Raw Finding이 각각
2개 있어 threat 존재로 판별됐다. 두 표본은 A 규칙 없이도
`UNCLASSIFIED_THREAT_REVIEW_REQUIRED`와 I08을 보존하며 `STATIC_INCOMPLETE`다.

`NO_ESCALATION_SIGNAL` 3개 모두 I 진단을 보존하고, 그중 DD-NPM-013 한 개는 A 진단도
보존한다. 이는 A/I 존재가 아니라 최종 status를 미래 라우팅 기준으로 사용해야 함을
보여준다. threat가 있고 I가 없는 입력은 현재 I08이 항상 적용되므로 이번 생산 표본에
없어 `AMBIGUOUS`는 0건이다.

15/15 결과가 생성됐고 LLM·패키지·lifecycle 실행은 모두 0건이었다. 실행 환경은
Node v26.4.0(요구 `>=24 <25`와 불일치), GuardDog 3.1.0, Semgrep 1.172.0이다.
DD-NPM-011의 기록 duration이 5,150,461ms로 비정상적으로 커 총합 시간은 성능 비교에
사용하지 않는다. 결과 생성 실패나 analyzer timeout으로 기록되지는 않았다.

## v0.3.0 SAME_FILE 휴리스틱 재실험 (2026-10-02)

pilot-v5와 동일한 manifest, 15개 artifact 및 hash를 최신 0.3.0 빌드로 다시 분석했다.
산출물은 `experiments/agent-planning-static-filter/2026-10-02-pilot-v7`이며
`comparison-v0.2.0-to-v0.3.0.json`에 표본별 차이를 저장했다.

| 결과 | v0.2.0 | v0.3.0 |
| --- | ---: | ---: |
| `STATIC_MALICIOUS` | 0/15 | 3/15 |
| `STATIC_INCOMPLETE` | 15/15 | 12/15 |
| M04 확정 | 0 | 2 |
| M05 확정 | 0 | 1 |
| `SAME_FILE_COMBINATION` 확정 | 0 | 3 |
| `DIRECT_COMMAND_MATCH` 확정 | 0 | 0 |
| I08 | 15/15 | 15/15 |

새 확정은 DD-NPM-003(M05), DD-NPM-010(M04), DD-NPM-015(M04)다. 세 진단 모두
`linked.required=false`, `linked.status=NOT_REQUIRED`이며 데이터 흐름 검증으로 기록하지
않았다. M02는 1개 조합이 있었으나 중요 경로 파괴 의미가 확인되지 않았고, M03은
복원 VALID/SAME_FILE 문제로 차단됐다. M06/M08은 독립 확정 비활성 상태를 유지했다.

원본 코드 대조 결과는 다음과 같다.

| 표본 | 자동 근거 | 원본 대조 분류 및 근거 |
| --- | --- | --- |
| DD-NPM-003 | `dist/index.js`, messenger + `MNEMONIC` 수집 | **실제 악성 행위와 관련 있는 조합**. `dist/index.js:122-127`에서 mnemonic을 `bot.sendMessage()` 내용으로 전달한다. 자동 결과는 이 흐름을 LINKED로 주장하지 않는다. |
| DD-NPM-010 | `scripts/postinstall.js`, `DEP_CONFUSION_SECRET` + outbound | **실제 악성 행위와 관련 있는 조합**. `15-19`에서 설정/secret을 읽고 `78-92` fallback에서 외부 callback으로 전체 환경을 보낸다. 다운로드·실행 행위도 있으나 M04 근거로 합치지 않았다. |
| DD-NPM-015 | `scripts/deploy.js`, `NPM_TOKENS` + HTTPS capability | **휴리스틱 의미가 원본 대조에서 경계인 조합**. `77-81`에서 token을 읽지만 `9-26`, `49-67`에서는 npm registry 인증과 publish에 사용한다. 더 넓은 전파 행위는 의심스럽지만 M04의 “정상 서비스 인증 제외” 관점에서는 과확정 후보다. 현재 Finding snippet에는 이 사용 맥락이 함께 남지 않아 자동 필터가 제외하지 못했다. |

따라서 3건은 LLM 생략 후보이지 안전한 생략 또는 Policy 차단 근거로 검증된 수가
아니다. 특히 DD-NPM-015는 SAME_FILE 휴리스틱이 관련 사용 맥락을 잃을 때 발생하는
한계를 보여준다. 정상 대조군이 없는 악성 개발 표본이므로 정확도·오탐률을 계산하지
않는다.

v0.3.0에서도 A 분포는 A01 1, A02 1, A03 2, A04 4, A05 6, A06 4, A07 3,
A09 6으로 유지됐다. I 분포도 I01 3, I04 3, I08 15로 동일하다. M이 충족된 3개에도
I08과 다른 A/I 진단을 보존했으며 상태 우선순위만 `STATIC_MALICIOUS`로 결정했다.

실행은 Node v26.4.0(프로젝트 요구 `>=24 <25`와 불일치), GuardDog 3.1.0,
Semgrep 1.172.0에서 수행했다. 15/15 결과가 생성됐고 총 정적 처리 시간은
303,177ms였다. LLM·패키지·lifecycle 실행은 모두 0건이었다.

## v0.2.0 직접 결합 재실험 (2026-10-02)

필터 v0.2.0은 완전한 데이터 흐름 대신 Finding에 보존된 매칭 코드에서 하나의 실제
호출 인자를 확인하는 제한된 직접 결합을 추가했다. 동일 15개와 동일 artifact hash를
새로 정적 분석했으며 최종 산출물은
`experiments/agent-planning-static-filter/2026-10-02-pilot-v5`에 있다. v0.1.0
baseline과의 기계 판독 비교는 `comparison-v0.1.0-to-v0.2.0.json`에 저장했다.

| 항목 | v0.1.0 | v0.2.0 |
| --- | ---: | ---: |
| 완료 / 선택 표본 | 15 / 15 | 15 / 15 |
| `STATIC_MALICIOUS` | 0 | 0 |
| `STATIC_INCOMPLETE` | 15 | 15 |
| 직접 결합 `CONFIRMED` | 0 | 0 |
| M 규칙 최종 확정 | 0 | 0 |
| I08 적용 | 15 | 15 |
| LLM / 패키지 / lifecycle 실행 | 0 / 0 / 0 | 0 / 0 / 0 |

v0.2.0의 규칙별 결과는 다음과 같다. 분모는 결과가 생성된 15개다.

| 규칙 | 필수 hit 조합 | VALID 확인 | 직접 결합 확인 | 확정 | 주요 차단 조건 |
| --- | ---: | ---: | ---: | ---: | --- |
| M01 | 0 | 0 | 0 | 0 | 필수 hit 없음 |
| M02 | 1 | 1 | 0 | 0 | 동일 process 인자의 중요 경로 파괴 명령 미확인 |
| M03 | 1 | 0 | 0 | 0 | 복원 근거 VALID 및 inline 민감 파일 내용 전송 미확인 |
| M04 | 2 | 1 | 0 | 0 | 외부 요청 data 인자의 credential/full-env 직접 포함 미확인 |
| M05 | 1 | 1 | 0 | 0 | 전송 API 출처와 message/query 인자의 직접 결합을 함께 보존한 snippet 없음 |
| M06 | 2 | 0 | 해당 없음 | 0 | 독립 확정 비활성 |
| M07 | 6 | 0 | 0 | 0 | 선행 M01~M05 확정 및 lifecycle 직접 범위 미확인 |
| M08 | 0 | 0 | 해당 없음 | 0 | 독립 확정 비활성, 필수 hit 없음 |

DD-NPM-003은 원본 `dist/index.js:122-127`에서 `process.env.MNEMONIC`이
`bot.sendMessage()` 두 번째 인자에 직접 들어간다. 그러나 필터 입력의 env Finding
snippet에는 `new TelegramBot(...)`과 호출만 있고 `TelegramBot`의
`node-telegram-bot-api` import/require 출처는 없다. messenger Finding snippet은
hardcoded token 중심으로 잘려 있다. API 이름만으로 외부 전송 API를 단정하지 않는
기준 때문에 M05는 `UNVERIFIED`가 맞다. 원본 수동 대조는 결과를 승격하지 않았다.

이번 변경으로 직접 결합 양성 구문은 단위 fixture에서 검증했지만 15개 생산 입력에는
모든 조건을 함께 보존한 사례가 없었다. 이는 조건을 더 완화할 근거가 아니다. 다음
최소 보완은 GuardDog가 이미 매칭한 호출의 API/module provenance, 인자 위치, 잘림
여부를 구조화해 Finding에 보존하는 것이다. 그 다음 단순 직접 표현식부터 필터가
소비할 수 있다. 변수·alias·함수 간 흐름은 별도 분석 없이는 계속 미확인이다.

v0.2.0 실행 환경은 Node v26.4.0(프로젝트 요구 `>=24 <25`와 불일치), GuardDog
3.1.0, Semgrep 1.172.0이며 총 정적 처리 시간은 314,463ms였다. Analyzer 상태와
관계 후보 집계는 baseline과 같았고, I08도 15/15 유지됐다. 따라서 이 실험은
오탐률·전체 정확도·안전한 LLM 생략이나 실제 비용 절감을 입증하지 않는다.

## 표본과 provenance

원본 manifest는 `guarddog-pilot-selection/guarddog-pilot-samples.json`이다. 20개
항목 중 원본 ZIP과 압축 해제본이 모두 있는 `CONFIRMED_MALICIOUS` 개발용 표본은
15개(DD-NPM-001~015)였다. DD-NPM-016~020은 이전 버전 pair 후보만 있고 artifact가
확보되지 않아 실행하지 않았다. 표본을 추가하거나 다운로드하지 않았다.

기존 `guarddog-results/raw` 결과는 GuardDog 3.1.0 원시 결과만 보존하고 현재
Custom Rule 관계 후보, Tier 2 복원, NormalizationResult, Planning 입력과 필터
결과가 없어서 재사용하지 않았다. 전체 15개는 신규 정적 분석으로 명시했다.

실행 산출물은 `experiments/agent-planning-static-filter/2026-10-01-pilot-v2`에 있다.
각 `samples/<sample-id>.json`은 package identity, archive SHA-256, Analyzer 상태·오류·
시간, Planning 입력, 전체 StaticFilterResult, 관계 참조 무결성을 함께 저장한다.

## 실행 안전성과 버전

| 항목 | 값 |
| --- | --- |
| 실행 Node | v26.4.0 (프로젝트 요구 `>=24 <25`와 불일치) |
| Scanner commit / branch | `e766f2e2724e119e9989b7e382b74b98a9ddbe3e` / `feat/435--agent-planning-filter1` |
| 정적 분석 이미지 | `sha256:6c9b0e051011000600036ecacd0209081f58754eec65b13255d87cf2881e9640` |
| GuardDog / Semgrep | 3.1.0 / 1.172.0 |
| Custom Rule hash | `969bb8f9a053a2ec6c1bbb46805cfe0deadbf1aeccc68a129de35a4b9c6138f1` |
| Planning / 필터 버전 | 0.1.0 / 0.1.0 |

GuardDog와 Semgrep은 Docker `--network none`, read-only package mount, read-only root
filesystem, non-root user로 preflight를 통과했다. Tier 2 GPT mode는 `off`였고 LLM
assistant는 호출 시 throw하도록 주입했다. 관측된 LLM 호출은 0건이다. 표본 설치,
dependency 설치, lifecycle 실행, import/require, entry point 실행도 하지 않았다.
Tier 2 복원은 소스 문자열을 정적으로 처리했으며 표본 코드를 실행하지 않았다.
분석 전후 복사된 package tree digest는 모든 완료 표본에서 같았다.

먼저 DD-NPM-002와 DD-NPM-010으로 smoke를 완료한 뒤 15개 전체를 실행했다. 첫 전체
실행에서 DD-NPM-004의 UTF-8 BOM을 harness JSON parser가 처리하지 못한 사실을
실패로 기록했고, 원본을 변경하지 않은 채 BOM-aware parse로 보완하여 새 v2
디렉터리에서 전량 재실행했다.

## 실행 결과

- 확보 15개 / 실행 15개 / 결과 생성 15개 / 재사용 0개
- 최종 상태: `STATIC_INCOMPLETE` 15/15
- Analyzer: Metadata, Custom Rule, GuardDog 모두 15/15 `SUCCESS`
- Tier 2: `SUCCESS` 12/15, `PARTIAL` 3/15 (DD-NPM-001, 007, 012)
- 총 정적 처리 시간 302,680ms. DD-NPM-011이 273,449ms로 대부분을 차지했다.
- I08 `SCAN_COVERAGE_UNKNOWN`: 15/15
- I01: 3/15, I04: 3/15
- 관계 후보: 54개, 같은 Snapshot의 Finding ID에 모두 대응한 후보 40개,
  실제 데이터·실행·호출 연결을 입증한 후보 0개

I08이 전량 적용되므로 이번 집계의 최종 상태만으로 M 근거 가용성을 판단하면 안
된다. 다음 표는 전체 완료 표본 15개를 분모로 필수 조합과 추가 조건을 분리한다.

| 규칙 | 필수 조합 | VALID | SAME_FILE | LINKED 확인 | 최종 확정 | 주요 차단 조건 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| M01 | 0 | 0 | 해당 없음 | 0 | 0 | 필수 hit 없음 |
| M02 | 1 | 1 | 1 | 0 | 0 | 중요 경로 및 삭제→실행 입력 의미 미확인 |
| M03 | 1 | 0 | 0 | 0 | 0 | 복원 Finding VALID, 민감 내용→요청 데이터 미확인 |
| M04 | 2 | 1 | 해당 없음 | 0 | 0 | credential/full env 및 외부 유출 맥락 미확인 |
| M05 | 2 | 2 | 해당 없음 | 0 | 0 | 민감 정보 수집과 전송 내용 연결 미확인 |
| M06 | 2 | 1 | 해당 없음 | 0 | 0 | 다운로드→실행 및 같은 payload의 M01~M05 미확인 |
| M07 | 0 | 0 | 해당 없음 | 0 | 0 | 선행 M 확정 없음 |
| M08 | 0 | 0 | 해당 없음 | 0 | 0 | 필수 hit 없음 |

필수 조합 표본은 M02 DD-NPM-014, M03 DD-NPM-015, M04 DD-NPM-010/015,
M05 DD-NPM-001/003, M06 DD-NPM-014/015다. `STATIC_MALICIOUS`는 0/15이고,
현재 coverage 계약에서는 `NO_ESCALATION_SIGNAL`도 0/15다.

모호함은 A01 1, A02 1, A03 2, A04 4, A05 6, A06 4, A07 3, A09 6건이다.
미분류 threat rule은 `threat-process-spawn-silent` 8, `threat-runtime-system-info`
8, `threat-network-outbound-shady-links` 7, `threat-npm-http-dependency` 4회였다.
이는 Finding 출현 횟수이며 패키지 수나 독립 행위 수가 아니다.

## LINKED 미확인 원인

현재 필터는 Planning 입력에 verified execution/data-flow assertion이 없으면 LINKED를
확인하지 않는다. 실험에서 54개 relationCandidates 중 40개는 참조 ID가 실제
Finding에 대응했지만, candidate의 `CANDIDATE` 상태와 참조 무결성만으로 데이터
흐름을 입증하지 않았다. 나머지 14개는 derived Custom Rule 후보의 ID가
`custom-rule:*`인 반면 Snapshot Finding은 `custom-rule-deobfuscated:*`여서 참조가
불일치했다. ID를 보정하지 않았다.

따라서 관찰된 LINKED 0건은 두 원인이 함께 있다.

1. 생산 입력에 검증 완료된 연결 assertion이 없다. 참조가 온전한 40개도 filter가
   소비할 수 있는 확정 근거가 아니다.
2. derived 후보 14개는 참조 무결성부터 깨져 있다.

이는 단순히 필터의 boolean 검증 함수만 빠진 문제가 아니다. Custom Rule이 이미
내부적으로 만드는 `DATA_FLOW`/`EXECUTION_PATH` 후보의 의미와 제한을 검증하고,
검증 결과를 provenance와 함께 표현하는 계약이 먼저 필요하다.

## 대표 코드 대조(최대 5개)

| 표본 | 선택 이유 | 코드 대조 | 현재 입력으로 가능한 판단 |
| --- | --- | --- | --- |
| DD-NPM-001 `aesdecryptor@1.0.0` | M05 | `bin/parser.js:1`은 151,725바이트 단일 행이고 GuardDog snippet은 Telegram token과 API 문자열만 일부 보존한다. | 메신저 hit/위치는 확인되지만 수집 데이터와 전송 호출은 snippet 밖이라 추가 코드가 필요하다. |
| DD-NPM-003 `@ton-wallet/create@14.0.3` | M05 | `dist/index.js:122-127`에서 Telegram bot 생성 뒤 `process.env.MNEMONIC`을 `sendMessage` 인자로 전달한다. | Raw Finding snippet은 token 중심이라 필터가 이 인접 호출 연결을 구조화해 받지 못한다. 소형 후보로 가장 명확하다. |
| DD-NPM-010 `@cloudplatform-single-spa/installations@99.99.99` | M04 + relation | `scripts/postinstall.js:15-18`의 env 설정과 `40-60`의 POST 함수, `65+` lifecycle 본문이 남는다. `SECRET`은 header에 사용되고 별도 `process.env` 전체 전송도 뒤에 존재한다. | 전체 파일 대조로는 흐름을 볼 수 있으나 두 GuardDog Finding snippet은 import/env 선언만 보여 현재 filter 입력만으로 정상 인증과 유출을 구분할 수 없다. |
| DD-NPM-014 `discord-bot-server@0.1.2` | M02/M06 | `bun_environment.js`는 10,157,586바이트 단일 행이다. destruction hit은 protobuf/API 문자열 덩어리, download/exec hit은 서로 다른 번들 기능도 포함한다. | SAME_FILE만 확인된다. 중요 경로 삭제나 동일 다운로드 결과 실행을 입증할 수 없어 우선 확정 후보로 부적합하다. |
| DD-NPM-015 `@teale.io/eslint-config@1.8.15` | M03/M04/M06 + derived | `index.js:8-45`는 npm token 수집, `52-84`는 복원 가능한 payload 및 실행 경로다. `scripts/deploy.js:49-81`은 token으로 registry API와 publish를 수행한다. | 코드 맥락은 풍부하지만 M03/M04 전송과 M06 payload scope가 서로 다른 파일/행위다. 복원 limitation/lineMapping 때문에 M03/M04/M06 VALID도 일부 막힌다. |

수동 대조 결과를 생산 StaticFilterResult에 반영하지 않았다. 특히 DD-NPM-003은
다음 연결 검증의 좋은 최소 fixture지만, 표본 라벨이나 인접 행만으로 자동 확정할
수는 없다.

## 다음 최소 구현 우선순위

1. **M05의 작은 직접 호출 사례부터**: DD-NPM-003처럼 수집 표현식이 실제
   `sendMessage` 인자로 전달되는지 AST/data-flow로 검증하고, source/sink 위치와
   limitation을 가진 verified assertion을 정의한다.
2. **M04를 두 단계로 분리**: DD-NPM-010에서 credential/full-env collection과
   request body/header 전달을 각각 검증한 뒤 외부 대상/정상 인증 맥락을 보존한다.
3. **M06은 payload scope를 먼저 도입**: download result와 process input을 같은
   값으로 연결하고, 그 payload 내부 M 근거만 참조하도록 한다. 패키지의 무관한 M
   Finding을 재사용하지 않는다.
4. **derived relation ID 무결성 보완**: producer에서 analyzer 이름 변경 뒤에도
   참조 ID가 Snapshot Finding과 일치하도록 하되, 이 수정만으로 LINKED로 승격하지
   않는다.
5. **coverage 신호 추가**: Custom Rule의 파일 제한, 읽기 실패, 생략 경로·사유를
   관측값으로 반환해야 I08을 구체적인 I07/완료 상태와 구분할 수 있다. SUCCESS나
   `selection` 수치로 역추론하지 않는다.

M02는 이 파일럿의 유일한 사례가 대형 단일행 bundle 오탐 가능성이 높아 첫 구현
후보로 권장하지 않는다. M03과 M06은 DD-NPM-015의 복원 검증 및 행위 scope 문제를
먼저 해결해야 한다.

## 한계

- 15개는 악성 의도 중심 개발 표본이며 정상 대조군이 없다. 정확도, 오탐률,
  정상성 또는 안전한 LLM 생략을 말할 수 없다.
- 실행 host Node가 프로젝트 요구 Node 24가 아니라 v26.4.0이다. 분석기는 고정
  컨테이너 버전을 사용했지만 Tier 2/Normalizer/Adapter/filter host 로직에는 이
  차이가 남는다.
- 수동 코드 대조는 최대 5개 후보에만 수행했다.
- I08은 현재 계약상 전 표본에 적용되므로 coverage 완료/부족을 실측하지 못했다.
- 관계 후보 부재는 실제 연결 부재를 의미하지 않으며, 참조 무결성도 semantic
  linkage를 의미하지 않는다.
